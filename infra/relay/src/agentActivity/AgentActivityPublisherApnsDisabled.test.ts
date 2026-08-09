import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as AgentActivityPublisher from "./AgentActivityPublisher.ts";
import * as AgentActivityPublisherApnsDisabled from "./AgentActivityPublisherApnsDisabled.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";

const state: RelayAgentActivityState = {
  environmentId: "env" as RelayAgentActivityState["environmentId"],
  threadId: "thread" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};

interface RecordedCall {
  readonly method: string;
  readonly input: unknown;
}

// One recording stub set, shared by the upstream publisher and the APNs-off
// publisher, so each assertion compares what the two wirings actually ask the
// database for and what they actually write.
function recordingLayers(calls: Array<RecordedCall>) {
  const rows: AgentActivityRows.AgentActivityRows["Service"] = {
    upsert: (input) =>
      Effect.sync(() => {
        calls.push({ method: "rows.upsert", input });
      }),
    remove: (input) =>
      Effect.sync(() => {
        calls.push({ method: "rows.remove", input });
      }),
    pruneTerminal: () => Effect.void,
    listForUser: (input) =>
      Effect.sync(() => {
        calls.push({ method: "rows.listForUser", input });
        return [state];
      }),
    getForUserThread: () => Effect.succeed(state),
  };
  const links: EnvironmentLinks.EnvironmentLinks["Service"] = {
    upsert: () => Effect.void,
    listUsersForEnvironment: () => Effect.succeed(["dev:julius"]),
    listDeliveryUsersForEnvironment: (input) =>
      Effect.sync(() => {
        calls.push({ method: "links.listDeliveryUsersForEnvironment", input });
        return [{ userId: "dev:julius", notificationsEnabled: true, liveActivitiesEnabled: true }];
      }),
    listPublicKeysForEnvironment: () => Effect.succeed([]),
    listForUser: () => Effect.succeed([]),
    getForUser: () => Effect.succeed(null),
    revokeForUser: () => Effect.succeed(false),
  };
  const liveActivities: LiveActivities.LiveActivities["Service"] = {
    register: () => Effect.void,
    listTargets: (input) =>
      Effect.sync(() => {
        calls.push({ method: "liveActivities.listTargets", input });
        return [];
      }),
    markDelivery: () => Effect.void,
    markStartQueued: () => Effect.void,
    clearStartQueued: () => Effect.void,
    invalidateDeliveryToken: () => Effect.void,
  };
  return Layer.mergeAll(
    Layer.succeed(AgentActivityRows.AgentActivityRows, rows),
    Layer.succeed(EnvironmentLinks.EnvironmentLinks, links),
    Layer.succeed(LiveActivities.LiveActivities, liveActivities),
    // The exact layer worker.ts installs when APNs is off.
    ApnsDeliveries.layerDisabled,
  );
}

type PublisherLayer = Layer.Layer<
  AgentActivityPublisher.AgentActivityPublisher,
  never,
  | AgentActivityRows.AgentActivityRows
  | EnvironmentLinks.EnvironmentLinks
  | LiveActivities.LiveActivities
  | ApnsDeliveries.ApnsDeliveries
>;

const publishWith = (
  publisherLayer: PublisherLayer,
  publishState: RelayAgentActivityState | null,
  calls: Array<RecordedCall>,
) =>
  AgentActivityPublisher.AgentActivityPublisher.pipe(
    Effect.flatMap((publisher) =>
      publisher.publish({
        environmentId: "env",
        environmentPublicKey: "public-key",
        threadId: "thread",
        state: publishState,
      }),
    ),
    Effect.provide(publisherLayer.pipe(Layer.provide(recordingLayers(calls)))),
  );

const rowWrites = (calls: ReadonlyArray<RecordedCall>) =>
  calls.filter((call) => call.method === "rows.upsert" || call.method === "rows.remove");

const reads = (calls: ReadonlyArray<RecordedCall>) =>
  calls.filter((call) => !call.method.startsWith("rows.upsert")).map((call) => call.method);

describe("AgentActivityPublisher with APNs disabled", () => {
  it.effect("stores the same row as the upstream publisher and returns the same response", () =>
    Effect.gen(function* () {
      const upstreamCalls: Array<RecordedCall> = [];
      const disabledCalls: Array<RecordedCall> = [];

      const upstreamResponse = yield* publishWith(
        AgentActivityPublisher.layer,
        state,
        upstreamCalls,
      );
      const disabledResponse = yield* publishWith(
        AgentActivityPublisherApnsDisabled.layer,
        state,
        disabledCalls,
      );

      expect(rowWrites(disabledCalls)).toEqual(rowWrites(upstreamCalls));
      expect(rowWrites(disabledCalls)).toEqual([
        { method: "rows.upsert", input: { environmentPublicKey: "public-key", state } },
      ]);
      expect(disabledResponse).toEqual(upstreamResponse);
      expect(disabledResponse).toEqual({ ok: true, deliveries: [] });
    }),
  );

  it.effect("deletes the same row as the upstream publisher", () =>
    Effect.gen(function* () {
      const upstreamCalls: Array<RecordedCall> = [];
      const disabledCalls: Array<RecordedCall> = [];

      const upstreamResponse = yield* publishWith(
        AgentActivityPublisher.layer,
        null,
        upstreamCalls,
      );
      const disabledResponse = yield* publishWith(
        AgentActivityPublisherApnsDisabled.layer,
        null,
        disabledCalls,
      );

      expect(rowWrites(disabledCalls)).toEqual(rowWrites(upstreamCalls));
      expect(rowWrites(disabledCalls)).toEqual([
        {
          method: "rows.remove",
          input: { environmentId: "env", environmentPublicKey: "public-key", threadId: "thread" },
        },
      ]);
      expect(disabledResponse).toEqual(upstreamResponse);
      expect(disabledResponse).toEqual({ ok: true, deliveries: [] });
    }),
  );

  it.effect("skips the delivery prep the disabled delivery layer throws away", () =>
    Effect.gen(function* () {
      const upstreamCalls: Array<RecordedCall> = [];
      const disabledCalls: Array<RecordedCall> = [];

      yield* publishWith(AgentActivityPublisher.layer, state, upstreamCalls);
      yield* publishWith(AgentActivityPublisherApnsDisabled.layer, state, disabledCalls);

      expect(reads(upstreamCalls)).toEqual([
        "links.listDeliveryUsersForEnvironment",
        "rows.listForUser",
        "liveActivities.listTargets",
      ]);
      expect(reads(disabledCalls)).toEqual([]);
    }),
  );

  it.effect("replays nothing when a Live Activity token registers", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedCall> = [];
      const result = yield* AgentActivityPublisher.AgentActivityPublisher.pipe(
        Effect.flatMap((publisher) =>
          publisher.replayForLiveActivityRegistration({
            userId: "dev:julius",
            deviceId: "device-1",
          }),
        ),
        Effect.provide(
          AgentActivityPublisherApnsDisabled.layer.pipe(Layer.provide(recordingLayers(calls))),
        ),
      );

      // Upstream's replay reads rows and targets only to feed sendForTarget,
      // which is a no-op with APNs off; the caller ignores the result either way.
      expect(result).toBeNull();
      expect(calls).toEqual([]);
    }),
  );
});
