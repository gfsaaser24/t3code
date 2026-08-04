import {
  DesktopOfficialT3ImportInputSchema,
  DesktopOfficialT3ImportResultSchema,
  DesktopOfficialT3ImportAvailabilitySchema,
  type DesktopOfficialT3ImportAvailability,
  type DesktopOfficialT3ImportResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { discoverOfficialT3ImportAvailability } from "../../app/OfficialT3EnvironmentDiscovery.ts";
import { classifyPreparedOfficialT3Import } from "../../app/OfficialT3ImportPlan.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const ImportActivitySchema = Schema.Struct({
  activeProviderSessions: Schema.Number,
  activeProjectedSessions: Schema.Number,
  activeTurns: Schema.Number,
  pendingApprovals: Schema.Number,
});

const PreparedImportSummarySchema = Schema.Struct({
  workspace: Schema.Struct({
    directory: Schema.String,
    sourceActivity: ImportActivitySchema,
    targetActivity: ImportActivitySchema,
  }),
  plan: Schema.Struct({
    threads: Schema.Array(
      Schema.Struct({
        sourceThreadId: Schema.String,
        action: Schema.String,
      }),
    ),
  }),
});

const ApplyResultSchema = Schema.Struct({
  importedEventCount: Schema.Number,
  copiedAttachmentCount: Schema.Number,
  receiptPath: Schema.String,
});

const CollisionChoicesSchema = Schema.Record(
  Schema.String,
  Schema.Literals(["skip", "replace", "clone"]),
);

const decodePreparedImport = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PreparedImportSummarySchema),
);
const decodeApplyResult = Schema.decodeUnknownEffect(Schema.fromJsonString(ApplyResultSchema));
const encodeCollisionChoices = Schema.encodeEffect(Schema.fromJsonString(CollisionChoicesSchema));
type PreparedImportSummary = typeof PreparedImportSummarySchema.Type;

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

let importInProgress = false;

const concatChunks = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const decodeOutput = (chunks: ReadonlyArray<Uint8Array>): string =>
  new TextDecoder().decode(concatChunks(chunks));

const runImporterCli = Effect.fn("desktop.officialT3Import.runCli")(function* (
  args: ReadonlyArray<string>,
): Effect.fn.Return<
  CliResult,
  never,
  DesktopEnvironment.DesktopEnvironment | ChildProcessSpawner.ChildProcessSpawner
> {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(process.execPath, [environment.backendEntryPath, ...args], {
    cwd: environment.backendCwd,
    env: { ELECTRON_RUN_AS_NODE: "1", T3CODE_HOME: undefined },
    extendEnv: true,
    stdout: "pipe",
    stderr: "pipe",
  });

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawned = yield* spawner.spawn(command).pipe(Effect.result);
      if (spawned._tag === "Failure") {
        return { exitCode: 127, stdout: "", stderr: spawned.failure.message };
      }
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.runCollect(spawned.success.stdout),
          Stream.runCollect(spawned.success.stderr),
          spawned.success.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return {
        exitCode: Number(exitCode),
        stdout: decodeOutput(stdout),
        stderr: decodeOutput(stderr),
      };
    }),
  ).pipe(
    Effect.catch((cause) => Effect.succeed({ exitCode: 127, stdout: "", stderr: cause.message })),
  );
});

const commandFailureMessage = (result: CliResult): string => {
  const output = `${result.stderr}\n${result.stdout}`.trim();
  return output.length === 0
    ? `The importer exited with code ${result.exitCode}.`
    : output.slice(-2_000);
};

const blockedResult = (
  availability: DesktopOfficialT3ImportAvailability,
  reason: "source-active" | "target-active" | "import-failed",
  message: string,
): DesktopOfficialT3ImportResult => ({
  status: "blocked",
  reason,
  message,
  runCommand: availability.runCommand,
  planCommand: availability.planCommand,
});

const removePreparedWorkspace = Effect.fn("desktop.officialT3Import.removePreparedWorkspace")(
  function* (availability: DesktopOfficialT3ImportAvailability, directory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const expectedParent = path.resolve(availability.targetBaseDir, "userdata");
    if (
      path.resolve(path.dirname(directory)) !== expectedParent ||
      !path.basename(directory).startsWith(".t3-turbo-import-")
    ) {
      return;
    }
    yield* fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore);
  },
);

type ImportPlanOutcome =
  | { readonly _tag: "Blocked"; readonly result: DesktopOfficialT3ImportResult }
  | {
      readonly _tag: "Prepared";
      readonly prepared: PreparedImportSummary;
      readonly planPath: string;
      readonly choicesPath: string | null;
    };

