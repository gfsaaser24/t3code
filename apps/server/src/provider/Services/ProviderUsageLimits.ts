/**
 * ProviderUsageLimits — the single store for account-level quota usage,
 * keyed by configured provider instance.
 *
 * Two feeds write here and neither owns the value:
 *   - turn events (`account.rate-limits.updated`), which both the Claude and
 *     Codex adapters already emit and which cost nothing;
 *   - on-demand pulls, which the refresher schedules from ambient client
 *     triggers.
 *
 * `ProviderRegistry` reads from here to decorate its snapshots, which is why
 * this service is deliberately dependency-free — it sits below the registry
 * in the layer graph and must not reach back up.
 *
 * @module ProviderUsageLimits
 */
import type { ProviderInstanceId, ProviderUsageLimits } from "@t3tools/contracts";

import type { UsageReadingMode } from "../usageLimits.ts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

export interface ProviderUsageLimitsStoreShape {
  /** Latest known reading for one instance, or `undefined` if never read. */
  readonly get: (instanceId: ProviderInstanceId) => Effect.Effect<ProviderUsageLimits | undefined>;

  /**
   * Record a reading. Older readings are dropped rather than applied, so a
   * slow pull that resolves after a turn event cannot rewind the meters.
   *
   * `mode` says how much of the picture the reading covers: `partial`
   * readings (per-bucket turn events, sparse rolling updates) update only
   * the windows they name, while `full` ones replace the set. Getting this
   * wrong blanks meters the reading simply did not mention.
   *
   * Emits on `streamChanges` only when the stored value actually changed.
   */
  readonly set: (
    instanceId: ProviderInstanceId,
    usage: ProviderUsageLimits,
    mode: UsageReadingMode,
  ) => Effect.Effect<void>;

  /**
   * Whether an upstream pull for this instance is due, and claim the slot if
   * so. Debouncing lives here rather than in each client so three clients
   * hovering a meter at once produce one upstream call.
   */
  readonly claimRefreshSlot: (instanceId: ProviderInstanceId) => Effect.Effect<boolean>;

  /** Instance ids whose stored reading just changed. */
  readonly streamChanges: Stream.Stream<ProviderInstanceId>;

  /**
   * Acquire the change subscription eagerly, for consumers that must not
   * miss a publish between "fiber scheduled" and "fiber starts running".
   * `streamChanges` defers `PubSub.subscribe` to stream start, which is a
   * dropped-event race when the consumer is forked. See the same
   * distinction on `ProviderInstanceRegistry`.
   */
  readonly subscribeChanges: Effect.Effect<
    PubSub.Subscription<ProviderInstanceId>,
    never,
    Scope.Scope
  >;
}

export class ProviderUsageLimitsStore extends Context.Service<
  ProviderUsageLimitsStore,
  ProviderUsageLimitsStoreShape
>()("t3/provider/Services/ProviderUsageLimits/ProviderUsageLimitsStore") {}

export interface ProviderUsageRefresherShape {
  /**
   * Pull a fresh reading for one instance. Debounced per instance and
   * silently a no-op when the provider does not support pulls or the pull
   * fails — callers never need to handle an error.
   */
  readonly refresh: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
}

export class ProviderUsageRefresher extends Context.Service<
  ProviderUsageRefresher,
  ProviderUsageRefresherShape
>()("t3/provider/Services/ProviderUsageLimits/ProviderUsageRefresher") {}
