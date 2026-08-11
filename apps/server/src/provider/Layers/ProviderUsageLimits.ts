/**
 * ProviderUsageLimitsStoreLive — in-memory store for account quota usage.
 *
 * Readings are volatile by design. They are never persisted: a usage number
 * is only interesting while it is roughly current, and the two feeds that
 * write here repopulate it within one turn or one refresh of a restart.
 *
 * @module ProviderUsageLimitsStoreLive
 */
import type { ProviderInstanceId, ProviderUsageLimits } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  ProviderUsageLimitsStore,
  type ProviderUsageLimitsStoreShape,
} from "../Services/ProviderUsageLimits.ts";
import { applyUsageReading, type UsageReadingMode } from "../usageLimits.ts";

/**
 * How long a pull is suppressed after the previous one for the same
 * instance. Ambient triggers (window focus, thread switch, meter hover) fire
 * far more often than the numbers move, and the free turn-event feed covers
 * the gaps.
 */
export const USAGE_REFRESH_DEBOUNCE_MS = 60_000;

export const ProviderUsageLimitsStoreLive = Layer.effect(
  ProviderUsageLimitsStore,
  Effect.gen(function* () {
    const usageRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ProviderUsageLimits>>(
      new Map(),
    );
    const lastRefreshAtRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, number>>(new Map());
    const changes = yield* Effect.acquireRelease(
      PubSub.unbounded<ProviderInstanceId>(),
      PubSub.shutdown,
    );

    const set = (
      instanceId: ProviderInstanceId,
      usage: ProviderUsageLimits,
      mode: UsageReadingMode,
    ) =>
      Effect.gen(function* () {
        const didWindowsChange = yield* Ref.modify(usageRef, (previous) => {
          const existing = previous.get(instanceId);
          const merged = applyUsageReading(existing, usage, mode);
          if (existing !== undefined && Equal.equals(existing, merged)) {
            return [false, previous] as const;
          }
          const next = new Map(previous);
          next.set(instanceId, merged);
          // Announce only when the numbers moved, not when the stamp did.
          // `updatedAt` is generated server-side on every reading, so a
          // provider re-reporting identical usage would otherwise wake the
          // registry and push the entire provider array — every model,
          // capability, and skill — to every connected client, once per
          // turn, for no visible change.
          return [
            existing === undefined || !Equal.equals(existing.windows, merged.windows),
            next,
          ] as const;
        });
        if (didWindowsChange) {
          yield* PubSub.publish(changes, instanceId);
        }
      });

    const claimRefreshSlot = (instanceId: ProviderInstanceId) =>
      Effect.clockWith((clock) =>
        clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Ref.modify(lastRefreshAtRef, (previous) => {
              const lastRefreshAt = previous.get(instanceId);
              const elapsed = lastRefreshAt === undefined ? undefined : now - lastRefreshAt;
              // A negative elapsed means the wall clock moved backwards — an
              // NTP correction, a laptop waking in another timezone. Treating
              // that as "still inside the window" would wedge the meters until
              // the clock caught back up, which can be hours.
              if (elapsed !== undefined && elapsed >= 0 && elapsed < USAGE_REFRESH_DEBOUNCE_MS) {
                return [false, previous] as const;
              }
              const next = new Map(previous);
              next.set(instanceId, now);
              return [true, next] as const;
            }),
          ),
        ),
      );

    const clear = (instanceId: ProviderInstanceId) =>
      Effect.gen(function* () {
        yield* Ref.update(lastRefreshAtRef, (previous) => {
          if (!previous.has(instanceId)) {
            return previous;
          }
          const next = new Map(previous);
          next.delete(instanceId);
          return next;
        });
        const hadReading = yield* Ref.modify(usageRef, (previous) => {
          if (!previous.has(instanceId)) {
            return [false, previous] as const;
          }
          const next = new Map(previous);
          next.delete(instanceId);
          return [true, next] as const;
        });
        if (hadReading) {
          yield* PubSub.publish(changes, instanceId);
        }
      });

    return {
      get: (instanceId) => Ref.get(usageRef).pipe(Effect.map((usage) => usage.get(instanceId))),
      set,
      clear,
      claimRefreshSlot,
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      subscribeChanges: PubSub.subscribe(changes),
    } satisfies ProviderUsageLimitsStoreShape;
  }),
);
