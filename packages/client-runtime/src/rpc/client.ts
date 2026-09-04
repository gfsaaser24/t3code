import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";

export class EnvironmentRpcUnavailableError extends Schema.TaggedErrorClass<EnvironmentRpcUnavailableError>()(
  "EnvironmentRpcUnavailableError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

export interface EnvironmentRpcRequestObservation {
  readonly environmentId: string;
  readonly method: string;
}

export class EnvironmentRpcRequestObserver extends Context.Reference<{
  readonly observe: (
    request: EnvironmentRpcRequestObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@t3tools/client-runtime/rpc/EnvironmentRpcRequestObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export type EnvironmentRpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends EnvironmentRpcTag> = WsRpcProtocolClient[TTag];

export type EnvironmentSubscriptionRpcTag =
  | typeof WS_METHODS.providerAuthSubscribe
  | typeof WS_METHODS.providerInstallSubscribe
  | typeof ORCHESTRATION_WS_METHODS.subscribeShell
  | typeof ORCHESTRATION_WS_METHODS.subscribeThread
  | typeof WS_METHODS.subscribeAuthAccess
  | typeof WS_METHODS.subscribeServerConfig
  | typeof WS_METHODS.subscribeServerLifecycle
  | typeof WS_METHODS.subscribeTerminalEvents
  | typeof WS_METHODS.subscribeTerminalMetadata
  | typeof WS_METHODS.subscribePreviewEvents
  | typeof WS_METHODS.subscribeDiscoveredLocalServers
  | typeof WS_METHODS.subscribeResourceTelemetry
  | typeof WS_METHODS.previewAutomationConnect
  | typeof WS_METHODS.subscribeVcsStatus
  | typeof WS_METHODS.terminalAttach;

export type EnvironmentStreamCommandRpcTag =
  | typeof WS_METHODS.cloudInstallRelayClient
  | typeof WS_METHODS.serverUpdateServerWithProgress
  | typeof WS_METHODS.gitRunStackedAction;

export type EnvironmentStreamRpcTag =
  | EnvironmentSubscriptionRpcTag
  | EnvironmentStreamCommandRpcTag;

export type EnvironmentUnaryRpcTag = Exclude<EnvironmentRpcTag, EnvironmentStreamRpcTag>;

export interface EnvironmentRpcSubscriptionObservation {
  readonly environmentId: string;
  readonly method: EnvironmentSubscriptionRpcTag;
  readonly input: unknown;
}

export class EnvironmentRpcSubscriptionObserver extends Context.Reference<{
  readonly observe: (
    subscription: EnvironmentRpcSubscriptionObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@t3tools/client-runtime/rpc/EnvironmentRpcSubscriptionObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

export type EnvironmentRpcInput<TTag extends EnvironmentRpcTag> = Parameters<RpcMethod<TTag>>[0];

export type EnvironmentRpcSuccess<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcFailure<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<any, infer E, any>
    ? E
    : never;

export type EnvironmentRpcStreamValue<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcStreamFailure<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<any, infer E, any>
    ? E
    : never;

const currentSession = Effect.fn("EnvironmentRpc.currentSession")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  return yield* SubscriptionRef.get(supervisor.session).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new EnvironmentRpcUnavailableError({
              environmentId: supervisor.target.environmentId,
              message: `${supervisor.target.label} is not connected.`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
});

export const request = Effect.fn("EnvironmentRpc.request")(function* <
  TTag extends EnvironmentUnaryRpcTag,
>(tag: TTag, input: EnvironmentRpcInput<TTag>) {
  const supervisor = yield* EnvironmentSupervisor;
  yield* Effect.annotateCurrentSpan({
    "environment.id": supervisor.target.environmentId,
    "rpc.method": tag,
  });
  const session = yield* currentSession();
  const observer = yield* EnvironmentRpcRequestObserver;
  const method = session.client[tag] as (
    input: EnvironmentRpcInput<TTag>,
  ) => Effect.Effect<EnvironmentRpcSuccess<TTag>, EnvironmentRpcFailure<TTag>>;
  const completeObservation = yield* observer.observe({
    environmentId: supervisor.target.environmentId,
    method: tag,
  });
  return yield* method(input).pipe(Effect.ensuring(completeObservation));
});

export function runStream<TTag extends EnvironmentStreamCommandRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag> | EnvironmentRpcUnavailableError,
  EnvironmentSupervisor
> {
  return Stream.unwrap(
    currentSession().pipe(
      Effect.map((session) => {
        const method = session.client[tag] as (
          input: EnvironmentRpcInput<TTag>,
        ) => Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>;
        return method(input);
      }),
    ),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.runStream", {
      attributes: { "rpc.method": tag },
    }),
  );
}

// T3 Turbo: pool-and-blip. One animation frame's worth of subscription items is
// pooled and released together as a single chunk, so a burst of stream items
// costs the screen one blip per frame instead of one per item. The window is
// deliberately a frame and no coarser: approval prompts ride these same
// subscriptions, and anything longer is felt on a modal that gates the agent.
export const POOL_WINDOW: Duration.Input = "16 millis";

// The pool puts a queue between the socket and the screen, so it *adds* slack
// in front of the backpressure that already exists rather than preserving it
// unchanged. Bounding that slack at 1024 items means a screen that stays behind
// still ends up throttling the socket; "unbounded" would remove the
// backpressure altogether and let a long replay grow the backlog without limit.
const POOL_CAPACITY = 1024;

// Pooling moves a chunk boundary and nothing else. That is invisible to a consumer that applies
// every item in order (`Stream.runForEach`, which is what the store does), and it is DATA LOSS for
// one that collapses a chunk to a single value -- which is exactly what effect-atom's
// `Atom.makeStream` does: it sets one atom value per pulled chunk, from the chunk's last item.
//
// Most subscriptions are cumulative, so collapsing is correct for them: every item carries the
// whole current state (terminal attach, vcs status, welcome, auth, and the thread/shell streams,
// which the store applies item by item anyway). These two are not. Their items are distinct facts:
// an `opened(tabA)` and a `navigated(tabB)` inside one window would lose tabA entirely, and a
// dropped automation request never receives its keyed response, so the automation hangs forever.
//
// The exemption is keyed on the TAG rather than supplied at the call site because it is a property
// of what the payload MEANS, not of who subscribes. A future subscriber of these streams -- or a
// second atom family over the same tag -- cannot forget to opt out.
const NON_CUMULATIVE_SUBSCRIPTION_TAGS: ReadonlySet<EnvironmentSubscriptionRpcTag> = new Set([
  WS_METHODS.subscribePreviewEvents,
  WS_METHODS.previewAutomationConnect,
  // Server config is a durable, session-owned stream with its own replay and
  // projection. It is low volume, and pooling it would both delay config by a
  // frame and put a queue between the session and its own durable state.
  WS_METHODS.subscribeServerConfig,
]);

// The connection "synchronized" marker is what flips a subscription to "live",
// so it is released the moment it arrives rather than waiting out the window.
//
// This is a duck-type on a contracts literal: the marker is `{ kind: "synchronized" }` in
// `OrchestrationThreadStreamItem` and `OrchestrationShellStreamItem`. A rename there would silently
// turn the bypass off and put a 16 ms delay in front of every approval prompt, so
// `turbo/streamPool.test.ts` pins the literal against the schemas rather than against a string.
export const flushesImmediately = (item: unknown): boolean =>
  typeof item === "object" &&
  item !== null &&
  "kind" in item &&
  (item as { readonly kind: unknown }).kind === "synchronized";

/**
 * Pools items that arrive within one frame and emits them as one chunk.
 *
 * Every pooled item is still applied individually and in order downstream; only
 * the chunk boundary moves, which is what the per-item lock invariants rely on.
 *
 * This must stay scoped to a single session's subscription. The queue is
 * created and shut down with the stream, so when the supervisor swaps sessions
 * the dead session's pooled leftovers are discarded instead of flushing on top
 * of the new session's fresh snapshot (snapshot items are not sequence-guarded).
 */
function poolWithinFrame<A, E>(stream: Stream.Stream<A, E>): Stream.Stream<A, E> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const arrivals = yield* Stream.toQueue(stream, {
        capacity: POOL_CAPACITY,
        strategy: "suspend",
      });
      const pool = Effect.gen(function* () {
        const batch: [A, ...Array<A>] = [yield* Queue.take(arrivals)];
        if (flushesImmediately(batch[0])) {
          return batch;
        }
        // Collect for the rest of the frame. A stream end or failure stops the
        // collection without losing the batch; the next pull re-reads the
        // queue and surfaces the same terminal cause.
        //
        // The window sleep ends the collection by interrupting this loop, so
        // taking an item and appending it must be one indivisible step or a
        // window boundary could drop an item (terminal output is not
        // sequence-guarded, so a drop would be silent corruption). Two things
        // make that safe, and neither is left to chance:
        //
        //   - `restore(Queue.take(...))` keeps only the *parked* take
        //     interruptible. A parked take holds nothing: `Queue.take` waits on
        //     `awaitTake`, which resumes with a payload-free `exitVoid` wake
        //     signal and re-reads the queue (effect/src/Queue.ts:1474 `take`,
        //     :2073 `awaitTake`, :1957 `releaseTakers`). An item only leaves the
        //     queue inside the synchronous `takeUnsafe` (:1606), so an
        //     interrupted park consumes nothing.
        //   - Everything after the take runs inside the uninterruptible mask,
        //     so once an item *has* left the queue the append cannot be
        //     preempted. This is what makes the property structural rather than
        //     a bet on where the fiber loop happens to observe interrupts.
        //
        // `turbo/streamPool.test.ts` hammers the window boundary and asserts
        // zero drops.
        yield* Effect.race(
          Effect.gen(function* () {
            while (true) {
              const item = yield* Effect.uninterruptibleMask((restore) =>
                Effect.flatMap(restore(Queue.take(arrivals)), (taken) =>
                  Effect.sync(() => {
                    batch.push(taken);
                    return taken;
                  }),
                ),
              );
              if (flushesImmediately(item)) {
                return;
              }
            }
          }).pipe(
            // Only the stream's own end/failure is absorbed here. An interrupt
            // is the window closing this loop on purpose and must stay an
            // interrupt.
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void,
            ),
          ),
          Effect.sleep(POOL_WINDOW),
        );
        return batch;
      });
      return Stream.fromPull(Effect.succeed(pool));
    }),
  );
}

