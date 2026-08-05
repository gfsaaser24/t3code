// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CHECKPOINT_REFS_PREFIX } from "../../checkpointing/Utils.ts";

export const ImportCheckpointRefChange = Schema.Struct({
  repositoryPath: Schema.String,
  sourceRef: Schema.String,
  targetRef: Schema.String,
  importedOid: Schema.String,
  previousOid: Schema.NullOr(Schema.String),
});
export type ImportCheckpointRefChange = typeof ImportCheckpointRefChange.Type;

export interface ImportCheckpointRefInput {
  readonly repositoryPath: string;
  readonly sourceRef: string;
  readonly targetRef: string;
}

export class OfficialImportCheckpointRefError extends Schema.TaggedErrorClass<OfficialImportCheckpointRefError>()(
  "OfficialImportCheckpointRefError",
  {
    operation: Schema.String,
    repositoryPath: Schema.String,
    checkpointRef: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `${this.operation} failed for checkpoint ref ${this.checkpointRef} in ${this.repositoryPath}: ${this.reason}`;
  }
}

interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runGit = (repositoryPath: string, args: ReadonlyArray<string>): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("git", ["-C", repositoryPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) =>
      resolve({
        exitCode: exitCode ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      }),
    );
  });

const validateCheckpointRef = (input: {
  readonly operation: string;
  readonly repositoryPath: string;
  readonly checkpointRef: string;
}): Effect.Effect<void, OfficialImportCheckpointRefError> =>
  input.checkpointRef.startsWith(`${CHECKPOINT_REFS_PREFIX}/`)
    ? Effect.void
    : Effect.fail(
        new OfficialImportCheckpointRefError({
          ...input,
          reason: `ref is outside ${CHECKPOINT_REFS_PREFIX}`,
        }),
      );

const resolveRef = Effect.fn("resolveOfficialImportCheckpointRef")(function* (
  repositoryPath: string,
  checkpointRef: string,
  required: boolean,
) {
  yield* validateCheckpointRef({
    operation: "resolve",
    repositoryPath,
    checkpointRef,
  });
  const result = yield* Effect.tryPromise({
    try: () =>
      runGit(repositoryPath, ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`]),
    catch: (cause) =>
      new OfficialImportCheckpointRefError({
        operation: "resolve",
        repositoryPath,
        checkpointRef,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  if (result.exitCode === 0 && result.stdout.length > 0) return result.stdout;
  if (!required && result.exitCode === 1) return null;
  return yield* new OfficialImportCheckpointRefError({
    operation: "resolve",
    repositoryPath,
    checkpointRef,
    reason: result.stderr || `git exited with status ${result.exitCode}`,
  });
});

const updateRef = Effect.fn("updateOfficialImportCheckpointRef")(function* (input: {
  readonly repositoryPath: string;
  readonly checkpointRef: string;
  readonly newOid: string | null;
  readonly expectedOid: string | null;
}) {
  yield* validateCheckpointRef({
    operation: "update",
    repositoryPath: input.repositoryPath,
    checkpointRef: input.checkpointRef,
  });
  const zeroOid = "0".repeat((input.newOid ?? input.expectedOid ?? "").length || 40);
  const args =
    input.newOid === null
      ? ["update-ref", "-d", input.checkpointRef, input.expectedOid ?? zeroOid]
      : ["update-ref", input.checkpointRef, input.newOid, input.expectedOid ?? zeroOid];
  const result = yield* Effect.tryPromise({
    try: () => runGit(input.repositoryPath, args),
    catch: (cause) =>
      new OfficialImportCheckpointRefError({
        operation: "update",
        repositoryPath: input.repositoryPath,
        checkpointRef: input.checkpointRef,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  if (result.exitCode !== 0) {
    return yield* new OfficialImportCheckpointRefError({
      operation: "update",
      repositoryPath: input.repositoryPath,
      checkpointRef: input.checkpointRef,
      reason: result.stderr || `git exited with status ${result.exitCode}`,
    });
  }
});

export const prepareImportCheckpointRefChanges = Effect.fn("prepareImportCheckpointRefChanges")(
  function* (inputs: ReadonlyArray<ImportCheckpointRefInput>) {
    const changes: Array<ImportCheckpointRefChange> = [];
    const seen = new Set<string>();
    for (const input of inputs) {
      const key = `${input.repositoryPath}\0${input.targetRef}`;
      if (seen.has(key) || input.sourceRef === input.targetRef) continue;
      seen.add(key);
      const importedOid = yield* resolveRef(input.repositoryPath, input.sourceRef, true);
      if (importedOid === null) {
        return yield* new OfficialImportCheckpointRefError({
          operation: "prepare",
          repositoryPath: input.repositoryPath,
          checkpointRef: input.sourceRef,
          reason: "source checkpoint ref does not resolve to a commit",
        });
      }
      const previousOid = yield* resolveRef(input.repositoryPath, input.targetRef, false);
      if (previousOid === importedOid) continue;
      changes.push({ ...input, importedOid, previousOid });
    }
    return changes;
  },
);

export const applyImportCheckpointRefChanges = Effect.fn("applyImportCheckpointRefChanges")(
  function* (changes: ReadonlyArray<ImportCheckpointRefChange>) {
    for (const change of changes) {
      const current = yield* resolveRef(change.repositoryPath, change.targetRef, false);
      if (current === change.importedOid) continue;
      if (current !== change.previousOid) {
        return yield* new OfficialImportCheckpointRefError({
          operation: "apply",
          repositoryPath: change.repositoryPath,
          checkpointRef: change.targetRef,
          reason: "target ref changed after the import journal was prepared",
        });
      }
      yield* updateRef({
        repositoryPath: change.repositoryPath,
        checkpointRef: change.targetRef,
        newOid: change.importedOid,
        expectedOid: change.previousOid,
      });
    }
  },
);

export const rollbackImportCheckpointRefChanges = Effect.fn("rollbackImportCheckpointRefChanges")(
  function* (changes: ReadonlyArray<ImportCheckpointRefChange>) {
    for (const change of changes.toReversed()) {
      const current = yield* resolveRef(change.repositoryPath, change.targetRef, false);
      if (current === change.previousOid) continue;
      if (current !== change.importedOid) {
        return yield* new OfficialImportCheckpointRefError({
          operation: "roll back",
          repositoryPath: change.repositoryPath,
          checkpointRef: change.targetRef,
          reason: "target ref changed after the import was applied",
        });
      }
      yield* updateRef({
        repositoryPath: change.repositoryPath,
        checkpointRef: change.targetRef,
        newOid: change.previousOid,
        expectedOid: change.importedOid,
      });
    }
  },
);
