import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import { unlinkEnvironmentRecord } from "../http/Api.ts";

// The link memo is a read optimisation, so every test here drives the REAL `EnvironmentLinks`
// layer over a fake database and asks what the WRITE paths see. How many queries a pure read path
// makes is `environmentLinkLookupMemo.test.ts`.

const LINK_ROW = {
  environmentId: "env-1",
  environmentLabel: "Workstation",
  endpointHttpBaseUrl: "https://env.example.test",
  endpointWsBaseUrl: "wss://env.example.test",
  endpointProviderKind: "cloudflare_tunnel",
  createdAt: "2026-08-09T00:00:00.000Z",
};

const LOOKUP = { userId: "user-1", environmentId: "env-1" } as const;

/**
 * A database whose link row carries whatever public key `currentKey` returns at read time, so a
 * test can rotate the environment's key between two reads the way a re-pair does. The row stays
 * readable after the revoke update on purpose: that is what an uncommitted revoke looks like to a
 * concurrent reader.
 */
function rotatingKeyDb(
  currentKey: () => string,
  reads: { count: number },
): RelayDb.RelayDb["Service"] {
  const execute = Effect.sync(() => {
    reads.count += 1;
    return [{ ...LINK_ROW, environmentPublicKey: currentKey() }];
  });
  return {
    select: () => ({
      from: () => ({
        where: () => Object.assign(execute, { limit: () => execute }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Effect.succeed([{ environmentId: LINK_ROW.environmentId }]),
        }),
      }),
    }),
  } as unknown as RelayDb.RelayDb["Service"];
}

function linksLayer(db: RelayDb.RelayDb["Service"]) {
  return EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db)));
}

function unlinkLayer(
  db: RelayDb.RelayDb["Service"],
  revokeCredential: EnvironmentCredentials.EnvironmentCredentials["Service"]["revokeForEnvironmentPublicKey"],
) {
  return Layer.mergeAll(
    linksLayer(db),
    Layer.succeed(
      RelayDb.RelayTransactions,
      RelayDb.RelayTransactions.of({ withTransaction: (effect) => effect }),
    ),
    Layer.succeed(
      EnvironmentCredentials.EnvironmentCredentials,
      EnvironmentCredentials.EnvironmentCredentials.of({
        create: () => Effect.die("unused create"),
        authenticate: () => Effect.die("unused authenticate"),
        revokeForEnvironmentPublicKey: revokeCredential,
      }),
    ),
    Layer.succeed(
      ManagedEndpointProvider.ManagedEndpointProvider,
      ManagedEndpointProvider.ManagedEndpointProvider.of({
        provision: () => Effect.die("unused provision"),
        prepareDeprovision: () => Effect.succeed(null),
        deprovision: () => Effect.void,
        release: () => Effect.die("unused release"),
      }),
    ),
  );
}

describe("environment link memo on the write paths", () => {
  it.effect("revokes the CURRENT credential when an unlink runs through a warm memo", () => {
    const reads = { count: 0 };
    const revoked: Array<string> = [];
    let currentKey = "environment-public-key-1";
    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;

      // A status or connect request warms the memo with the pre-rotation record.
      expect(yield* links.getForUser(LOOKUP)).toMatchObject({
        environmentPublicKey: "environment-public-key-1",
      });
      expect(yield* links.getForUser(LOOKUP)).toMatchObject({
        environmentPublicKey: "environment-public-key-1",
      });
      expect(reads.count).toBe(1);

      // The environment re-pairs with a new key, well inside the memo's five second window.
      currentKey = "environment-public-key-2";

      expect(yield* unlinkEnvironmentRecord(LOOKUP)).toBe(true);

      // Answering the unlink from the memo would revoke key 1 and leave the environment's live
      // session on key 2 authenticated.
      expect(revoked).toEqual(["environment-public-key-2"]);
      expect(reads.count).toBe(2);
    }).pipe(
      Effect.provide(
        unlinkLayer(
          rotatingKeyDb(() => currentKey, reads),
          (request) =>
            Effect.sync(() => {
              revoked.push(request.environmentPublicKey);
              return true;
            }),
        ),
      ),
    );
  });

  it.effect("never warms the memo from the unlink's own fresh read", () => {
    const reads = { count: 0 };
    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;

      yield* unlinkEnvironmentRecord(LOOKUP);
      expect(reads.count).toBe(1);

      // The fresh read must not leave a record behind for the next reader either.
      yield* links.getForUser(LOOKUP);
      expect(reads.count).toBe(2);
    }).pipe(
      Effect.provide(
        unlinkLayer(
          rotatingKeyDb(() => "environment-public-key-1", reads),
          () => Effect.succeed(true),
        ),
      ),
    );
  });

  it.effect("does not let a read inside the open transaction re-cache the pre-revoke row", () => {
    const reads = { count: 0 };
    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;

      // `revokeForUser` drops its memo entries while the surrounding transaction is still open.
      yield* links.revokeForUser(LOOKUP);

      // A concurrent status request lands in the gap between that drop and the commit. The
      // database still shows the pre-revoke row, because the revoke has not committed.
      yield* links.getForUser(LOOKUP);
      yield* links.listForUser({ userId: LOOKUP.userId });
      expect(reads.count).toBe(2);

      // ...and the commit lands. If the in-gap answers had been remembered, these two lookups
      // would serve a link that no longer exists for the rest of the five second window.
      yield* links.getForUser(LOOKUP);
      yield* links.listForUser({ userId: LOOKUP.userId });
      expect(reads.count).toBe(4);
    }).pipe(Effect.provide(linksLayer(rotatingKeyDb(() => "environment-public-key-1", reads))));
  });
});
