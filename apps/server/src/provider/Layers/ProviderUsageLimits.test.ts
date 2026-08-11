import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderUsageLimits } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";

import { ProviderUsageLimitsStore } from "../Services/ProviderUsageLimits.ts";
import { ProviderUsageLimitsStoreLive, USAGE_REFRESH_DEBOUNCE_MS } from "./ProviderUsageLimits.ts";

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CODEX = ProviderInstanceId.make("codex");

const usageAt = (updatedAt: string, usedPercent: number): ProviderUsageLimits => ({
  windows: [{ id: "session", label: "Session", usedPercent, resetsAt: null }],
  updatedAt,
});

describe("ProviderUsageLimitsStoreLive", () => {
  it.effect("collapses concurrent refresh claims into one", () =>
    Effect.gen(function* () {
      const store = yield* ProviderUsageLimitsStore;

      const claims = yield* Effect.all(
        [
          store.claimRefreshSlot(CLAUDE),
          store.claimRefreshSlot(CLAUDE),
          store.claimRefreshSlot(CLAUDE),
        ],
        { concurrency: "unbounded" },
      );

      assert.deepStrictEqual(
        claims.filter(Boolean).length,
        1,
        "three simultaneous callers should produce exactly one upstream call",
      );
    }).pipe(Effect.provide(ProviderUsageLimitsStoreLive)),
  );

  it.effect("debounces per instance, not globally", () =>
    Effect.gen(function* () {
      const store = yield* ProviderUsageLimitsStore;

      assert.isTrue(yield* store.claimRefreshSlot(CLAUDE));
      assert.isTrue(
        yield* store.claimRefreshSlot(CODEX),
        "a different instance must not be blocked by another instance's claim",
      );
      assert.isFalse(yield* store.claimRefreshSlot(CLAUDE));
    }).pipe(Effect.provide(ProviderUsageLimitsStoreLive)),
  );

  it.effect("allows a new claim once the debounce window elapses", () =>
    Effect.gen(function* () {
      const store = yield* ProviderUsageLimitsStore;

      assert.isTrue(yield* store.claimRefreshSlot(CLAUDE));
      yield* TestClock.adjust(USAGE_REFRESH_DEBOUNCE_MS - 1);
      assert.isFalse(yield* store.claimRefreshSlot(CLAUDE));
      yield* TestClock.adjust(1);
      assert.isTrue(yield* store.claimRefreshSlot(CLAUDE));
    }).pipe(Effect.provide(ProviderUsageLimitsStoreLive)),
  );

  it.effect("does not wedge the debounce when the wall clock jumps backwards", () =>
    Effect.gen(function* () {
      // An NTP correction or a wake in another timezone can move
      // `currentTimeMillis` backwards. A plain `now - lastRefreshAt` reads
      // negative, which would look like "still inside the window" and block
      // refreshes until the clock caught up.
      const store = yield* ProviderUsageLimitsStore;

      yield* TestClock.adjust(USAGE_REFRESH_DEBOUNCE_MS * 10);
      assert.isTrue(yield* store.claimRefreshSlot(CLAUDE));
      yield* TestClock.setTime(0);
      assert.isTrue(
        yield* store.claimRefreshSlot(CLAUDE),
        "a backwards clock should expire the slot, not extend it",
      );
    }).pipe(Effect.provide(ProviderUsageLimitsStoreLive)),
  );

  it.effect("keeps the newest reading when writes arrive out of order", () =>
    Effect.gen(function* () {
      const store = yield* ProviderUsageLimitsStore;

      yield* store.set(CLAUDE, usageAt("2026-08-09T12:00:00.000Z", 50), "full");
      yield* store.set(CLAUDE, usageAt("2026-08-09T11:00:00.000Z", 10), "full");

      const stored = yield* store.get(CLAUDE);
      assert.strictEqual(stored?.updatedAt, "2026-08-09T12:00:00.000Z");
      assert.strictEqual(stored?.windows[0]?.usedPercent, 50);
    }).pipe(Effect.provide(ProviderUsageLimitsStoreLive)),
  );

  it.effect("merges a partial reading instead of blanking the other windows", () =>
    Effect.gen(function* () {
      const store = yield* ProviderUsageLimitsStore;

      yield* store.set(
        CODEX,
        {
          windows: [
            { id: "codex-primary", label: "Session", usedPercent: 20, resetsAt: null },
            { id: "codex-secondary", label: "Weekly", usedPercent: 70, resetsAt: null },
          ],
          updatedAt: "2026-08-09T11:00:00.000Z",
        },
        "full",
      );
      // A sparse rolling update carrying only the primary window.
      yield* store.set(
        CODEX,
        {
          windows: [{ id: "codex-primary", label: "Session", usedPercent: 25, resetsAt: null }],
          updatedAt: "2026-08-09T12:00:00.000Z",
        },
        "partial",
      );

      const stored = yield* store.get(CODEX);
      assert.deepStrictEqual(
        stored?.windows.map((window) => [window.id, window.usedPercent]),
        [
          ["codex-primary", 25],
          ["codex-secondary", 70],
        ],
      );
    }).pipe(Effect.provide(ProviderUsageLimitsStoreLive)),
  );

  it.effect("does not announce a change when only the timestamp moved", () =>
    Effect.gen(function* () {
      // `updatedAt` is stamped server-side on every reading, so a provider
      // re-reporting identical numbers would otherwise wake the registry and
      // push the whole provider array to every client, once per turn.
      const store = yield* ProviderUsageLimitsStore;
      const changes = yield* store.subscribeChanges;

      yield* store.set(CLAUDE, usageAt("2026-08-09T11:00:00.000Z", 40), "full");
      yield* store.set(CLAUDE, usageAt("2026-08-09T12:00:00.000Z", 40), "full");
      yield* store.set(CLAUDE, usageAt("2026-08-09T13:00:00.000Z", 41), "full");

      // Returns everything buffered so far; the middle write must not appear.
      const announced = yield* PubSub.takeAll(changes);
      assert.strictEqual(
        announced.length,
        2,
        "only the two readings that moved a number should be announced",
      );
      // The fresher stamp is still stored even though it was not announced.
      assert.strictEqual((yield* store.get(CLAUDE))?.updatedAt, "2026-08-09T13:00:00.000Z");
    }).pipe(Effect.provide(ProviderUsageLimitsStoreLive), Effect.scoped),
  );

  it.effect("reports no reading for an instance that never reported one", () =>
    Effect.gen(function* () {
      const store = yield* ProviderUsageLimitsStore;
      assert.isUndefined(yield* store.get(CODEX));
    }).pipe(Effect.provide(ProviderUsageLimitsStoreLive)),
  );

  it.effect("clear drops the reading and frees the debounce slot", () =>
    Effect.gen(function* () {
      // A rebuilt instance may point at a different account; its old
      // reading must not survive, and it must be allowed to pull
      // immediately rather than inherit the old instance's debounce.
      const store = yield* ProviderUsageLimitsStore;

      yield* store.set(CLAUDE, usageAt("2026-08-09T12:00:00.000Z", 50), "full");
      assert.isTrue(yield* store.claimRefreshSlot(CLAUDE));
      yield* store.clear(CLAUDE);

      assert.isUndefined(yield* store.get(CLAUDE));
      assert.isTrue(
        yield* store.claimRefreshSlot(CLAUDE),
        "a cleared instance should be allowed to pull immediately",
      );
    }).pipe(Effect.provide(ProviderUsageLimitsStoreLive)),
  );

  it.effect("clear announces only when a reading was actually dropped", () =>
    Effect.gen(function* () {
      const store = yield* ProviderUsageLimitsStore;
      const changes = yield* store.subscribeChanges;

      // First clear finds nothing and must stay silent; the set and the
      // second clear should each announce once. A wrongly-announcing first
      // clear would surface as a third buffered element here.
      yield* store.clear(CLAUDE);
      yield* store.set(CLAUDE, usageAt("2026-08-09T12:00:00.000Z", 50), "full");
      yield* store.clear(CLAUDE);
      assert.strictEqual(
        (yield* PubSub.takeAll(changes)).length,
        2,
        "only the reading and its removal should announce",
      );
    }).pipe(Effect.provide(ProviderUsageLimitsStoreLive), Effect.scoped),
  );
});
