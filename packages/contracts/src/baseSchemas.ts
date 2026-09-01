import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SchemaError from "effect/SchemaError";
import * as SchemaIssue from "effect/SchemaIssue";
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

/**
 * Safe categories for a failed DPoP proof. These describe the class of failure
 * without exposing proof contents or server-side authentication details.
 */
export const DpopFailureReason = Schema.Literals([
  "time_window",
  "key_mismatch",
  "request_mismatch",
  "token_mismatch",
  "replay",
  "invalid_proof",
]);
export type DpopFailureReason = typeof DpopFailureReason.Type;

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
  //
  // Three things the annotations below assert, all of them pre-existing parity with
  // the shape this replaced rather than new narrowings:
  //  - R = never: element schemas handed to this combinator must stay service-free.
  //    The `as never` argument cast is what erases the requirement channel, and it is
  //    the only cast here that is genuinely forced.
  //  - `Schema.decodeUnknownOption` returns `None` for a *failed* decode but THROWS
  //    for a defect or an async cause. "Drop on failure" is therefore not
  //    unconditional — a broken element schema still surfaces, it does not vanish.
  //  - Element decode runs with the default `ParseOptions` by construction: this
  //    transformation does not thread a caller's options (e.g. `onExcessProperty`)
  //    into the per-element decode. No in-repo caller passes options on these
  //    payloads.
  const decodeElement: (value: unknown) => Option.Option<Element["Type"]> =
    Schema.decodeUnknownOption(element as never);
  const encodeElement: (
    value: Element["Type"],
  ) => Effect.Effect<Element["Encoded"], SchemaError.SchemaError> = Schema.encodeUnknownEffect(
    element as never,
  );
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
        // Encode is fail-fast on the first bad element, like the `Schema.Array`
        // target it replaced (this does NOT aggregate under `errors: "all"` — a
        // deliberate narrowing, since the caller only ever sees the first issue
        // anyway). The index has to be re-attached by hand: without the pointer
        // a bad rule in a 40-entry keybindings config ships a bare element issue
        // and is unlocatable from logs. `Effect.forEach` also passes the array
        // index as the SECOND argument, which is `ParseOptions` on the real
        // function — the explicit lambda keeps it out of that slot.
        encode: (values) =>
          Effect.forEach(values, (value, index) =>
            Effect.mapError(
              encodeElement(value),
              (error) => new SchemaIssue.Pointer([index], error.issue),
            ),
          ),
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

/**
 * Which client surface a connection or command comes from. Unlike
 * `AuthClientMetadataDeviceType` (a UA-style device class where web and
 * desktop are both "desktop"), this names the actual product surface.
 * Optional everywhere it appears: old clients never send it.
 */
export const ClientSurface = Schema.Literals(["web", "desktop", "mobile", "cli"]);
export type ClientSurface = typeof ClientSurface.Type;

export const ClientOs = Schema.Literals([
  "macOS",
  "Windows",
  "Linux",
  "iOS",
  "Android",
  "ChromeOS",
  "other",
  "unknown",
]);
export type ClientOs = typeof ClientOs.Type;

export const ClientDeviceType = Schema.Literals(["desktop", "phone", "tablet", "unknown"]);
export type ClientDeviceType = typeof ClientDeviceType.Type;

export const ClientWebDeployment = Schema.Literals(["hosted", "server"]);
export type ClientWebDeployment = typeof ClientWebDeployment.Type;

export const ClientConnectionMethod = Schema.Literals(["direct", "ssh", "relay", "unknown"]);
export type ClientConnectionMethod = typeof ClientConnectionMethod.Type;

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
