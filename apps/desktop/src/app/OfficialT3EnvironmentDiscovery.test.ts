import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { discoverOfficialT3Environment } from "./OfficialT3EnvironmentDiscovery.ts";

const descriptor = {
  environmentId: EnvironmentId.make("official-environment"),
  label: "T3 Code",
  platform: { os: "windows", arch: "x64" },
  serverVersion: "1.2.3",
  capabilities: { repositoryIdentity: true },
} as const;
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);

function layer(input?: {
  readonly runtimeState?: string;
  readonly responseStatus?: number;
  readonly responseBody?: unknown;
  readonly requestUrls?: string[];
}) {
  const fileSystem = FileSystem.layerNoop({
    readFileString: () =>
      Effect.succeed(
        input?.runtimeState ?? '{"version":1,"pid":123,"origin":"http://127.0.0.1:43123"}',
      ),
  });
  const httpClient = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        input?.requestUrls?.push(request.url);
        return HttpClientResponse.fromWeb(
          request,
          new Response(encodeJson(input?.responseBody ?? descriptor), {
            status: input?.responseStatus ?? 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );
  return Layer.merge(fileSystem, httpClient);
}

describe("official T3 environment discovery", () => {
  it.effect("probes the live server and returns connection endpoints", () => {
    const requestUrls: string[] = [];
    return Effect.gen(function* () {
      const result = yield* discoverOfficialT3Environment(
        "C:/Users/test/.t3/userdata/server-runtime.json",
      );

      assert.deepEqual(result, {
        descriptor,
        httpBaseUrl: "http://127.0.0.1:43123",
        wsBaseUrl: "ws://127.0.0.1:43123",
      });
      assert.deepEqual(requestUrls, ["http://127.0.0.1:43123/.well-known/t3/environment"]);
    }).pipe(Effect.provide(layer({ requestUrls })));
  });

  it.effect("prefers the single-origin development URL", () => {
    const requestUrls: string[] = [];
    return Effect.gen(function* () {
      yield* discoverOfficialT3Environment("runtime.json");
      assert.deepEqual(requestUrls, [
        "https://official-dev.example.test/.well-known/t3/environment",
      ]);
    }).pipe(
      Effect.provide(
        layer({
          runtimeState:
            '{"version":1,"pid":123,"origin":"http://127.0.0.1:43123","devUrl":"https://official-dev.example.test/"}',
          requestUrls,
        }),
      ),
    );
  });

  it.effect("ignores stale runtime files and invalid descriptors", () =>
    Effect.gen(function* () {
      const stale = yield* discoverOfficialT3Environment("runtime.json").pipe(
        Effect.provide(layer({ responseStatus: 503 })),
      );
      const invalid = yield* discoverOfficialT3Environment("runtime.json").pipe(
        Effect.provide(layer({ responseBody: { environmentId: "incomplete" } })),
      );
      assert.equal(stale, null);
      assert.equal(invalid, null);
    }),
  );
});
