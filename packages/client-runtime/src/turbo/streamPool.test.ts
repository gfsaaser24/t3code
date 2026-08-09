import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { POOL_WINDOW, subscribe } from "../rpc/client.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

/**
 * The pool only inspects `kind`, so these stand in for any subscription item
 * without dragging a full thread or shell payload into the assertions.
 */
interface PoolItem {
  readonly kind: string;
  readonly id: string;
}

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeHarness = Effect.fn("TestStreamPool.makeHarness")(function* () {
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE),
    session: activeSession,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const applied = yield* Ref.make<ReadonlyArray<string>>([]);
  const subscriptions = yield* Ref.make(0);

  const clientFor = (events: Queue.Dequeue<PoolItem>): WsRpcProtocolClient =>
    ({
      [WS_METHODS.subscribeTerminalEvents]: () =>
        Stream.unwrap(
          Ref.update(subscriptions, (count) => count + 1).pipe(Effect.as(Stream.fromQueue(events))),
        ),
    }) as unknown as WsRpcProtocolClient;

  const start = subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
    Stream.runForEach((item) =>
      Ref.update(applied, (seen) => [...seen, (item as unknown as PoolItem).id]),
    ),
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.forkChild,
  );

  // The subscription has to be re-established after a session swap before the
  // next session's items can be offered; wait on the subscribe counter rather
  // than a fixed number of yields.
  const awaitSubscriptions = Effect.fn("TestStreamPool.awaitSubscriptions")(function* (
    count: number,
  ) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((yield* Ref.get(subscriptions)) >= count) {
        return;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Expected ${count} subscriptions.`));
  });

  // Same subscription, but recording the chunk boundaries the pool produces
  // rather than flattening them, so a window's shape can be asserted.
  const chunked = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
  const startChunked = subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
    Stream.chunks,
    Stream.runForEach((chunk) =>
      Ref.update(chunked, (seen) => [
        ...seen,
        chunk.map((item) => (item as unknown as PoolItem).id),
      ]),
    ),
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.forkChild,
  );

  const settle = Effect.gen(function* () {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      yield* Effect.yieldNow;
    }
  });

  return {
    activeSession,
    applied,
    awaitSubscriptions,
    chunked,
    clientFor,
    settle,
    start,
    startChunked,
  };
});

describe("per-session stream pool", () => {
  it.effect("drops pooled leftovers when the session dies", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const firstEvents = yield* Queue.unbounded<PoolItem>();
      const secondEvents = yield* Queue.unbounded<PoolItem>();

      const fiber = yield* harness.start;
      yield* SubscriptionRef.set(
        harness.activeSession,
        Option.some(session(harness.clientFor(firstEvents))),
      );
      yield* harness.awaitSubscriptions(1);

      // An event lands in the first session's pool. The virtual clock never
      // crosses the window, so it is still pooled when the session dies.
      yield* Queue.offer(firstEvents, { kind: "event", id: "stale-event" });
      yield* harness.settle;
      expect(yield* Ref.get(harness.applied)).toEqual([]);

      // The supervisor replaces the session; the reconnect opens with a fresh
      // snapshot, which is not sequence-guarded and must not be overwritten by
      // the dead session's leftovers.
      yield* SubscriptionRef.set(
        harness.activeSession,
        Option.some(session(harness.clientFor(secondEvents))),
      );
      yield* harness.awaitSubscriptions(2);
      yield* Queue.offer(secondEvents, { kind: "snapshot", id: "fresh-snapshot" });
      yield* TestClock.adjust(POOL_WINDOW);
      yield* harness.settle;

      expect(yield* Ref.get(harness.applied)).toEqual(["fresh-snapshot"]);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("releases the synchronized marker without waiting out the window", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const events = yield* Queue.unbounded<PoolItem>();

      const fiber = yield* harness.start;
      yield* SubscriptionRef.set(
        harness.activeSession,
        Option.some(session(harness.clientFor(events))),
      );
      yield* harness.awaitSubscriptions(1);

      // A plain event opens a pool window and stays put without the clock.
      yield* Queue.offer(events, { kind: "event", id: "pooled-event" });
      yield* harness.settle;
      expect(yield* Ref.get(harness.applied)).toEqual([]);

      // The marker gates the UI (approval prompts ride this stream), so it
      // releases the open window immediately, in order, with no clock advance.
      yield* Queue.offer(events, { kind: "synchronized", id: "synchronized" });
      yield* harness.settle;
      expect(yield* Ref.get(harness.applied)).toEqual(["pooled-event", "synchronized"]);

      // A marker that arrives on an empty pool is not delayed either.
      yield* Queue.offer(events, { kind: "synchronized", id: "synchronized-again" });
      yield* harness.settle;
      expect(yield* Ref.get(harness.applied)).toEqual([
        "pooled-event",
        "synchronized",
        "synchronized-again",
      ]);

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("releases one window's items as a single ordered chunk", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const events = yield* Queue.unbounded<PoolItem>();

      const fiber = yield* harness.startChunked;
      yield* SubscriptionRef.set(
        harness.activeSession,
        Option.some(session(harness.clientFor(events))),
      );
      yield* harness.awaitSubscriptions(1);

      // This is the feature, not just its safety: five items that arrive inside
      // one window reach the screen as one blip, in arrival order, instead of
      // five separate ones.
      for (const id of ["a", "b", "c", "d", "e"]) {
        yield* Queue.offer(events, { kind: "event", id });
      }
      yield* harness.settle;
      expect(yield* Ref.get(harness.chunked)).toEqual([]);

      yield* TestClock.adjust(POOL_WINDOW);
      yield* harness.settle;
      expect(yield* Ref.get(harness.chunked)).toEqual([["a", "b", "c", "d", "e"]]);

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("never drops an item at a window boundary", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const events = yield* Queue.unbounded<PoolItem>();

      const fiber = yield* harness.start;
      yield* SubscriptionRef.set(
        harness.activeSession,
        Option.some(session(harness.clientFor(events))),
      );
      yield* harness.awaitSubscriptions(1);

      // The window sleep ends the collection by interrupting a loop that is
      // taking from the pool queue. Hammer that boundary: offer bursts with a
      // varying number of scheduler hops between them, then close the window
      // immediately, so the interrupt lands at many different points relative
      // to an in-flight take. Every item must still arrive, exactly once, in
      // order.
      const expected: Array<string> = [];
      for (let round = 0; round < 40; round += 1) {
        const burst = (round % 5) + 1;
        for (let index = 0; index < burst; index += 1) {
          const id = `item-${expected.length}`;
          expected.push(id);
          yield* Queue.offer(events, { kind: "event", id });
          for (let hop = 0; hop < (round + index) % 3; hop += 1) {
            yield* Effect.yieldNow;
          }
        }
        yield* TestClock.adjust(POOL_WINDOW);
      }

      // Release whatever is still pooled after the last boundary.
      for (let drain = 0; drain < 5; drain += 1) {
        yield* TestClock.adjust(POOL_WINDOW);
        yield* harness.settle;
      }

      expect(yield* Ref.get(harness.applied)).toEqual(expected);

      yield* Fiber.interrupt(fiber);
    }),
  );
});
