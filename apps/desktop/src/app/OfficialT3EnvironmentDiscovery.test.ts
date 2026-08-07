import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { discoverOfficialT3ImportAvailability } from "./OfficialT3EnvironmentDiscovery.ts";

function layer(exists: (path: string) => boolean = () => true) {
  return Layer.merge(
    FileSystem.layerNoop({
      exists: (path) => Effect.succeed(exists(path)),
    }),
    Path.layer,
  );
}

describe("official T3 import discovery", () => {
  it.effect("offers direct CLI commands when both databases exist", () =>
    Effect.gen(function* () {
      const result = yield* discoverOfficialT3ImportAvailability({
        sourceBaseDir: "C:/Users/test/.t3",
        targetBaseDir: "C:/Users/test/.t3-turbo",
      });

      assert.ok(result !== null);
      assert.include(result.runCommand, "t3 import official run");
      assert.include(result.runCommand, result.sourceBaseDir);
      assert.include(result.runCommand, result.targetBaseDir);
      assert.include(result.planCommand, "t3 import official plan");
    }).pipe(Effect.provide(layer())),
  );

  it.effect("does not advertise a connector or import when source data is absent", () =>
    Effect.gen(function* () {
      const result = yield* discoverOfficialT3ImportAvailability({
        sourceBaseDir: "C:/Users/test/.t3",
        targetBaseDir: "C:/Users/test/.t3-turbo",
      });
      assert.equal(result, null);
    }).pipe(Effect.provide(layer((path) => path.includes(".t3-turbo")))),
  );

  it.effect("rejects importing a database into itself", () =>
    Effect.gen(function* () {
      const result = yield* discoverOfficialT3ImportAvailability({
        sourceBaseDir: "C:/Users/test/.t3",
        targetBaseDir: "C:/Users/test/.t3",
      });
      assert.equal(result, null);
    }).pipe(Effect.provide(layer(() => false))),
  );
});
