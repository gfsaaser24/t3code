import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ExternalLauncherInvalidPathError,
  OpenPathInput,
  OpenPathResult,
  isExternalLauncherError,
} from "./editor.ts";

const decodeOpenPathInput = Schema.decodeUnknownSync(OpenPathInput);
const decodeOpenPathResult = Schema.decodeUnknownSync(OpenPathResult);

it("decodes system-default path request and result payloads", () => {
  assert.deepEqual(decodeOpenPathInput({ path: "  /tmp/README.md  " }), {
    path: "/tmp/README.md",
  });
  assert.deepEqual(decodeOpenPathResult({ path: "/tmp/README.md" }), {
    path: "/tmp/README.md",
  });
});

it("includes invalid path failures in the external launcher error contract", () => {
  const error = new ExternalLauncherInvalidPathError({
    path: "README.md",
    reason: "not_absolute",
  });

  assert.equal(isExternalLauncherError(error), true);
  assert.equal(error.message, "External application paths must be absolute: README.md");
});
