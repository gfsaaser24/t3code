import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

/**
 * Fork seam: batched projection bootstrap.
 *
 * Upstream replays cold-start history one event per transaction and refreshes a
 * thread's shell summary inline on every event that dirties it. T3 Turbo keeps
 * upstream's live path and its `shouldRefreshThreadShellSummary` gate, but
 * replays history in batches of `PROJECTION_BOOTSTRAP_BATCH_SIZE` (500): one
 * transaction per batch, shell-summary refreshes deferred to the end of the
 * batch and deduped per thread, one projection-state upsert per batch.
 *
 * These tests pin the two properties that make that safe and fast, so a future
 * upstream ingest cannot quietly flatten the batching back to per-event.
 */

const BATCH_SIZE = 500;
const THREAD_COUNT = 3;
const ACTIVITY_EVENT_COUNT = 1200;

const TurboTestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-projection-pipeline-turbo-test-" }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const threadIdAt = (index: number) => ThreadId.make(`thread-${index}`);

/**
 * Fixed-width ISO stamps built by hand: the fixture needs a few thousand
 * strictly increasing timestamps and the repo's Effect lint bans `Date` here.
 * The offset stays well inside one hour, so only seconds and millis move.
 */
const isoAt = (offsetMs: number) => {
  const seconds = Math.floor(offsetMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const pad = (value: number, width: number) => String(value).padStart(width, "0");
  return `2026-01-01T00:${pad(minutes, 2)}:${pad(seconds % 60, 2)}.${pad(offsetMs % 1000, 3)}Z`;
};

it.layer(TurboTestLayer)("OrchestrationProjectionPipeline (Turbo batched bootstrap)", (it) => {
  it.effect("replays history in batched transactions with deduped shell refreshes", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = isoAt(0);

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-project"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-project"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      for (let index = 0; index < THREAD_COUNT; index += 1) {
        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make(`evt-thread-${index}`),
          aggregateKind: "thread",
          aggregateId: threadIdAt(index),
          occurredAt: now,
          commandId: CommandId.make(`cmd-thread-${index}`),
          causationEventId: null,
          correlationId: CommandId.make(`cmd-thread-${index}`),
          metadata: {},
          payload: {
            threadId: threadIdAt(index),
            projectId: ProjectId.make("project-1"),
            title: `Thread ${index}`,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      // `approval.requested` is one of the kinds upstream's gate says DOES
      // dirty the shell summary, so per-event replay would recompute the
      // summary once per event here. Batching must collapse that.
      for (let index = 0; index < ACTIVITY_EVENT_COUNT; index += 1) {
        const threadId = threadIdAt(index % THREAD_COUNT);
        const occurredAt = isoAt(index + 1);
        yield* eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.make(`evt-activity-${index}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          commandId: CommandId.make(`cmd-activity-${index}`),
          causationEventId: null,
          correlationId: CommandId.make(`cmd-activity-${index}`),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.make(`activity-${index}`),
              tone: "tool",
              kind: "approval.requested",
              summary: "Approval requested",
              payload: {},
              turnId: null,
              createdAt: occurredAt,
            },
          },
        });
      }

      const totalEvents = 1 + THREAD_COUNT + ACTIVITY_EVENT_COUNT;
      const expectedBatches = Math.ceil(totalEvents / BATCH_SIZE);
      assert.isAbove(expectedBatches, 1, "the fixture must span more than one batch");

      yield* sql`CREATE TABLE turbo_probe (label TEXT NOT NULL)`;
      yield* sql`
        CREATE TRIGGER turbo_count_threads_state_commits
        AFTER INSERT ON projection_state
        WHEN NEW.projector = 'projection.threads'
        BEGIN
          INSERT INTO turbo_probe (label) VALUES ('state');
        END;
      `;
      yield* sql`
        CREATE TRIGGER turbo_count_threads_state_updates
        AFTER UPDATE ON projection_state
        WHEN NEW.projector = 'projection.threads'
        BEGIN
          INSERT INTO turbo_probe (label) VALUES ('state');
        END;
      `;
      yield* sql`
        CREATE TRIGGER turbo_count_thread_row_writes
        AFTER UPDATE ON projection_threads
        BEGIN
          INSERT INTO turbo_probe (label) VALUES ('thread');
        END;
      `;

      yield* projectionPipeline.bootstrap;

      const countProbe = (label: string) =>
        sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS "count" FROM turbo_probe WHERE label = ${label}`.pipe(
          Effect.map((rows) => rows[0]?.count ?? 0),
        );

      // One projection-state write per batch, not one per event.
      const stateWrites = yield* countProbe("state");
      assert.strictEqual(
        stateWrites,
        expectedBatches,
        "the threads projector should commit once per batch",
      );

      // Each activity event still stamps `updatedAt` on its thread row. On top
      // of that, batching allows at most one deferred shell refresh per thread
      // per batch; per-event replay would add one per event.
      const threadRowWrites = yield* countProbe("thread");
      assert.isAtLeast(threadRowWrites, ACTIVITY_EVENT_COUNT);
      assert.isAtMost(
        threadRowWrites,
        ACTIVITY_EVENT_COUNT + expectedBatches * THREAD_COUNT,
        "shell summaries must refresh at most once per thread per batch",
      );

      yield* sql`DELETE FROM turbo_probe`;

      // The live path is untouched: a single projected event refreshes the
      // shell summary immediately, inside the same call.
      const liveOccurredAt = isoAt(ACTIVITY_EVENT_COUNT + 10);
      const liveThreadId = threadIdAt(0);
      const liveEvent = yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-live-user-message"),
        aggregateKind: "thread",
        aggregateId: liveThreadId,
        occurredAt: liveOccurredAt,
        commandId: CommandId.make("cmd-live-user-message"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-live-user-message"),
        metadata: {},
        payload: {
          threadId: liveThreadId,
          messageId: MessageId.make("message-live"),
          role: "user",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: liveOccurredAt,
          updatedAt: liveOccurredAt,
        },
      });
      yield* projectionPipeline.projectEvent(liveEvent);

      // `updatedAt` stamp + the immediate shell refresh.
      assert.strictEqual(yield* countProbe("thread"), 2);
      const latestUserMessageAt = yield* sql<{
        readonly latestUserMessageAt: string | null;
      }>`
        SELECT latest_user_message_at AS "latestUserMessageAt"
        FROM projection_threads
        WHERE thread_id = ${liveThreadId}
      `.pipe(Effect.map((rows) => rows[0]?.latestUserMessageAt ?? null));
      assert.strictEqual(
        latestUserMessageAt,
        liveOccurredAt,
        "the live path must refresh the shell summary without waiting for a batch",
      );

      yield* sql`DROP TRIGGER turbo_count_thread_row_writes`;
      yield* sql`DROP TRIGGER turbo_count_threads_state_updates`;
      yield* sql`DROP TRIGGER turbo_count_threads_state_commits`;
      yield* sql`DROP TABLE turbo_probe`;
    }),
  );
});
