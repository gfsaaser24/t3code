import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { POOL_WINDOW } from "../rpc/client.ts";

/**
 * Enough windows to release any realistic test burst, and deliberately far
 * short of the shortest timer these suites assert on (the 250 ms subscription
 * retry backoff). A wait that needs more than this is not waiting on the pool,
 * so stepping further would only corrupt the surrounding timing assertions
 * before the test failed anyway.
 */
const MAX_POOL_WINDOWS = 12;

const windowMillis = Duration.toMillis(Duration.fromInputUnsafe(POOL_WINDOW));

/**
 * Runs `effect` while stepping the virtual clock one pool window at a time, so
 * pooled subscription items are released deterministically instead of waiting
 * on a timer the test never advances.
 *
 * Stepping stops the moment `effect` finishes, so virtual time only moves as
 * far as the pooled items actually needed — a test that asserts on a longer
 * timer (retry backoff, persistence debounce) keeps its own timing.
 *
 * If the wait never settles, this dies with a diagnostic instead of hanging in
 * `Fiber.join` until the runner's timeout kills it with no explanation.
 */
export const awaitPooled = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    for (let window = 0; window < MAX_POOL_WINDOWS; window += 1) {
      if (fiber.pollUnsafe() !== undefined) {
        return yield* Fiber.join(fiber);
      }
      yield* TestClock.adjust(POOL_WINDOW);
    }
    if (fiber.pollUnsafe() === undefined) {
      yield* Fiber.interrupt(fiber);
      return yield* Effect.die(
        new Error(
          `awaitPooled: the awaited effect did not settle within ${MAX_POOL_WINDOWS} pool ` +
            `windows (${MAX_POOL_WINDOWS * windowMillis} ms of virtual time). Whatever it is ` +
            `waiting for is not being held by the subscription pool.`,
        ),
      );
    }
    return yield* Fiber.join(fiber);
  });