const prepareImportPlan = Effect.fn("desktop.officialT3Import.preparePlan")(function* (
  availability: DesktopOfficialT3ImportAvailability,
  collisionChoices: Readonly<Record<string, "skip" | "replace" | "clone">> | undefined,
): Effect.fn.Return<
  ImportPlanOutcome,
  PlatformError.PlatformError | Schema.SchemaError,
  | DesktopEnvironment.DesktopEnvironment
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const createdAt = DateTime.formatIso(yield* DateTime.now).replaceAll(/[-:.]/g, "");
  const importDirectory = path.join(availability.targetBaseDir, "official-import");
  const planPath = path.join(importDirectory, `desktop-plan-${createdAt}.json`);
  const choicesPath = path.join(importDirectory, `desktop-choices-${createdAt}.json`);
  yield* fs.makeDirectory(importDirectory, { recursive: true }).pipe(Effect.ignore);

  const planArgs = [
    "import",
    "official",
    "plan",
    "--source-base-dir",
    availability.sourceBaseDir,
    "--target-base-dir",
    availability.targetBaseDir,
    "--out",
    planPath,
    "--json",
  ];
  if (collisionChoices !== undefined) {
    yield* fs.writeFileString(choicesPath, yield* encodeCollisionChoices(collisionChoices));
    planArgs.push("--choices", choicesPath);
  }

  const planRun = yield* runImporterCli(planArgs);
  if (planRun.exitCode !== 0) {
    return {
      _tag: "Blocked",
      result: blockedResult(availability, "import-failed", commandFailureMessage(planRun)),
    } as const;
  }
  const decodedPlan = yield* decodePreparedImport(planRun.stdout.trim()).pipe(Effect.result);
  if (decodedPlan._tag === "Failure") {
    return {
      _tag: "Blocked",
      result: blockedResult(
        availability,
        "import-failed",
        "The importer created a plan, but T3 Turbo could not read its typed result. Run the displayed plan command in a terminal for details.",
      ),
    } as const;
  }
  return {
    _tag: "Prepared",
    prepared: decodedPlan.success,
    planPath,
    choicesPath: collisionChoices === undefined ? null : choicesPath,
  } as const;
});

const classifyPreparedPlan = (
  availability: DesktopOfficialT3ImportAvailability,
  prepared: PreparedImportSummary,
): DesktopOfficialT3ImportResult | null => {
  const classification = classifyPreparedOfficialT3Import(prepared);
  if (classification.status === "source-active") {
    return blockedResult(
      availability,
      "source-active",
      "Official T3 Code still has an active chat, turn, or approval. Finish it and quit official T3 Code, then retry.",
    );
  }
  if (classification.status === "target-active") {
    return blockedResult(
      availability,
      "target-active",
      "T3 Turbo still has an active chat, turn, or approval. Let it finish, then retry the import.",
    );
  }
  if (classification.status === "needs-collision-choices") {
    return {
      status: "needs-collision-choices",
      threadIds: classification.threadIds,
      message:
        "These chats have the same ID but different history. Choose whether to keep both, replace the Turbo copy, or skip each chat.",
    };
  }
  return null;
};

const cleanupPreparedPlan = Effect.fn("desktop.officialT3Import.cleanupPreparedPlan")(function* (
  availability: DesktopOfficialT3ImportAvailability,
  prepared: PreparedImportSummary,
  planPath: string,
  choicesPath: string | null,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* removePreparedWorkspace(availability, prepared.workspace.directory);
  yield* fs.remove(planPath, { force: true }).pipe(Effect.ignore);
  if (choicesPath !== null) yield* fs.remove(choicesPath, { force: true }).pipe(Effect.ignore);
});

/** Read-only target/source preflight performed before the desktop stops its backend. */
const preflightImport = Effect.fn("desktop.officialT3Import.preflight")(function* (
  availability: DesktopOfficialT3ImportAvailability,
  collisionChoices: Readonly<Record<string, "skip" | "replace" | "clone">> | undefined,
): Effect.fn.Return<
  DesktopOfficialT3ImportResult | null,
  PlatformError.PlatformError | Schema.SchemaError,
  | DesktopEnvironment.DesktopEnvironment
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
> {
  const outcome = yield* prepareImportPlan(availability, collisionChoices);
  if (outcome._tag === "Blocked") return outcome.result;
  const result = classifyPreparedPlan(availability, outcome.prepared);
  yield* cleanupPreparedPlan(availability, outcome.prepared, outcome.planPath, outcome.choicesPath);
  return result;
});

