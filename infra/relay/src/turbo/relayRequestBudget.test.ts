/**
 * T3 Turbo (fork-owned): the whole point of the R5 tuning is the RELATION
 * between the two budgets, and nothing else asserts it. Upstream's 10s mint
 * timeout sits outside the relay's 9s request deadline, so it can never fire —
 * a stuck environment surfaces as a generic 504 instead of a mint timeout.
 * Raising the mint budget back to or past the deadline silently restores that,
 * with no other test going red.
 */
import { describe, expect, it } from "vite-plus/test";

import { ENVIRONMENT_MINT_REQUEST_TIMEOUT_MS } from "../environments/EnvironmentConnector.ts";
import { RELAY_REQUEST_DEADLINE_MS } from "../http/Api.ts";

describe("relay request budget", () => {
  it("expires the environment mint inside the relay request deadline", () => {
    expect(ENVIRONMENT_MINT_REQUEST_TIMEOUT_MS).toBeLessThan(RELAY_REQUEST_DEADLINE_MS);
  });
});
