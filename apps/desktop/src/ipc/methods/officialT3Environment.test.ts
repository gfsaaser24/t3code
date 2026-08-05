import type { DesktopOfficialT3ImportResult } from "@t3tools/contracts";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import type * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import { runOfficialT3Import } from "./officialT3Environment.ts";

const targetBaseDir = "C:/Users/test/.t3-turbo";

const idleActivity = {
  activeProviderSessions: 0,
  activeProjectedSessions: 0,
  activeTurns: 0,
  pendingApprovals: 0,
};

const planStdout = JSON.stringify({
  workspace: {
    directory: `${targetBaseDir}/userdata/.t3-turbo-import-test`,
    sourceActivity: idleActivity,
    targetActivity: idleActivity,
  },
  plan: { threads: [] },
});

const applyStdout = JSON.stringify({
  importedEventCount: 3,
  copiedAttachmentCount: 1,
  receiptPath: `${targetBaseDir}/userdata/.t3-turbo-import-test/receipt.json`,
});

const makeEnvironment = () =>
  DesktopEnvironment.DesktopEnvironment.of({
    isDevelopment: false,
    homeDirectory: "C:/Users/test",
    baseDir: targetBaseDir,
    backendEntryPath: "C:/app/apps/server/dist/bin.mjs",
    backendCwd: "C:/app",
    path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

const mockProcess = (input: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(new TextEncoder().encode(input.stdout)),
    stderr: Stream.make(new TextEncoder().encode(input.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

// The primary backend instance records stop/start into `events` so tests can
// assert importer CLI runs are ordered strictly inside the stopped window.
const primaryInstance = (events: string[]): DesktopBackendManager.DesktopBackendInstance => ({
  id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
  label: Effect.succeed("Windows"),
  start: Effect.sync(() => {
    events.push("backend:start");
  }),
  stop: () =>
    Effect.sync(() => {
      events.push("backend:stop");
    }),
  currentConfig: Effect.succeed(Option.none()),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(1),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
});

const spawnerLayer = (
  events: string[],
  resultFor: (mode: "plan" | "apply") => { exitCode: number; stdout: string; stderr: string },
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
      const mode = args.includes("apply") ? "apply" : "plan";
      events.push(`importer:${mode}`);
      return Effect.succeed(mockProcess(resultFor(mode)));
    }),
  );

const testLayer = (
  events: string[],
  resultFor: (mode: "plan" | "apply") => { exitCode: number; stdout: string; stderr: string },
) =>
  Layer.mergeAll(
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, makeEnvironment()),
    FileSystem.layerNoop({
      exists: () => Effect.succeed(true),
      makeDirectory: () => Effect.void,
      remove: () => Effect.void,
    }),
    Path.layer,
    spawnerLayer(events, resultFor),
    DesktopBackendPool.layerTest([primaryInstance(events)]),
  );

describe("runOfficialT3Import", () => {
  // Regression: the importer CLI acquires the same official-import lock the
  // running backend holds for its entire lifetime, so every importer
  // invocation — including the planning pass — must happen between
  // primary.stop() and primary.start.
  it.effect("stops the backend before the first importer invocation", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const result = (yield* runOfficialT3Import.handler({})) as DesktopOfficialT3ImportResult;
      assert.equal(result.status, "imported");
      assert.deepEqual(events, [
        "backend:stop",
        "importer:plan",
        "importer:apply",
        "backend:start",
      ]);
    }).pipe(
      Effect.provide(
        testLayer(events, (mode) =>
          mode === "plan"
            ? { exitCode: 0, stdout: planStdout, stderr: "" }
            : { exitCode: 0, stdout: applyStdout, stderr: "" },
        ),
      ),
    );
  });

  it.effect("restarts the backend when the importer fails", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const result = (yield* runOfficialT3Import.handler({})) as DesktopOfficialT3ImportResult;
      assert.ok(result.status === "blocked" && result.reason === "import-failed");
      assert.deepEqual(events, ["backend:stop", "importer:plan", "backend:start"]);
    }).pipe(
      Effect.provide(
        testLayer(events, () => ({
          exitCode: 1,
          stdout: "",
          stderr: "OfficialImportLockError: Official import is already locked",
        })),
      ),
    );
  });
});
