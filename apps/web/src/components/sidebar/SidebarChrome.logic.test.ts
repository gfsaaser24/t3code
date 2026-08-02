import { assert, it } from "@effect/vitest";

import { resolveSidebarProductLabel } from "./SidebarChrome.logic";

it("uses the injected T3 product name in the sidebar wordmark", () => {
  assert.strictEqual(resolveSidebarProductLabel("T3 Turbo"), "Turbo");
  assert.strictEqual(resolveSidebarProductLabel("T3 Code"), "Code");
  assert.strictEqual(resolveSidebarProductLabel("Unexpected"), "Code");
});
