import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Planetscale from "alchemy/Planetscale";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { relayDatabaseMode } from "./dbConfig.ts";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
  }
>()("t3code-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
      });
    }),
  );
}

const externalDatabaseConfiguration = Config.all({
  host: Config.nonEmptyString("DATABASE_HOST"),
  port: Config.port("DATABASE_PORT").pipe(Config.withDefault(5432)),
  database: Config.nonEmptyString("DATABASE_NAME"),
  user: Config.nonEmptyString("DATABASE_USER"),
  password: Config.nonEmptyString("DATABASE_PASSWORD").pipe(Config.map(Redacted.make)),
});

export const ExternalDatabaseConfiguration = externalDatabaseConfiguration.pipe(
  Config.map(Option.some),
  // Empty GitHub variables mean "not configured" and retain the upstream PlanetScale path.
  Config.orElse(() =>
    Config.succeed(Option.none<Config.Success<typeof externalDatabaseConfiguration>>()),
  ),
);

export const PlanetscaleDatabase = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const schema = yield* Drizzle.Schema("RelaySchema", {
    schema: "./src/persistence/schema.ts",
    out: "./migrations/postgres",
    dialect: "postgres",
  });

  const mode = relayDatabaseMode(stage);
  const database =
    mode === "shared-database"
      ? yield* Planetscale.PostgresDatabase("RelayPostgresDatabase", {
          name: "t3coderelay",
          region: { slug: "us-west" },
          clusterSize: "PS_20",
          migrationsDir: schema.out,
          migrationsTable: "relay_migrations",
          replicas: 2,
        }).pipe(RemovalPolicy.retain())
      : yield* Planetscale.PostgresDatabase.ref("RelayPostgresDatabase", {
          stage: "prod",
        });
  const branch =
    mode === "stage-branch"
      ? yield* Planetscale.PostgresBranch("RelayPostgresBranch", {
          database,
          migrationsDir: schema.out,
          migrationsTable: "relay_migrations",
        })
      : undefined;

  const runtimeRole = yield* Planetscale.PostgresRole("RelayPostgresRuntimeRole", {
    database,
    ...(branch ? { branch } : {}),
    inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
  });

  return { branch, database, runtimeRole };
});

export const RelayDatabase = Effect.gen(function* () {
  const external = yield* ExternalDatabaseConfiguration;
  if (Option.isSome(external)) {
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connection("RelayHyperdrive", {
      origin: {
        scheme: "postgres",
        ...external.value,
      },
      mtls: { sslmode: "require" },
      caching: {
        disabled: true,
      },
      originConnectionLimit: 20,
    });
    return {
      databaseName: external.value.database,
      databaseBranchName: "external",
      hyperdrive,
    } as const;
  }

  // Preserve the managed PlanetScale deployment for upstream-compatible environments.
  const { database, branch, runtimeRole } = yield* PlanetscaleDatabase;
  const hyperdrive = yield* Cloudflare.Hyperdrive.Connection("RelayHyperdrive", {
    origin: runtimeRole.origin,
    caching: {
      disabled: true,
    },
    originConnectionLimit: 20,
  });
  return {
    databaseName: database.name,
    databaseBranchName: branch?.name ?? "main",
    hyperdrive,
  } as const;
});

export const RelayHyperdrive = RelayDatabase.pipe(Effect.map(({ hyperdrive }) => hyperdrive));
