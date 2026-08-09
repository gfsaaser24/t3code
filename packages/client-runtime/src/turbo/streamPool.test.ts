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
import { subscribe } from "../rpc/client.ts";
import { STREAM_POOL_WINDOW } from "./streamPoolTestClock.ts";

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

  const settle = Effect.gen(function* () {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      yield* Effect.yieldNow;
    }
  });

  return { activeSession, applied, awaitSubscriptions, clientFor, settle, start };
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
      yield* TestClock.adjust(STREAM_POOL_WINDOW);
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
});
