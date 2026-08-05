// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import {
  OfficialImportCollisionChoice,
  OfficialImportIdMap,
} from "../turbo/officialImport/plan.ts";
import {
  OfficialImportApplyResult,
  PreparedOfficialImport,
  applyPreparedOfficialImport,
  prepareOfficialImport,
} from "../turbo/officialImport/execute.ts";
import {
  ImportRestoreReceipt,
  RESTORE_CONFIRMATION,
  removeImportWorkspace,
  restoreImportBackup,
} from "../turbo/officialImport/storage.ts";

const CollisionChoices = Schema.Record(Schema.String, OfficialImportCollisionChoice);
const encodePreparedImport = Schema.encodeEffect(fromJsonStringPretty(PreparedOfficialImport));
const decodePreparedImport = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PreparedOfficialImport),
);
const decodeCollisionChoices = Schema.decodeUnknownEffect(Schema.fromJsonString(CollisionChoices));
const encodeApplyResult = Schema.encodeEffect(fromJsonStringPretty(OfficialImportApplyResult));
const encodeRestoreResult = Schema.encodeEffect(
  fromJsonStringPretty(
    Schema.Struct({ receipt: ImportRestoreReceipt, receiptPath: Schema.String }),
  ),
);

const defaultSourceBaseDir = NodePath.join(NodeOS.homedir(), ".t3");
const defaultTargetBaseDir = NodePath.join(NodeOS.homedir(), ".t3-turbo");

const sourceBaseDirFlag = Flag.string("source-base-dir").pipe(
  Flag.withDescription("Official T3 base directory (opened read-only)."),
  Flag.withDefault(defaultSourceBaseDir),
);
const targetBaseDirFlag = Flag.string("target-base-dir").pipe(
  Flag.withDescription("T3 Turbo base directory that receives the verified import."),
  Flag.withDefault(defaultTargetBaseDir),
);
const choicesFlag = Flag.string("choices").pipe(
  Flag.withDescription(
    "Optional JSON file mapping colliding official thread IDs to skip/replace/clone.",
  ),
  Flag.optional,
);
const outputFlag = Flag.string("out").pipe(
  Flag.withDescription("Optional plan/result JSON output path."),
  Flag.optional,
);
const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Print the complete JSON document."),
  Flag.withDefault(false),
);
const allowActiveFlag = Flag.boolean("allow-active").pipe(
  Flag.withDescription(
    "Proceed even when a database still records an active session, turn, or approval. Use only when both apps are fully closed — e.g. a stale session left behind by an uninstalled official T3 Code.",
  ),
  Flag.withDefault(false),
);

const safeTimestamp = (iso: string) => iso.replaceAll(/[-:.]/g, "");

const databasePathForBaseDir = Effect.fn("officialImportDatabasePathForBaseDir")(function* (
  baseDir: string,
) {
  const path = yield* Path.Path;
  return path.join(path.resolve(baseDir), "userdata", "state.sqlite");
});

const readOptionalChoices = Effect.fn("readOfficialImportChoices")(function* (
  choicePath: Option.Option<string>,
) {
  if (Option.isNone(choicePath)) return undefined;
  const fs = yield* FileSystem.FileSystem;
  const encoded = yield* fs.readFileString(choicePath.value);
  return yield* decodeCollisionChoices(encoded);
});

const readPriorIdMap = Effect.fn("readPriorOfficialImportIdMap")(function* (targetBaseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statePath = path.join(path.resolve(targetBaseDir), "official-import", "last-plan.json");
  if (!(yield* fs.exists(statePath))) return undefined;
  const encoded = yield* fs.readFileString(statePath);
  const previous = yield* decodePreparedImport(encoded);
  return previous.plan.idMap;
});

const writeStringAtomic = Effect.fn("writeOfficialImportFileAtomic")(function* (
  filePath: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  yield* fs.writeFileString(temporaryPath, contents);
  yield* fs.rename(temporaryPath, filePath);
});

const persistLastPlan = Effect.fn("persistLastOfficialImportPlan")(function* (
  targetBaseDir: string,
  prepared: PreparedOfficialImport,
) {
  const path = yield* Path.Path;
  const encoded = yield* encodePreparedImport(prepared);
  yield* writeStringAtomic(
    path.join(path.resolve(targetBaseDir), "official-import", "last-plan.json"),
    encoded,
  );
});

const prepareFromFlags = Effect.fn("prepareOfficialImportFromFlags")(function* (flags: {
  readonly sourceBaseDir: string;
  readonly targetBaseDir: string;
  readonly choices: Option.Option<string>;
}) {
  const [sourceDatabasePath, targetDatabasePath, collisionChoices, existingIdMap] =
    yield* Effect.all([
      databasePathForBaseDir(flags.sourceBaseDir),
      databasePathForBaseDir(flags.targetBaseDir),
      readOptionalChoices(flags.choices),
      readPriorIdMap(flags.targetBaseDir),
    ]);
  return yield* prepareOfficialImport({
    sourceDatabasePath,
    targetDatabasePath,
    ...(collisionChoices === undefined ? {} : { collisionChoices }),
    ...(existingIdMap === undefined
      ? {}
      : { existingIdMap: existingIdMap satisfies OfficialImportIdMap }),
  });
});

