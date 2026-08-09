import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

/**
 * The subscription pool window used by `rpc/client.ts`. Subscription items that
 * arrive inside one window are released together, so under a virtual clock
 * nothing reaches the screen until the window is crossed.
 */
export const STREAM_POOL_WINDOW = "16 millis";

/** Enough windows to release any realistic test burst before giving up. */
const MAX_POOL_WINDOWS = 100;

/**
 * Runs `effect` while stepping the virtual clock one pool window at a time, so
 * pooled subscription items are released deterministically instead of waiting
 * on a timer the test never advances.
 *
 * Stepping stops the moment `effect` finishes, so virtual time only moves as
 * far as the pooled items actually needed — a test that asserts on a longer
 * timer (retry backoff, persistence debounce) keeps its own timing.
 */
export const awaitPooled = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    for (let window = 0; window < MAX_POOL_WINDOWS; window += 1) {
      if (fiber.pollUnsafe() !== undefined) {
        break;
      }
      yield* TestClock.adjust(STREAM_POOL_WINDOW);
    }
    return yield* Fiber.join(fiber);
  });
