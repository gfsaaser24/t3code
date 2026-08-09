import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SchemaError from "effect/SchemaError";
import * as SchemaTransformation from "effect/SchemaTransformation";

// Turbo: pure both-directions trim. `SchemaTransformation.trim()` is NOT a drop-in
// replacement — it trims on decode only, so values built without decoding would newly
// ship untrimmed. The pure `transform` skips the per-value Effect allocation that
// `transformOrFail` requires while trimming in both directions exactly as before.
export const TrimmedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform<string, string>({
      decode: (value) => value.trim(),
      encode: (value) => value.trim(),
    }),
  ),
);
export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

/**
 * Wire codec for server→client arrays whose element unions grow over time
 * (new literal members, new struct variants). Decoding drops elements the
 * current build cannot decode instead of failing the whole payload — a client
 * has to keep decoding configs sent by servers newer than itself, and
 * rejecting the payload would take down the connection over data the client
 * couldn't act on anyway. Encoding is the plain array encoding.
 */
export const ForwardCompatibleArray = <Element extends Schema.Top>(element: Element) => {
  // Turbo: decode each element exactly once. The previous shape decoded every element
  // twice — once to test decodability in the filter, once again in the target
  // `Schema.Array(element)`. Keeping the decoded value and targeting the type-side
  // schema drops the second pass; element encoding stays explicit so the wire bytes
  // produced on the encode path are unchanged.
  const decodeElement = Schema.decodeUnknownOption(element as never) as unknown as (
    value: unknown,
  ) => Option.Option<Element["Type"]>;
  const encodeElement = Schema.encodeUnknownEffect(element as never) as unknown as (
    value: Element["Type"],
  ) => Effect.Effect<Element["Encoded"], SchemaError.SchemaError>;
  return Schema.Array(Schema.Unknown).pipe(
    Schema.decodeTo(
      Schema.toType(Schema.Array(element)),
      SchemaTransformation.transformOrFail<ReadonlyArray<Element["Type"]>, ReadonlyArray<unknown>>({
        decode: (values) => {
          const decoded: Array<Element["Type"]> = [];
          let dropped = 0;
          for (const value of values) {
            const candidate = decodeElement(value);
            if (Option.isSome(candidate)) {
              decoded.push(candidate.value);
            } else {
              dropped += 1;
            }
          }
          if (dropped === 0) return Effect.succeed(decoded);
          // Debug-level breadcrumb: a silent drop here looks like "the list is
          // mysteriously empty" from the outside. Counts only — element payloads
          // are not logged.
          return Effect.as(
            Effect.logDebug("ForwardCompatibleArray dropped undecodable elements", {
              dropped,
              total: values.length,
            }),
            decoded,
          );
        },
        encode: (values) =>
          Effect.mapError(Effect.forEach(values, encodeElement), (error) => error.issue),
      }),
    ),
  );
};

/**
 * Construct a branded identifier. Enforces non-empty trimmed strings
 */
const makeEntityId = <Brand extends string>(brand: Brand) => {
  return TrimmedNonEmptyString.pipe(Schema.brand(brand));
};

export const ThreadId = makeEntityId("ThreadId");
export type ThreadId = typeof ThreadId.Type;
export const ProjectId = makeEntityId("ProjectId");
export type ProjectId = typeof ProjectId.Type;
export const EnvironmentId = makeEntityId("EnvironmentId");
export type EnvironmentId = typeof EnvironmentId.Type;
export const CommandId = makeEntityId("CommandId");
export type CommandId = typeof CommandId.Type;
export const EventId = makeEntityId("EventId");
export type EventId = typeof EventId.Type;
export const MessageId = makeEntityId("MessageId");
export type MessageId = typeof MessageId.Type;
export const TurnId = makeEntityId("TurnId");
export type TurnId = typeof TurnId.Type;
export const AuthSessionId = makeEntityId("AuthSessionId");
export type AuthSessionId = typeof AuthSessionId.Type;
export const RpcClientId = NonNegativeInt.pipe(Schema.brand("RpcClientId"));
export type RpcClientId = typeof RpcClientId.Type;

export const ProviderItemId = makeEntityId("ProviderItemId");
export type ProviderItemId = typeof ProviderItemId.Type;
export const RuntimeSessionId = makeEntityId("RuntimeSessionId");
export type RuntimeSessionId = typeof RuntimeSessionId.Type;
export const RuntimeItemId = makeEntityId("RuntimeItemId");
export type RuntimeItemId = typeof RuntimeItemId.Type;
export const RuntimeRequestId = makeEntityId("RuntimeRequestId");
export type RuntimeRequestId = typeof RuntimeRequestId.Type;
export const RuntimeTaskId = makeEntityId("RuntimeTaskId");
export type RuntimeTaskId = typeof RuntimeTaskId.Type;
export const ApprovalRequestId = makeEntityId("ApprovalRequestId");
export type ApprovalRequestId = typeof ApprovalRequestId.Type;
export const CheckpointRef = makeEntityId("CheckpointRef");
export type CheckpointRef = typeof CheckpointRef.Type;
