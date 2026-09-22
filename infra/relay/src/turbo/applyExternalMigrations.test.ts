/**
 * T3 Turbo (fork-owned): the external Supabase path has no Drizzle migrator, so
 * `apply-external-migrations.ts` is the only thing that keeps that database's schema in step with
 * `infra/relay/migrations/postgres`. The planner is where a mistake is silent and expensive -- a
 * baseline that leaks past an already-seeded ledger skips a real migration -- so it is pinned here,
 * together with one end-to-end pass over a fake `sql` client that proves the ledger writes, the
 * per-folder transaction, and the log lines.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import {
  applyMigrations,
  MIGRATIONS_LEDGER_TABLE,
  type MigrationSqlClient,
  planMigrations,
  splitMigrationStatements,
} from "../../scripts/apply-external-migrations.ts";

describe("splitMigrationStatements", () => {
  it("splits on the Drizzle breakpoint and drops blanks", () => {
    const sql = `ALTER TABLE "a" ADD COLUMN "x" integer;--> statement-breakpoint\nALTER TABLE "a" ALTER COLUMN "y" DROP NOT NULL;\n--> statement-breakpoint\n`;
    expect(splitMigrationStatements(sql)).toEqual([
      'ALTER TABLE "a" ADD COLUMN "x" integer;',
      'ALTER TABLE "a" ALTER COLUMN "y" DROP NOT NULL;',
    ]);
  });
});

describe("planMigrations", () => {
  const tags = ["20260918_c", "20260527_a", "20260906_b"];

  it("runs every folder in name order when nothing is applied and no baseline is set", () => {
    expect(planMigrations({ tags, applied: [] })).toEqual({
      seed: [],
      run: ["20260527_a", "20260906_b", "20260918_c"],
    });
  });

  it("seeds folders up to the baseline on an empty ledger and runs the rest", () => {
    expect(planMigrations({ tags, applied: [], baselineTag: "20260527_a" })).toEqual({
      seed: ["20260527_a"],
      run: ["20260906_b", "20260918_c"],
    });
  });

  it("ignores the baseline once the ledger has rows", () => {
    expect(planMigrations({ tags, applied: ["20260527_a"], baselineTag: "20260918_c" })).toEqual({
      seed: [],
      run: ["20260906_b", "20260918_c"],
    });
  });

  it("skips applied folders", () => {
    expect(planMigrations({ tags, applied: ["20260527_a", "20260906_b", "20260918_c"] })).toEqual({
      seed: [],
      run: [],
    });
  });
});

const migrationFiles: Record<string, string> = {
  "/migrations/20260527_a/migration.sql": 'CREATE TABLE "a" ();',
  "/migrations/20260906_b/migration.sql": 'ALTER TABLE "a" ADD COLUMN "x" integer;',
  "/migrations/20260918_c/migration.sql": `ALTER TABLE "a" ADD COLUMN "y" integer;--> statement-breakpoint\nALTER TABLE "a" ADD COLUMN "z" integer;`,
};

/** `meta` has no `migration.sql`, so it stands in for the stray entries Drizzle leaves behind. */
const fileSystemLayer = FileSystem.layerNoop({
  readDirectory: () => Effect.succeed(["20260918_c", "20260527_a", "20260906_b", "meta"]),
  exists: (path) => Effect.succeed(path.replaceAll("\\", "/") in migrationFiles),
  readFileString: (path) => Effect.succeed(migrationFiles[path.replaceAll("\\", "/")] ?? ""),
});

/** Records every statement, and brackets each transaction so ordering stays observable. */
const makeFakeSql = (applied: ReadonlyArray<string>) => {
  const statements: Array<string> = [];
  const sql: MigrationSqlClient = {
    unsafe: (statement, params) =>
      Effect.sync(() => {
        statements.push(params === undefined ? statement : `${statement} :: ${String(params[0])}`);
        return statement.startsWith(`SELECT "tag"`) ? applied.map((tag) => ({ tag })) : [];
      }),
    withTransaction: (effect) =>
      Effect.gen(function* () {
        statements.push("BEGIN");
        const result = yield* effect;
        statements.push("COMMIT");
        return result;
      }),
  };
  return { sql, statements };
};

describe("applyMigrations", () => {
  it.effect("seeds the baseline, runs the rest in transactions, and records the ledger", () => {
    const { sql, statements } = makeFakeSql([]);
    const logs: Array<string> = [];
    const collector = Logger.make<unknown, void>((options) => {
      logs.push(String(options.message));
    });
    return applyMigrations({ sql, migrationsDir: "/migrations", baselineTag: "20260527_a" }).pipe(
      Effect.provide(Layer.mergeAll(Logger.layer([collector]), fileSystemLayer, Path.layer)),
      Effect.map(() => {
        expect(statements[0]).toContain(`CREATE TABLE IF NOT EXISTS "${MIGRATIONS_LEDGER_TABLE}"`);
        expect(statements.slice(1)).toEqual([
          `SELECT "tag" FROM "${MIGRATIONS_LEDGER_TABLE}"`,
          `INSERT INTO "${MIGRATIONS_LEDGER_TABLE}" ("tag") VALUES ($1) :: 20260527_a`,
          "BEGIN",
          'ALTER TABLE "a" ADD COLUMN "x" integer;',
          `INSERT INTO "${MIGRATIONS_LEDGER_TABLE}" ("tag") VALUES ($1) :: 20260906_b`,
          "COMMIT",
          "BEGIN",
          'ALTER TABLE "a" ADD COLUMN "y" integer;',
          'ALTER TABLE "a" ADD COLUMN "z" integer;',
          `INSERT INTO "${MIGRATIONS_LEDGER_TABLE}" ("tag") VALUES ($1) :: 20260918_c`,
          "COMMIT",
        ]);
        expect(logs).toEqual([
          "seeded 20260527_a as already applied (baseline)",
          "applied 20260906_b (1 statement)",
          "applied 20260918_c (2 statements)",
        ]);
      }),
    );
  });
});
