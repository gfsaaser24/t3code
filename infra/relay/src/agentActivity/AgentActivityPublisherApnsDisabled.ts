import type { RelayPublishResponse } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AgentActivityRows from "./AgentActivityRows.ts";
import { AgentActivityPublisher } from "./AgentActivityPublisher.ts";

// APNs-off variant of the publisher. Selected by `worker.ts` under exactly the
// condition that already selects `ApnsDeliveries.layerDisabled`, so when APNs is
// configured nothing here is ever constructed and the upstream publisher runs
// unchanged.
//
// With the disabled delivery layer every `sendForTarget` /
// `sendPushNotificationForTarget` call resolves to `null`, so the work upstream
// does between the row write and that call — listing the environment's delivery
// users, then per user listing their active rows and Live Activity targets, then
// building aggregates — is queried, computed and thrown away. Every consumer
// already sees the empty delivery list this produces.
//
// The row write is kept verbatim (the mobile status view in
// `MobileRegistrations.getAgentActivitySnapshot` reads exactly those rows), as
// are the span names and annotations, so traces stay comparable across the two
// wirings.
export const make = Effect.gen(function* () {
  const rows = yield* AgentActivityRows.AgentActivityRows;

  return AgentActivityPublisher.of({
    replayForLiveActivityRegistration: Effect.fn(
      "relay.agent_activity_publisher.replay_for_live_activity_registration",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.deviceId,
        "relay.operation": "replayForLiveActivityRegistration",
      });
      // Upstream reads the user's rows and targets only to hand them to
      // `sendForTarget`, which is a no-op here; the caller ignores the result
      // either way.
      return null;
    }),
    publish: Effect.fn("relay.agent_activity_publisher.publish")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.thread_id": input.threadId,
        "relay.agent_activity.phase": input.state?.phase ?? "deleted",
      });
      if (input.state) {
        // Terminal states are persisted too (pruned by the cron after they
        // age out) so a thread that finishes while other agents are active
        // stays visible as Done/Failed in subsequent aggregates instead of
        // silently vanishing from the Live Activity.
        yield* rows.upsert({
          environmentPublicKey: input.environmentPublicKey,
          state: input.state,
        });
      } else {
        yield* rows.remove({
          environmentId: input.environmentId,
          environmentPublicKey: input.environmentPublicKey,
          threadId: input.threadId,
        });
      }

      return { ok: true, deliveries: [] } satisfies RelayPublishResponse;
    }),
  });
});

export const layer = Layer.effect(AgentActivityPublisher, make);
