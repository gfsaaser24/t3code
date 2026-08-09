import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Sqlite.ts";

/**
 * T3 Turbo: `PRAGMA synchronous = NORMAL` is the standard WAL companion. It is a
 * connection-scoped setting, so these tests read it back through the same
 * `SqlClient` the server uses rather than trusting that the setup layer ran.
 *
 * Both sqlite client loaders (`@effect/sql-sqlite-bun` and the local
 * `NodeSqliteClient`) open exactly one connection per client and serialize every
 * query onto it, so a single assertion per client covers the whole "pool".
 */
const readPragma = Effect.fn("readPragma")(function* (name: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql.unsafe<Record<string, unknown>>(`PRAGMA ${name};`);
  const row = rows[0];
  assert.isDefined(row, `PRAGMA ${name} returned no rows`);
  return row?.[name];
});

// 1 === NORMAL, 2 === FULL (the sqlite default).
const SYNCHRONOUS_NORMAL = 1;

describe("Sqlite persistence pragmas", () => {
  it.effect("in-memory persistence enables synchronous=NORMAL and keeps foreign_keys on", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* readPragma("synchronous"), SYNCHRONOUS_NORMAL);
      assert.strictEqual(yield* readPragma("foreign_keys"), 1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("file-backed persistence keeps WAL and applies synchronous=NORMAL", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-sqlite-pragmas-",
      });
      const dbPath = path.join(root, "orchestration.sqlite");

      yield* Effect.gen(function* () {
        assert.strictEqual(yield* readPragma("synchronous"), SYNCHRONOUS_NORMAL);
        assert.strictEqual(yield* readPragma("journal_mode"), "wal");
        assert.strictEqual(yield* readPragma("foreign_keys"), 1);

        // The pragma is per-connection, so prove the transaction acquirer hands
        // back the same connection the setup layer configured.
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            assert.strictEqual(yield* readPragma("synchronous"), SYNCHRONOUS_NORMAL);
          }),
        );
        assert.strictEqual(yield* readPragma("synchronous"), SYNCHRONOUS_NORMAL);
      }).pipe(Effect.provide(makeSqlitePersistenceLive(dbPath)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
