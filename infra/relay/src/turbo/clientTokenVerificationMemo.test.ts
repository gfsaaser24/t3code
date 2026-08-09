import { createClerkClient, verifyToken } from "@clerk/backend";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import { sha256Base64Url } from "@t3tools/shared/turbo/sha256";

import * as RelayConfiguration from "../Config.ts";
import { verifiedRelayClientTokenKey, verifyRelayClientBearerToken } from "../http/Api.ts";
import { makeTtlMemo, readTtlMemo, writeTtlMemo } from "./ttlMemo.ts";

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(),
  verifyToken: vi.fn(),
}));

// The memo is keyed on the configuration service identity, so a fresh settings object per test
// is a fresh memo.
function relaySettings(): RelayConfiguration.RelayConfiguration["Service"] {
  return {
    relayIssuer: "https://relay.example.test",
    apns: null,
    clerkSecretKey: Redacted.make("clerk-secret-key"),
    clerkPublishableKey: "pk_test_test",
    clerkJwtAudience: "t3-code-relay",
    apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
    cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
    cloudMintPublicKey: "cloud-mint-public-key",
    managedEndpointBaseDomain: undefined,
    managedEndpointNamespace: undefined,
  };
}

function jwtShapedToken(claims: Record<string, unknown>): string {
  return [
    Encoding.encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    Encoding.encodeBase64Url(JSON.stringify(claims)),
    "signature",
  ].join(".");
}

function resetClerkMocks(): void {
  vi.mocked(verifyToken).mockReset();
  vi.mocked(createClerkClient).mockReset();
}

