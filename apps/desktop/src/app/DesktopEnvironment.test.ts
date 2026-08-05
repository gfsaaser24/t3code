import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Turbo.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Turbo.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironmentLayer = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(env))));

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(makeEnvironmentLayer(overrides, env)));

const portablePath = (value: string) => value.replaceAll("\\", "/").replace(/^[A-Z]:\//u, "/");
const portablePathOption = Option.map(portablePath);

describe("DesktopEnvironment", () => {
  it.effect("derives state paths and development identity inside Effect", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_HOME: " /tmp/t3 ",
          T3CODE_COMMIT_HASH: " 0123456789abcdef ",
          T3CODE_PORT: "4949",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH: " /remote/server.mjs ",
          T3CODE_OTLP_TRACES_URL: " http://127.0.0.1:4318/v1/traces ",
          T3CODE_OTLP_EXPORT_INTERVAL_MS: "2500",
        },
      );

      assert.equal(environment.isDevelopment, true);
      assert.equal(
        portablePath(environment.appDataDirectory),
        "/Users/alice/Library/Application Support",
      );
      assert.equal(portablePath(environment.baseDir), "/tmp/t3");
      assert.equal(portablePath(environment.stateDir), "/tmp/t3/userdata");
      assert.equal(
        portablePath(environment.desktopSettingsPath),
        "/tmp/t3/userdata/desktop-settings.json",
      );
      assert.equal(
        portablePath(environment.clientSettingsPath),
        "/tmp/t3/userdata/client-settings.json",
      );
      assert.equal(
        portablePath(environment.savedEnvironmentRegistryPath),
        "/tmp/t3/userdata/saved-environments.json",
      );
      assert.equal(portablePath(environment.serverSettingsPath), "/tmp/t3/userdata/settings.json");
      assert.equal(portablePath(environment.logDir), "/tmp/t3/userdata/logs");
      assert.equal(
        portablePath(environment.browserArtifactsDir),
        "/tmp/t3/userdata/browser-artifacts",
      );
      assert.equal(portablePath(environment.rootDir), "/repo");
      assert.equal(portablePath(environment.appRoot), "/repo");
      assert.equal(portablePath(environment.backendEntryPath), "/repo/apps/server/dist/bin.mjs");
      assert.equal(portablePath(environment.backendCwd), "/repo");
      assert.equal(environment.displayName, "T3 Turbo (Dev)");
      assert.equal(environment.branding.releaseRepository, "gfsaaser24/t3code");
      assert.equal(environment.appUserModelId, "com.gabef.t3turbo.dev");
      assert.equal(environment.linuxDesktopEntryName, "t3-turbo-dev.desktop");
      assert.equal(environment.linuxWmClass, "t3-turbo-dev");
      assert.equal(environment.userDataDirName, "t3-turbo-dev");
      assert.equal(environment.legacyUserDataDirName, "T3-Turbo (Dev)");
      assert.deepEqual(
        Option.map(environment.devServerUrl, (url) => url.href),
        Option.some("http://localhost:5173/"),
      );
      assert.deepEqual(environment.devRemoteT3ServerEntryPath, Option.some("/remote/server.mjs"));
      assert.deepEqual(environment.configuredBackendPort, Option.some(4949));
      assert.deepEqual(environment.commitHashOverride, Option.some("0123456789abcdef"));
      assert.deepEqual(environment.otlpTracesUrl, Option.some("http://127.0.0.1:4318/v1/traces"));
      assert.equal(environment.otlpExportIntervalMs, 2500);
    }),
  );

  it.effect("stores production state under userdata in an explicit home", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_HOME: "/tmp/t3",
        },
      );

      assert.equal(environment.isDevelopment, false);
      assert.equal(portablePath(environment.stateDir), "/tmp/t3/userdata");
      assert.equal(portablePath(environment.logDir), "/tmp/t3/userdata/logs");
      assert.equal(
        portablePath(environment.browserArtifactsDir),
        "/tmp/t3/userdata/browser-artifacts",
      );
      assert.equal(portablePath(environment.serverSettingsPath), "/tmp/t3/userdata/settings.json");
    }),
  );

  it.effect("keeps implicit Turbo development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment({
        appVersion: "0.0.22-nightly.20260802.1",
        isPackaged: true,
      });

      assert.equal(portablePath(development.baseDir), "/Users/alice/.t3-turbo");
      assert.equal(portablePath(development.stateDir), "/Users/alice/.t3-turbo/dev");
      assert.equal(portablePath(production.baseDir), "/Users/alice/.t3-turbo");
      assert.equal(portablePath(production.stateDir), "/Users/alice/.t3-turbo/userdata");
      assert.equal(production.displayName, "T3 Turbo");
      assert.equal(production.branding.releaseRepository, "gfsaaser24/t3code");
      assert.equal(production.appUserModelId, "com.gabef.t3turbo");
      assert.equal(production.linuxDesktopEntryName, "t3-turbo.desktop");
      assert.equal(production.linuxWmClass, "t3-turbo");
      assert.equal(production.userDataDirName, "t3-turbo");
      assert.equal(production.legacyUserDataDirName, "T3-Turbo");
    }),
  );

  it.effect("uses a configured app user model id override", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_DESKTOP_APP_USER_MODEL_ID: " com.example.t3turbo.dev.local ",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
        },
      );

      assert.equal(environment.appUserModelId, "com.example.t3turbo.dev.local");
    }),
  );

  it.effect("resolves picker defaults without nullish sentinels", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();

      assert.deepEqual(environment.resolvePickFolderDefaultPath(null), Option.none());
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: " " }),
        Option.none(),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~" }).pipe(portablePathOption),
        Option.some("/Users/alice"),
      );
      assert.deepEqual(
        environment
          .resolvePickFolderDefaultPath({ initialPath: "~/project" })
          .pipe(portablePathOption),
        Option.some("/Users/alice/project"),
      );
    }),
  );
});