const executeImport = Effect.fn("desktop.officialT3Import.execute")(function* (
  availability: DesktopOfficialT3ImportAvailability,
  collisionChoices: Readonly<Record<string, "skip" | "replace" | "clone">> | undefined,
): Effect.fn.Return<
  DesktopOfficialT3ImportResult,
  PlatformError.PlatformError | Schema.SchemaError,
  | DesktopEnvironment.DesktopEnvironment
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
> {
  const outcome = yield* prepareImportPlan(availability, collisionChoices);
  if (outcome._tag === "Blocked") return outcome.result;
  const blocking = classifyPreparedPlan(availability, outcome.prepared);
  if (blocking !== null) {
    yield* cleanupPreparedPlan(
      availability,
      outcome.prepared,
      outcome.planPath,
      outcome.choicesPath,
    );
    return blocking;
  }

  return yield* Effect.gen(function* () {
    const applyRun = yield* runImporterCli([
      "import",
      "official",
      "apply",
      "--plan",
      outcome.planPath,
      "--json",
    ]);
    if (applyRun.exitCode !== 0) {
      yield* cleanupPreparedPlan(
        availability,
        outcome.prepared,
        outcome.planPath,
        outcome.choicesPath,
      );
      return blockedResult(availability, "import-failed", commandFailureMessage(applyRun));
    }
    const decodedResult = yield* decodeApplyResult(applyRun.stdout.trim()).pipe(Effect.result);
    if (decodedResult._tag === "Failure") {
      yield* removePreparedWorkspace(availability, outcome.prepared.workspace.directory);
      return blockedResult(
        availability,
        "import-failed",
        "The import finished, but T3 Turbo could not read its result. Restart Turbo and use the displayed plan command to inspect the import state.",
      );
    }
    yield* cleanupPreparedPlan(
      availability,
      outcome.prepared,
      outcome.planPath,
      outcome.choicesPath,
    );
    return { status: "imported", ...decodedResult.success } as const;
  }).pipe(
    Effect.onError(() =>
      cleanupPreparedPlan(availability, outcome.prepared, outcome.planPath, outcome.choicesPath),
    ),
  );
});

export const discoverOfficialT3Import = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCOVER_OFFICIAL_T3_IMPORT_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopOfficialT3ImportAvailabilitySchema),
  handler: Effect.fn("desktop.ipc.officialT3Import.discover")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.isDevelopment) return null;
    return yield* discoverOfficialT3ImportAvailability({
      sourceBaseDir: environment.path.join(environment.homeDirectory, ".t3"),
      targetBaseDir: environment.baseDir,
    });
  }),
});

export const runOfficialT3Import = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RUN_OFFICIAL_T3_IMPORT_CHANNEL,
  payload: DesktopOfficialT3ImportInputSchema,
  result: DesktopOfficialT3ImportResultSchema,
  handler: Effect.fn("desktop.ipc.officialT3Import.run")(function* (input) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.isDevelopment) {
      return {
        status: "blocked",
        reason: "import-failed",
        message:
          "The packaged database importer is disabled in desktop development mode so it cannot target the wrong Turbo database. Run the displayed command against explicit source and target directories.",
        runCommand: "t3 import official run",
        planCommand: "t3 import official plan",
      } as const;
    }
    const availability = yield* discoverOfficialT3ImportAvailability({
      sourceBaseDir: environment.path.join(environment.homeDirectory, ".t3"),
      targetBaseDir: environment.baseDir,
    });
    if (availability === null) {
      return {
        status: "blocked",
        reason: "import-failed",
        message: "No separate official T3 Code database was found on this computer.",
        runCommand: "t3 import official run",
        planCommand: "t3 import official plan",
      } as const;
    }

    const acquired = yield* Effect.sync(() => {
      if (importInProgress) return false;
      importInProgress = true;
      return true;
    });
    if (!acquired) {
      return blockedResult(
        availability,
        "import-failed",
        "An official T3 Code import is already running in another T3 Turbo window.",
      );
    }

    return yield* Effect.gen(function* () {
      const preflight = yield* preflightImport(availability, input.collisionChoices);
      if (preflight !== null) return preflight;

      const pool = yield* DesktopBackendPool.DesktopBackendPool;
      const primary = yield* pool.primary;
      const snapshot = yield* primary.snapshot;
      yield* primary.stop();
      return yield* executeImport(availability, input.collisionChoices).pipe(
        Effect.ensuring(snapshot.desiredRunning ? primary.start : Effect.void),
      );
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(
          blockedResult(
            availability,
            "import-failed",
            `The direct importer could not run: ${cause.message}`,
          ),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          importInProgress = false;
        }),
      ),
    );
  }),
});
