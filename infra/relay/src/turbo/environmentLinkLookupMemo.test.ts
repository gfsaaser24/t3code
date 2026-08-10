import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as RelayDb from "../db.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";

const linkRow = {
  environmentId: "env-1",
  environmentLabel: "Workstation",
  environmentPublicKey: "environment-public-key",
  endpointHttpBaseUrl: "https://env.example.test",
  endpointWsBaseUrl: "wss://env.example.test",
  endpointProviderKind: "managed",
  createdAt: "2026-08-09T00:00:00.000Z",
};

// `select(...).from(...).where(...)` ends in `.limit(1)` for the single-row lookups and resolves
// directly for the list lookups, so both shapes are served and every execution is counted.
function countingSelectDb(
  reads: { count: number },
  rows: () => ReadonlyArray<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): RelayDb.RelayDb["Service"] {
  const execute = Effect.sync(() => {
    reads.count += 1;
    return rows();
  });
  return {
    select: () => ({
      from: () => ({
        where: () => Object.assign(execute, { limit: () => execute }),
      }),
    }),
    ...extra,
  } as unknown as RelayDb.RelayDb["Service"];
}

function linksLayer(db: RelayDb.RelayDb["Service"]) {
  return EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db)));
}

describe("environment link lookup memo", () => {
  it.effect("serves a repeat link lookup from the memo until the five second window closes", () => {
    const reads = { count: 0 };
    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const lookup = { userId: "user-1", environmentId: "env-1" };

      expect(yield* links.getForUser(lookup)).toMatchObject({ environmentId: "env-1" });
      expect(yield* links.getForUser(lookup)).toMatchObject({ environmentId: "env-1" });
      expect(reads.count).toBe(1);

      yield* TestClock.adjust(Duration.seconds(5));
      expect(yield* links.getForUser(lookup)).toMatchObject({ environmentId: "env-1" });
      expect(reads.count).toBe(2);

      // A different user is a different entry.
      yield* links.getForUser({ userId: "user-2", environmentId: "env-1" });
      expect(reads.count).toBe(3);

      yield* links.listForUser({ userId: "user-1" });
      yield* links.listForUser({ userId: "user-1" });
      expect(reads.count).toBe(4);
    }).pipe(Effect.provide(linksLayer(countingSelectDb(reads, () => [linkRow]))));
  });

  it.effect("never remembers a missing link", () => {
    const reads = { count: 0 };
    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;

      expect(yield* links.getForUser({ userId: "user-1", environmentId: "env-1" })).toBeNull();
      expect(yield* links.getForUser({ userId: "user-1", environmentId: "env-1" })).toBeNull();
      expect(yield* links.listForUser({ userId: "user-1" })).toEqual([]);
      expect(yield* links.listForUser({ userId: "user-1" })).toEqual([]);

      expect(reads.count).toBe(4);
    }).pipe(Effect.provide(linksLayer(countingSelectDb(reads, () => []))));
  });

  it.effect("forgets a remembered link as soon as this isolate revokes it", () => {
    const reads = { count: 0 };
    const db = countingSelectDb(reads, () => [linkRow], {
      update: () => ({
        set: () => ({
          where: () => ({ returning: () => Effect.succeed([{ environmentId: "env-1" }]) }),
        }),
      }),
    });
    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const lookup = { userId: "user-1", environmentId: "env-1" };

      yield* links.getForUser(lookup);
      expect(yield* links.revokeForUser(lookup)).toBe(true);
      yield* links.getForUser(lookup);

      expect(reads.count).toBe(2);
    }).pipe(Effect.provide(linksLayer(db)));
  });

  it.effect("never caches the allocation record that carries the compare-and-swap token", () => {
    const reads = { count: 0 };
    const allocationRow = {
      userId: "user-1",
      environmentId: "env-1",
      hostname: "env-1.example.test",
      tunnelId: "tunnel-1",
      tunnelName: "tunnel-name",
      dnsRecordId: "dns-1",
      readyAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    };
    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const key = { userId: "user-1", environmentId: "env-1" };

      yield* allocations.get(key);
      yield* allocations.get(key);
      yield* allocations.get(key);

      expect(reads.count).toBe(3);
    }).pipe(
      Effect.provide(
        ManagedEndpointAllocations.layer.pipe(
          Layer.provide(
            Layer.succeed(
              RelayDb.RelayDb,
              countingSelectDb(reads, () => [allocationRow]),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("never caches the credential check that enforces instant revocation", () => {
    const reads = { count: 0 };
    const credentialRow = {
      credentialId: "credential-1",
      environmentId: "env-1",
      environmentPublicKey: "environment-public-key",
    };
    return Effect.gen(function* () {
      const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;

      expect(Option.isSome(yield* credentials.authenticate("t3env_token"))).toBe(true);
      yield* credentials.authenticate("t3env_token");
      yield* credentials.authenticate("t3env_token");

      expect(reads.count).toBe(3);
    }).pipe(
      Effect.provide(
        EnvironmentCredentials.layer.pipe(
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(
            Layer.succeed(
              RelayDb.RelayDb,
              countingSelectDb(reads, () => [credentialRow]),
            ),
          ),
        ),
      ),
    );
  });
});
