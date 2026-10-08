import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import type { TargetRow } from "./LiveActivities.ts";

describe("APNs disabled", () => {
  it.effect("does not enqueue agent activity deliveries", () =>
    Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {} as TargetRow,
        aggregate: null,
        nowMs: 0,
      });

      expect(result).toBeNull();
    }).pipe(Effect.provide(ApnsDeliveries.layerDisabled)),
  );
});
