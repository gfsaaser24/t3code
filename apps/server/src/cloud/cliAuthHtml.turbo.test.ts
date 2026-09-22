import { expect, it } from "@effect/vitest";

import { renderLoopbackAuthorizationCompleteHtml } from "./cliAuthHtml.ts";

/**
 * Brand pin for the loopback authorization page. Upstream removed its static
 * snapshot test for this page (pingdotgg/t3code#9986); this keeps the one
 * assertion the fork cared about - the page says "T3 Turbo", never "T3 Code".
 */
it("brands the loopback authorization page for T3 Turbo on every channel", () => {
  const dev = renderLoopbackAuthorizationCompleteHtml("dev");
  const nightly = renderLoopbackAuthorizationCompleteHtml("nightly");
  const latest = renderLoopbackAuthorizationCompleteHtml("latest");

  expect(dev).toContain("T3 Turbo (Dev)");
  expect(nightly).toContain("T3 Turbo (Nightly)");
  expect(latest).toContain('<p class="brand">T3 Turbo</p>');
  for (const html of [dev, nightly, latest]) {
    expect(html).not.toContain("T3 Code");
  }
});