interface SubscriptionOptions<TTag extends EnvironmentSubscriptionRpcTag> {
  readonly onExpectedFailure?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly retryExpectedFailureAfter?: Duration.Input;
  readonly resubscribe?: Stream.Stream<unknown, never, never>;
}

export function subscribeDynamic<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor;
      const observer = yield* EnvironmentRpcSubscriptionObserver;
      const sessionChanges = SubscriptionRef.changes(supervisor.session);
      const sessions =
        options?.resubscribe === undefined
          ? sessionChanges
          : Stream.merge(
              sessionChanges,
              options.resubscribe.pipe(
                Stream.mapEffect(() => SubscriptionRef.get(supervisor.session)),
              ),
            );
      return sessions.pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) => {
              const method = (
                tag === WS_METHODS.subscribeServerConfig
                  ? session.subscribeServerConfig
                  : session.client[tag]
              ) as (
                input: EnvironmentRpcInput<TTag>,
              ) => Stream.Stream<
                EnvironmentRpcStreamValue<TTag>,
                EnvironmentRpcStreamFailure<TTag>
              >;
              const subscribeToSession = (): Stream.Stream<
                EnvironmentRpcStreamValue<TTag>,
                EnvironmentRpcStreamFailure<TTag>
              > =>
                Stream.suspend(() =>
                  Stream.unwrap(
                    Effect.gen(function* () {
                      const input = yield* makeInput(session);
                      const completeObservation = yield* observer.observe({
                        environmentId: supervisor.target.environmentId,
                        method: tag,
                        input,
                      });
                      // The pool is created here, inside the per-session
                      // subscription, so it dies with the session.
                      const items = method(input);
                      return (
                        NON_CUMULATIVE_SUBSCRIPTION_TAGS.has(tag) ? items : poolWithinFrame(items)
                      ).pipe(
                        Stream.ensuring(completeObservation),
                        Stream.catchCause((cause) => {
                          const hasOnlyExpectedFailures =
                            cause.reasons.length > 0 &&
                            cause.reasons.every((reason) => reason._tag === "Fail");
                          const isTransportFailure =
                            hasOnlyExpectedFailures &&
                            cause.reasons.every(
                              (reason) => reason._tag === "Fail" && isRpcClientError(reason.error),
                            );
                          if (isTransportFailure) {
                            return Stream.fromEffect(
                              Effect.logWarning(
                                "Durable RPC subscription lost its transport; waiting for the next session.",
                                {
                                  cause: Cause.pretty(cause),
                                  method: tag,
                                  environmentId: supervisor.target.environmentId,
                                },
                              ),
                            ).pipe(Stream.drain);
                          }
                          if (hasOnlyExpectedFailures && options?.onExpectedFailure !== undefined) {
                            const handled = Stream.fromEffect(
                              options.onExpectedFailure(cause),
                            ).pipe(Stream.drain);
                            if (options.retryExpectedFailureAfter === undefined) {
                              return handled;
                            }
                            return handled.pipe(
                              Stream.concat(
                                Stream.fromEffect(
                                  Effect.sleep(options.retryExpectedFailureAfter),
                                ).pipe(Stream.drain),
                              ),
                              Stream.concat(subscribeToSession()),
                            );
                          }
                          return Stream.failCause(cause);
                        }),
                      );
                    }),
                  ),
                );
              return subscribeToSession();
            },
          }),
        ),
      );
    }),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.subscribe", {
      attributes: { "rpc.method": tag },
    }),
  );
}

export function subscribe<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  return subscribeDynamic(tag, () => Effect.succeed(input), options);
}

export const config = Effect.gen(function* () {
  const session = yield* currentSession();
  return yield* session.initialConfig;
}).pipe(Effect.withSpan("EnvironmentRpc.config"));
