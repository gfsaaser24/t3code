/**
 * T3 Turbo: apply `infra/relay/migrations/postgres` to the self-hosted Supabase Postgres.
 *
 * The external-database path provisions Hyperdrive only; Alchemy's Planetscale migrator never
 * runs against it. This script closes that gap in `deploy-relay.yml`: every migration folder is
 * applied once, in name order, inside its own transaction, and recorded in
 * `relay_external_migrations`. A database whose schema predates this script is seeded with
 * `RELAY_EXTERNAL_MIGRATIONS_BASELINE=<tag>`: on the first run against an empty ledger, every
 * folder up to and including that tag is marked applied without executing it.
 *
 * Usage: `node infra/relay/scripts/apply-external-migrations.ts` with `DATABASE_HOST`, `DATABASE_PORT`,
 * `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD` in the environment. Without
 * `DATABASE_HOST` it exits 0 (managed PlanetScale path; Alchemy migrates that itself).
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
export const MIGRATIONS_LEDGER_TABLE = "relay_external_migrations";

/** Splits a Drizzle-generated migration file into its statements, dropping empty ones. */
export function splitMigrationStatements(sql: string): ReadonlyArray<string> {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export interface MigrationPlan {
  /** Folder tags to record as applied without executing (baseline seeding). */
  readonly seed: ReadonlyArray<string>;
  /** Folder tags to execute, in order. */
  readonly run: ReadonlyArray<string>;
}

/**
 * Decides what to do with each migration folder. `tags` are folder names; `applied` are ledger
 * rows. The baseline only applies to an empty ledger so a seeded database can never skip a later
 * migration by accident.
 */
export function planMigrations(input: {
  readonly tags: ReadonlyArray<string>;
  readonly applied: ReadonlyArray<string>;
  readonly baselineTag?: string | undefined;
}): MigrationPlan {
  const ordered = [...input.tags].sort();
  const applied = new Set(input.applied);
  const seed: string[] = [];
  const run: string[] = [];
  const baselineTag = input.baselineTag;
  const seeding = applied.size === 0 && baselineTag !== undefined;
  for (const tag of ordered) {
    if (applied.has(tag)) continue;
    if (seeding && tag <= baselineTag) {
      seed.push(tag);
      continue;
    }
    run.push(tag);
  }
  return { seed, run };
}

/** Raised after a migration transaction rolls back, so the deploy step stops on the failed tag. */
export class MigrationRolledBackError extends Schema.TaggedError<MigrationRolledBackError>()(
  "MigrationRolledBackError",
  { tag: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `migration ${this.tag} failed and was rolled back: ${this.reason}`;
  }
}

interface LedgerRow {
  readonly tag: unknown;
}

/**
 * The slice of `PgClient` this script needs. Narrowing it keeps `applyMigrations` testable against
 * an in-memory fake while a real `PgClient` still satisfies it structurally.
 */
export interface MigrationSqlClient<E = never> {
  readonly unsafe: (
    statement: string,
    params?: ReadonlyArray<unknown> | undefined,
  ) => Effect.Effect<ReadonlyArray<LedgerRow>, E>;
  readonly withTransaction: <A, E2, R>(
    effect: Effect.Effect<A, E2, R>,
  ) => Effect.Effect<A, E2 | E, R>;
}

/**
 * Creates the ledger, seeds the baseline, then runs each pending folder in its own transaction.
 * Every action logs one line so the deploy log records what the database actually got.
 */
export const applyMigrations = <E>(input: {
  readonly sql: MigrationSqlClient<E>;
  readonly migrationsDir: string;
  readonly baselineTag?: string | undefined;
}) =>
  Effect.gen(function* () {
    const { migrationsDir, sql } = input;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_LEDGER_TABLE}" ("tag" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`,
    );
    const ledger = yield* sql.unsafe(`SELECT "tag" FROM "${MIGRATIONS_LEDGER_TABLE}"`);
    const applied = ledger.map((row) => String(row.tag));

    const entries = yield* fileSystem.readDirectory(migrationsDir);
    const tags: Array<string> = [];
    for (const entry of entries.sort()) {
      const hasMigration = yield* fileSystem.exists(
        path.join(migrationsDir, entry, "migration.sql"),
      );
      if (hasMigration) tags.push(entry);
    }
    const plan = planMigrations({ tags, applied, baselineTag: input.baselineTag });

    for (const tag of plan.seed) {
      yield* sql.unsafe(`INSERT INTO "${MIGRATIONS_LEDGER_TABLE}" ("tag") VALUES ($1)`, [tag]);
      yield* Effect.log(`seeded ${tag} as already applied (baseline)`);
    }
    for (const tag of plan.run) {
      const source = yield* fileSystem.readFileString(
        path.join(migrationsDir, tag, "migration.sql"),
      );
      const statements = splitMigrationStatements(source);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            for (const statement of statements) {
              yield* sql.unsafe(statement);
            }
            yield* sql.unsafe(`INSERT INTO "${MIGRATIONS_LEDGER_TABLE}" ("tag") VALUES ($1)`, [
              tag,
            ]);
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.fail(new MigrationRolledBackError({ tag, reason: Cause.pretty(cause) })),
          ),
        );
      yield* Effect.log(
        `applied ${tag} (${statements.length} statement${statements.length === 1 ? "" : "s"})`,
      );
    }
    if (plan.seed.length === 0 && plan.run.length === 0) {
      yield* Effect.log("no pending migrations");
    }
  });

const optionalString = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map((value) =>
      Option.filter(value, (candidate) => candidate.trim().length > 0).pipe(Option.getOrUndefined),
    ),
  );

const main = Effect.gen(function* () {
  const host = yield* optionalString("DATABASE_HOST");
  if (host === undefined) {
    yield* Effect.log(
      "DATABASE_HOST is not set; skipping external migrations (managed database path).",
    );
    return;
  }
  const port = yield* Config.Port("DATABASE_PORT").pipe(Config.withDefault(5432));
  const database = yield* Config.String("DATABASE_NAME").pipe(Config.withDefault("postgres"));
  const username = yield* Config.String("DATABASE_USER").pipe(Config.withDefault("postgres"));
  const password = yield* Config.Redacted("DATABASE_PASSWORD");
  const baselineTag = yield* optionalString("RELAY_EXTERNAL_MIGRATIONS_BASELINE");

  const path = yield* Path.Path;
  const migrationsDir = yield* path.fromFileUrl(new URL("../migrations/postgres", import.meta.url));

  yield* Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* applyMigrations({ sql, migrationsDir, baselineTag });
  }).pipe(
    Effect.provide(
      PgClient.layer({
        host,
        port,
        database,
        username,
        password,
        // Matches the Hyperdrive origin (`sslmode: "require"`): encrypted, no CA verification.
        ssl: { rejectUnauthorized: false },
        connectTimeout: Duration.seconds(15),
      }),
    ),
  );
});

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
