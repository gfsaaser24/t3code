import { describe, expect, it } from "vite-plus/test";

import {
  MOBILE_CLIENT_LABEL,
  MOBILE_PRODUCT_NAME,
  resolveMobileStageLabel,
} from "./mobileBranding";

it("owns the Turbo product and client labels used by mobile surfaces", () => {
  expect(MOBILE_PRODUCT_NAME).toBe("T3 Turbo");
  expect(MOBILE_CLIENT_LABEL).toBe("T3 Turbo Mobile");
});

describe("resolveMobileStageLabel", () => {
  it.each([
    ["development", "Dev"],
    ["preview", "Nightly"],
    ["production", "Alpha"],
    [undefined, "Alpha"],
  ])("maps %s builds to %s", (appVariant, expected) => {
    expect(resolveMobileStageLabel(appVariant)).toBe(expected);
  });
});
