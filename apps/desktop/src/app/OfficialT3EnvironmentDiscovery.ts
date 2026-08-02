import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

const DISCOVERY_TIMEOUT_MS = 1_500;

const OfficialT3RuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  origin: Schema.String,
  devUrl: Schema.optional(Schema.String),
});
const decodeOfficialT3RuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OfficialT3RuntimeState),
);

function normalizeHttpBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = url.pathname.replace(/\/$/u, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

function toWebSocketBaseUrl(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/u, "");
}

/**
 * Finds the official desktop server without opening its database. The runtime
 * file is only a hint; a successful descriptor probe is what makes the
 * environment eligible for attachment.
 */
export const discoverOfficialT3Environment = Effect.fn("desktop.officialT3.discover")(function* (
  runtimeStatePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const runtimeState = yield* decodeOfficialT3RuntimeState(
      yield* fs.readFileString(runtimeStatePath),
    );
    const httpBaseUrl = normalizeHttpBaseUrl(runtimeState.devUrl ?? runtimeState.origin);
    if (httpBaseUrl === null) return null;

    const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
      Effect.timeout(Duration.millis(DISCOVERY_TIMEOUT_MS)),
    );
    return {
      descriptor,
      httpBaseUrl,
      wsBaseUrl: toWebSocketBaseUrl(httpBaseUrl),
    };
  }).pipe(Effect.orElseSucceed(() => null));
});
