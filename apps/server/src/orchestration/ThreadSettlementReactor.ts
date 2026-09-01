import { CommandId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  isAutoSettlementCandidate,
  shouldAutoSettleThread,
  type SettlementPullRequest,
} from "./ThreadSettlementPolicy.ts";

/**
 * Ceiling on how many settlement groups are resolved at once. Each group costs
 * a `gh pr list` subprocess, so the old fan-out of 8 put eight GitHub CLI
 * processes on the CPU during boot, competing with connection setup.
 */
const SETTLEMENT_SWEEP_CONCURRENCY = 2;
/**
 * Floor between two automatic sweeps. Auto-settlement is a day-scale decision;
 * the periodic tick used to re-walk every unsettled thread once a minute.
 */
const SETTLEMENT_SWEEP_MIN_INTERVAL = Duration.minutes(10);
/**
 * How long automatic sweeps stay quiet after the reactor is built, so the
 * first `gh pr list` storm does not land inside the client's connection-setup
 * budget. A settings change still sweeps immediately.
 */
const SETTLEMENT_SWEEP_BOOT_DELAY = Duration.minutes(5);

/**
 * Why a sweep was queued. Only `"periodic"` is throttled - a settings change is
 * a user action and must take effect straight away.
 */
type SweepTrigger = "periodic" | "settings-changed";

export class ThreadSettlementReactor extends Context.Service<
  ThreadSettlementReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadSettlementReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  const builtAtNanos = yield* Clock.currentTimeNanos;
  const lastSweepAtNanos = yield* Ref.make<bigint | null>(null);

  /**
   * True when an automatic sweep is allowed to run now: past the boot delay,
   * and at least {@link SETTLEMENT_SWEEP_MIN_INTERVAL} since the last one.
   * Records the run time as a side effect so the caller cannot forget to.
   */
  const claimAutomaticSweep = Effect.fn("ThreadSettlementReactor.claimAutomaticSweep")(
    function* () {
      const nowNanos = yield* Clock.currentTimeNanos;
      const lastNanos = yield* Ref.get(lastSweepAtNanos);
      const earliestNanos =
        lastNanos === null
          ? builtAtNanos + BigInt(Duration.toMillis(SETTLEMENT_SWEEP_BOOT_DELAY)) * 1_000_000n
          : lastNanos + BigInt(Duration.toMillis(SETTLEMENT_SWEEP_MIN_INTERVAL)) * 1_000_000n;
      if (nowNanos < earliestNanos) return false;
      yield* Ref.set(lastSweepAtNanos, nowNanos);
      return true;
    },
  );

  const sweep = Effect.fn("ThreadSettlementReactor.sweep")(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = DateTime.formatIso(yield* DateTime.now);
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    const candidates = snapshot.threads.filter((thread) => isAutoSettlementCandidate(thread, now));
    const lookupKey = (thread: (typeof candidates)[number]) => {
      if (thread.linkedPullRequest != null) {
        return JSON.stringify([
          "linked",
          thread.linkedPullRequest.projectId,
          thread.linkedPullRequest.repository,
          thread.linkedPullRequest.number,
        ]);
      }
      if (thread.branch === null) return JSON.stringify(["none", thread.id]);
      const project = projects.get(thread.projectId);
      return JSON.stringify(
        project === undefined
          ? ["missing-project", thread.id]
          : ["branch", project.workspaceRoot, thread.branch],
      );
    };
    const groups = Map.groupBy(candidates, lookupKey);

    const pullRequestFor = Effect.fn("ThreadSettlementReactor.pullRequestFor")(function* (
      thread: (typeof candidates)[number],
    ) {
      if (thread.linkedPullRequest != null) {
        if (!projects.has(thread.linkedPullRequest.projectId)) {
          return yield* Effect.die(new Error("linked pull request project not found"));
        }
        const detail = yield* pullRequests.detail({
          projectId: thread.linkedPullRequest.projectId,
          repository: thread.linkedPullRequest.repository,
          number: thread.linkedPullRequest.number,
        });
        return { state: detail.state, updatedAt: detail.updatedAt } satisfies SettlementPullRequest;
      }
      if (thread.branch === null) return null;
      const project = projects.get(thread.projectId);
      if (project === undefined) {
        return yield* Effect.die(new Error("thread project not found"));
      }
      return yield* git.branchPullRequest({ cwd: project.workspaceRoot, branch: thread.branch });
    });

    yield* Effect.forEach(
      groups.values(),
      (group) =>
        Effect.gen(function* () {
          const pullRequest = yield* pullRequestFor(group[0]!);
          yield* Effect.forEach(
            group,
            (thread) =>
              Effect.gen(function* () {
                const settings = yield* settingsService.getSettings;
                const decisionNow = DateTime.formatIso(yield* DateTime.now);
                if (
                  !shouldAutoSettleThread({
                    thread,
                    pullRequest,
                    now: decisionNow,
                    autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
                    autoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
                  })
                ) {
                  return;
                }
                const uuid = yield* crypto.randomUUIDv4;
                yield* engine.dispatch({
                  type: "thread.auto-settle",
                  commandId: CommandId.make(`server:auto-settle:${thread.id}:${uuid}`),
                  threadId: thread.id,
                  snapshotSequence: snapshot.snapshotSequence,
                });
              }).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("automatic thread settlement skipped", {
                        threadId: thread.id,
                        cause: Cause.pretty(cause),
                      }),
                ),
              ),
            { discard: true },
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread settlement skipped", {
                  threadIds: group.map((thread) => thread.id),
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: SETTLEMENT_SWEEP_CONCURRENCY, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker((trigger: SweepTrigger) =>
    Effect.gen(function* () {
      if (trigger === "periodic" && !(yield* claimAutomaticSweep())) {
        return;
      }
      yield* sweep();
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread settlement sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const start: ThreadSettlementReactor["Service"]["start"] = Effect.fn(
    "ThreadSettlementReactor.start",
  )(function* () {
    const settingsChanges = yield* settingsService.subscribeChanges;
    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let lastAfterDays = initialSettings.sidebarAutoSettleAfterDays;
    let lastOnMerge = initialSettings.sidebarAutoSettleOnMerge;
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue("periodic");
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        if (
          settings.sidebarAutoSettleAfterDays === lastAfterDays &&
          settings.sidebarAutoSettleOnMerge === lastOnMerge
        ) {
          return Effect.void;
        }
        lastAfterDays = settings.sidebarAutoSettleAfterDays;
        lastOnMerge = settings.sidebarAutoSettleOnMerge;
        return worker.enqueue("settings-changed");
      }),
    );
  });

  return { start, drain: worker.drain } satisfies ThreadSettlementReactor["Service"];
});

export const layer = Layer.effect(ThreadSettlementReactor, make);
