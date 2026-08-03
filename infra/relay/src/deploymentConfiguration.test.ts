import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { ApnsCredentialsConfig } from "./Config.ts";
import { ExternalDatabaseConfiguration } from "./db.ts";
import { AxiomConfiguration } from "./observability.ts";

const readDeploymentConfiguration = (env: Record<string, string>) =>
  Effect.all({
    apns: ApnsCredentialsConfig,
    axiom: AxiomConfiguration,
    database: ExternalDatabaseConfiguration,
  }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

describe("optional relay deployment configuration", () => {
  it.effect("treats empty GitHub settings as disabled", () =>
    Effect.gen(function* () {
      const configuration = yield* readDeploymentConfiguration({
        APNS_ENVIRONMENT: "",
        AXIOM_ORG_ID: "",
        AXIOM_TOKEN: "",
        DATABASE_HOST: "",
        DATABASE_PASSWORD: "",
      });

      expect(configuration.apns).toBeNull();
      expect(Option.isNone(configuration.axiom)).toBe(true);
      expect(Option.isNone(configuration.database)).toBe(true);
    }),
  );

  it.effect("reads complete Supabase, Axiom, and APNs settings", () =>
    Effect.gen(function* () {
      const configuration = yield* readDeploymentConfiguration({
        DATABASE_HOST: "pooler.example.test",
        DATABASE_PORT: "5432",
        DATABASE_NAME: "postgres",
        DATABASE_USER: "postgres.project-ref",
        DATABASE_PASSWORD: "database-password",
        AXIOM_ORG_ID: "axiom-org",
        AXIOM_TOKEN: "axiom-token",
        APNS_ENVIRONMENT: "production",
        APNS_TEAM_ID: "team-id",
        APNS_KEY_ID: "key-id",
        APNS_BUNDLE_ID: "codes.t3.app",
        APNS_PRIVATE_KEY: "private-key",
      });

      expect(configuration.apns?.environment).toBe("production");
      expect(Option.isSome(configuration.axiom)).toBe(true);
      expect(Option.map(configuration.database, ({ password, ...database }) => database)).toEqual(
        Option.some({
          host: "pooler.example.test",
          port: 5432,
          database: "postgres",
          user: "postgres.project-ref",
        }),
      );
      expect(
        Option.map(configuration.database, ({ password }) => Redacted.value(password)),
      ).toEqual(Option.some("database-password"));
    }),
  );
});