const summarizePlan = (prepared: PreparedOfficialImport): string => {
  const actionCounts = new Map<string, number>();
  for (const thread of prepared.plan.threads) {
    actionCounts.set(thread.action, (actionCounts.get(thread.action) ?? 0) + 1);
  }
  const actions = Array.from(actionCounts.entries())
    .map(([action, count]) => `${action}=${count}`)
    .join(", ");
  return [
    `Official projects: ${prepared.plan.projects.length}`,
    `Official chats: ${prepared.plan.threads.length} (${actions || "none"})`,
    `Source snapshot: ${prepared.workspace.sourceSnapshotPath}`,
    `Turbo staging: ${prepared.workspace.targetStagingPath}`,
  ].join("\n");
};

const defaultPlanPath = Effect.fn("defaultOfficialImportPlanPath")(function* (
  targetBaseDir: string,
  createdAt: string,
) {
  const path = yield* Path.Path;
  return path.join(
    path.resolve(targetBaseDir),
    "official-import",
    `plan-${safeTimestamp(createdAt)}.json`,
  );
});

const planCommand = Command.make("plan", {
  sourceBaseDir: sourceBaseDirFlag,
  targetBaseDir: targetBaseDirFlag,
  choices: choicesFlag,
  out: outputFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Snapshot both databases and create a reviewable, non-mutating import plan.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const prepared = yield* prepareFromFlags(flags);
      const encoded = yield* encodePreparedImport(prepared);
      const planPath = Option.isSome(flags.out)
        ? flags.out.value
        : yield* defaultPlanPath(flags.targetBaseDir, prepared.createdAt);
      yield* writeStringAtomic(planPath, encoded);
      yield* Console.log(flags.json ? encoded : `${summarizePlan(prepared)}\nPlan: ${planPath}`);
    }),
  ),
);

const applyCommand = Command.make("apply", {
  plan: Flag.string("plan").pipe(Flag.withDescription("Reviewed plan JSON created by `plan`.")),
  out: outputFlag,
  json: jsonFlag,
  allowActive: allowActiveFlag,
}).pipe(
  Command.withDescription(
    "Apply a fresh reviewed plan to staging and atomically install it into T3 Turbo.",
  ),
  Command.withHandler(({ plan, out, json, allowActive }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const encodedPlan = yield* fs.readFileString(plan);
      const prepared = yield* decodePreparedImport(encodedPlan);
      const targetBaseDir = NodePath.dirname(
        NodePath.dirname(prepared.workspace.targetDatabasePath),
      );
      yield* persistLastPlan(targetBaseDir, prepared);
      const result = yield* applyPreparedOfficialImport(prepared, { allowActive });
      const encodedResult = yield* encodeApplyResult(result);
      // Stdout carries log lines too (e.g. migration notices), so typed
      // consumers read the result from --out instead of the stream.
      if (Option.isSome(out)) yield* writeStringAtomic(out.value, encodedResult);
      yield* Console.log(
        json
          ? encodedResult
          : `Imported ${result.importedEventCount} events and ${result.copiedAttachmentCount} attachments.\nRecovery receipt: ${result.receiptPath}`,
      );
    }),
  ),
);

const runCommand = Command.make("run", {
  sourceBaseDir: sourceBaseDirFlag,
  targetBaseDir: targetBaseDirFlag,
  choices: choicesFlag,
  out: outputFlag,
  json: jsonFlag,
  allowActive: allowActiveFlag,
}).pipe(
  Command.withDescription(
    "Create a fresh plan and immediately apply it when no collision needs review.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const prepared = yield* prepareFromFlags(flags);
      return yield* Effect.gen(function* () {
        const encodedPlan = yield* encodePreparedImport(prepared);
        const planPath = Option.isSome(flags.out)
          ? flags.out.value
          : yield* defaultPlanPath(flags.targetBaseDir, prepared.createdAt);
        yield* writeStringAtomic(planPath, encodedPlan);
        yield* persistLastPlan(flags.targetBaseDir, prepared);
        const result = yield* applyPreparedOfficialImport(prepared, {
          allowActive: flags.allowActive,
        });
        const encodedResult = yield* encodeApplyResult(result);
        yield* Console.log(
          flags.json
            ? encodedResult
            : `Imported ${result.importedEventCount} events and ${result.copiedAttachmentCount} attachments.\nPlan: ${planPath}\nRecovery receipt: ${result.receiptPath}`,
        );
      }).pipe(Effect.onError(() => removeImportWorkspace(prepared.workspace).pipe(Effect.ignore)));
    }),
  ),
);

const restoreCommand = Command.make("restore", {
  receipt: Flag.string("receipt").pipe(
    Flag.withDescription("Completed recovery receipt written by an import."),
  ),
  confirmation: Flag.string("confirm").pipe(
    Flag.withDescription(`Required exact text: ${RESTORE_CONFIRMATION}`),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Restore the pre-import database, preserving the displaced current database.",
  ),
  Command.withHandler(({ receipt, confirmation, json }) =>
    Effect.gen(function* () {
      const restored = yield* restoreImportBackup({ receiptPath: receipt, confirmation });
      const encodedRestore = yield* encodeRestoreResult(restored);
      yield* Console.log(
        json
          ? encodedRestore
          : `Restored the pre-import database.\nRecovery receipt: ${restored.receiptPath}`,
      );
    }),
  ),
);

const officialCommand = Command.make("official").pipe(
  Command.withDescription("Import official T3 Code data directly into the T3 Turbo database."),
  Command.withSubcommands([planCommand, applyCommand, runCommand, restoreCommand]),
);

export const officialImportCommand = Command.make("import").pipe(
  Command.withDescription("Import data from another T3 installation."),
  Command.withSubcommands([officialCommand]),
);