describe("relay client token verification memo", () => {
  it.effect("remembers a successful session verification instead of re-verifying it", () =>
    Effect.gen(function* () {
      const config = relaySettings();
      const token = jwtShapedToken({ sub: "user_session", exp: 3_600 });
      vi.mocked(verifyToken).mockResolvedValue({
        sub: "user_session",
        aud: config.clerkJwtAudience,
      } as never);

      const first = yield* verifyRelayClientBearerToken(config, token);
      const second = yield* verifyRelayClientBearerToken(config, token);

      expect(first).toEqual({ sub: "user_session", mode: "clerk_session_bearer" });
      expect(second).toEqual(first);
      expect(verifyToken).toHaveBeenCalledTimes(1);
    }).pipe(Effect.ensuring(Effect.sync(resetClerkMocks))),
  );

  it.effect("never trusts the memo past the token's own expiry", () =>
    Effect.gen(function* () {
      const config = relaySettings();
      // Expires five seconds in, far inside the thirty second cap.
      const token = jwtShapedToken({ sub: "user_session", exp: 5 });
      vi.mocked(verifyToken).mockResolvedValue({
        sub: "user_session",
        aud: config.clerkJwtAudience,
      } as never);

      yield* verifyRelayClientBearerToken(config, token);
      yield* TestClock.adjust(Duration.seconds(4));
      yield* verifyRelayClientBearerToken(config, token);
      expect(verifyToken).toHaveBeenCalledTimes(1);

      yield* TestClock.adjust(Duration.seconds(2));
      yield* verifyRelayClientBearerToken(config, token);
      expect(verifyToken).toHaveBeenCalledTimes(2);
    }).pipe(Effect.ensuring(Effect.sync(resetClerkMocks))),
  );

  it.effect("caps an unreadable expiry at thirty seconds and keeps the OAuth fallback chain", () =>
    Effect.gen(function* () {
      const config = relaySettings();
      const authenticateRequest = vi.fn().mockResolvedValue({
        isAuthenticated: true,
        toAuth: () => ({ userId: "user_oauth" }),
      });
      vi.mocked(verifyToken).mockRejectedValue(new Error("not a session JWT"));
      vi.mocked(createClerkClient).mockReturnValue({ authenticateRequest } as never);

      const verified = yield* verifyRelayClientBearerToken(config, "oat_opaque_cli_token");
      expect(verified).toEqual({ sub: "user_oauth", mode: "clerk_oauth_bearer" });

      yield* TestClock.adjust(Duration.seconds(29));
      yield* verifyRelayClientBearerToken(config, "oat_opaque_cli_token");
      expect(authenticateRequest).toHaveBeenCalledTimes(1);

      yield* TestClock.adjust(Duration.seconds(2));
      yield* verifyRelayClientBearerToken(config, "oat_opaque_cli_token");
      expect(authenticateRequest).toHaveBeenCalledTimes(2);
    }).pipe(Effect.ensuring(Effect.sync(resetClerkMocks))),
  );

  it.effect("never remembers a failed verification", () =>
    Effect.gen(function* () {
      const config = relaySettings();
      const authenticateRequest = vi.fn().mockRejectedValue(new Error("not an OAuth token"));
      vi.mocked(verifyToken).mockRejectedValue(new Error("not a session JWT"));
      vi.mocked(createClerkClient).mockReturnValue({ authenticateRequest } as never);

      const first = yield* Effect.flip(verifyRelayClientBearerToken(config, "rejected-token"));
      const second = yield* Effect.flip(verifyRelayClientBearerToken(config, "rejected-token"));

      expect(first._tag).toBe("ClerkTokenVerificationFailed");
      expect(second._tag).toBe("ClerkTokenVerificationFailed");
      expect(verifyToken).toHaveBeenCalledTimes(2);
      expect(authenticateRequest).toHaveBeenCalledTimes(2);
    }).pipe(Effect.ensuring(Effect.sync(resetClerkMocks))),
  );

  it.effect("keeps one memo entry per token", () =>
    Effect.gen(function* () {
      const config = relaySettings();
      const first = jwtShapedToken({ sub: "user_one", exp: 3_600 });
      const second = jwtShapedToken({ sub: "user_two", exp: 3_600 });
      vi.mocked(verifyToken).mockImplementation((token) =>
        Promise.resolve({
          sub: token === first ? "user_one" : "user_two",
          aud: config.clerkJwtAudience,
        } as never),
      );

      expect(yield* verifyRelayClientBearerToken(config, first)).toEqual({
        sub: "user_one",
        mode: "clerk_session_bearer",
      });
      expect(yield* verifyRelayClientBearerToken(config, second)).toEqual({
        sub: "user_two",
        mode: "clerk_session_bearer",
      });
      expect(yield* verifyRelayClientBearerToken(config, first)).toEqual({
        sub: "user_one",
        mode: "clerk_session_bearer",
      });
      expect(verifyToken).toHaveBeenCalledTimes(2);
    }).pipe(Effect.ensuring(Effect.sync(resetClerkMocks))),
  );

  it("keys the memo by the token's SHA-256 digest, never by the token itself", () => {
    const token = jwtShapedToken({ sub: "user_session", exp: 3_600 });
    const key = verifiedRelayClientTokenKey(token);

    expect(key).not.toBe(token);
    expect(key).not.toContain(token);
    expect(key).toBe(sha256Base64Url(token));
    // Distinct tokens are distinct keys, and the same token is stable across calls.
    expect(verifiedRelayClientTokenKey(token)).toBe(key);
    expect(verifiedRelayClientTokenKey(`${token}x`)).not.toBe(key);
  });

  it("drops the oldest entry when the memo is full of live ones, never the whole memo", () => {
    const memo = makeTtlMemo<string>(3);
    for (const key of ["a", "b", "c"]) {
      writeTtlMemo(memo, key, key, 30_000, 0);
    }
    writeTtlMemo(memo, "d", "d", 30_000, 0);

    // The old implementation cleared here, throwing away the entire hot working set on every
    // write past the limit -- strictly negative work above `limit` concurrent live keys.
    expect(readTtlMemo(memo, "a", 0)).toBeNull();
    expect([
      readTtlMemo(memo, "b", 0),
      readTtlMemo(memo, "c", 0),
      readTtlMemo(memo, "d", 0),
    ]).toEqual(["b", "c", "d"]);
  });
});
