// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationActorKind,
  OrchestrationAggregateKind,
  OrchestrationEvent,
  OrchestrationEventMetadata,
  OrchestrationEventType,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { migrationManifest } from "../../persistence/Migrations.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntimePersistence from "../../persistence/ProviderSessionRuntime.ts";
import { OrchestrationCommandReceipt } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  ImportCheckpointRefChange,
  OfficialImportCheckpointRefError,
  applyImportCheckpointRefChanges,
  rollbackImportCheckpointRefChanges,
} from "./checkpointRefs.ts";

const DERIVED_TABLES = [
  "projection_pending_approvals",
  "projection_projects",
  "projection_state",
  "projection_thread_activities",
  "projection_thread_messages",
  "projection_thread_proposed_plans",
  "projection_thread_sessions",
  "projection_threads",
  "projection_turns",
] as const;

const TABLE_INTRODUCTION_MIGRATION: Readonly<Record<string, number>> = {
  effect_sql_migrations: 0,
  orchestration_events: 1,
  orchestration_command_receipts: 2,
  checkpoint_diff_blobs: 3,
  provider_session_runtime: 4,
  projection_projects: 5,
  projection_threads: 5,
  projection_thread_messages: 5,
  projection_thread_activities: 5,
  projection_thread_sessions: 5,
  projection_turns: 5,
  projection_pending_approvals: 5,
  projection_state: 5,
  projection_thread_proposed_plans: 13,
};

const REQUIRED_COLUMNS = {
  effect_sql_migrations: ["migration_id", "name", "created_at"],
  orchestration_events: [
    "sequence",
    "event_id",
    "aggregate_kind",
    "stream_id",
    "stream_version",
    "event_type",
    "occurred_at",
    "command_id",
    "causation_event_id",
    "correlation_id",
    "actor_kind",
    "payload_json",
    "metadata_json",
  ],
  orchestration_command_receipts: [
    "command_id",
    "aggregate_kind",
    "aggregate_id",
    "accepted_at",
    "result_sequence",
    "status",
    "error",
  ],
  checkpoint_diff_blobs: ["thread_id", "from_turn_count", "to_turn_count", "diff", "created_at"],
  projection_projects: ["project_id", "workspace_root", "deleted_at"],
  projection_threads: ["thread_id", "project_id", "updated_at", "deleted_at"],
  projection_thread_messages: ["message_id"],
  projection_thread_activities: ["activity_id"],
  projection_thread_sessions: ["thread_id", "status"],
  projection_turns: ["row_id", "thread_id", "state"],
  projection_pending_approvals: ["request_id", "thread_id", "status"],
  projection_state: ["projector", "last_applied_sequence"],
  projection_thread_proposed_plans: ["plan_id"],
  provider_session_runtime: ["thread_id", "status"],
} as const;

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const EventMetadataFromJsonString = Schema.fromJsonString(OrchestrationEventMetadata);
const encodeUnknownJsonString = Schema.encodeUnknownSync(UnknownFromJsonString);
const ImportProviderSessionRuntimeRow =
  ProviderSessionRuntimePersistence.ProviderSessionRuntime.mapFields(
    Struct.assign({
      providerName: ProviderDriverKind,
      resumeCursor: Schema.NullOr(UnknownFromJsonString),
      runtimePayload: Schema.NullOr(UnknownFromJsonString),
    }),
  );

const PersistedEventSchema = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  type: OrchestrationEventType,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  payload: UnknownFromJsonString,
  metadata: EventMetadataFromJsonString,
});

export const ImportProjectRow = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
});
export type ImportProjectRow = typeof ImportProjectRow.Type;

export const ImportThreadRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(Schema.String),
});
export type ImportThreadRow = typeof ImportThreadRow.Type;

export const ImportActivityState = Schema.Struct({
  activeProviderSessions: NonNegativeInt,
  activeProjectedSessions: NonNegativeInt,
  activeTurns: NonNegativeInt,
  pendingApprovals: NonNegativeInt,
});
export type ImportActivityState = typeof ImportActivityState.Type;

export const ImportCheckpointDiffBlob = Schema.Struct({
  threadId: ThreadId,
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
  diff: Schema.String,
  createdAt: IsoDateTime,
});
export type ImportCheckpointDiffBlob = typeof ImportCheckpointDiffBlob.Type;

export const ImportProviderBindingCopyResult = Schema.Struct({
  copiedBindingCount: NonNegativeInt,
  skippedInvalidBindingCount: NonNegativeInt,
  skippedUnsettledBindingCount: NonNegativeInt,
});
export type ImportProviderBindingCopyResult = typeof ImportProviderBindingCopyResult.Type;

export const ImportAttachmentChange = Schema.Struct({
  targetPath: Schema.String,
  stagedPath: Schema.String,
  backupPath: Schema.NullOr(Schema.String),
  importedFingerprint: Schema.String,
  previousFingerprint: Schema.NullOr(Schema.String),
});
export type ImportAttachmentChange = typeof ImportAttachmentChange.Type;

export interface StagedImportAttachment {
  readonly sourcePath: string;
  readonly stagedPath: string;
  readonly targetPath: string;
  readonly allowReplace: boolean;
}

export const ImportCutoverReceipt = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("t3-turbo-official-import"),
  status: Schema.Literals(["prepared", "complete", "rolled-back"]),
  createdAt: IsoDateTime,
  sourceDatabasePath: Schema.String,
  targetDatabasePath: Schema.String,
  stagingDatabasePath: Schema.String,
  backupDatabasePath: Schema.NullOr(Schema.String),
  backupWalPath: Schema.NullOr(Schema.String),
  backupShmPath: Schema.NullOr(Schema.String),
  sourceFingerprint: Schema.String,
  previousTargetFingerprint: Schema.NullOr(Schema.String),
  importedTargetFingerprint: Schema.String,
  attachmentChanges: Schema.Array(ImportAttachmentChange),
  checkpointRefChanges: Schema.Array(ImportCheckpointRefChange),
});
export type ImportCutoverReceipt = typeof ImportCutoverReceipt.Type;

export const ImportRestoreAttachmentChange = Schema.Struct({
  targetPath: Schema.String,
  importedDisplacedPath: Schema.String,
  previousBackupPath: Schema.NullOr(Schema.String),
  importedFingerprint: Schema.String,
  previousFingerprint: Schema.NullOr(Schema.String),
});
export type ImportRestoreAttachmentChange = typeof ImportRestoreAttachmentChange.Type;

export const ImportRestoreReceipt = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("t3-turbo-official-import-restore"),
  status: Schema.Literals(["prepared", "complete", "rolled-back"]),
  createdAt: IsoDateTime,
  targetDatabasePath: Schema.String,
  restoredFromDatabasePath: Schema.NullOr(Schema.String),
  restoredStagingPath: Schema.NullOr(Schema.String),
  displacedDatabasePath: Schema.String,
  attachmentChanges: Schema.Array(ImportRestoreAttachmentChange),
  displacedAttachmentPaths: Schema.Array(Schema.String),
  checkpointRefChanges: Schema.Array(ImportCheckpointRefChange),
  importedTargetFingerprint: Schema.String,
  restoredFingerprint: Schema.NullOr(Schema.String),
});
export type ImportRestoreReceipt = typeof ImportRestoreReceipt.Type;

const encodeCutoverReceipt = Schema.encodeSync(Schema.fromJsonString(ImportCutoverReceipt));
const encodeRestoreReceipt = Schema.encodeSync(Schema.fromJsonString(ImportRestoreReceipt));
const decodeCutoverReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ImportCutoverReceipt),
);
const decodeRestoreReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ImportRestoreReceipt),
);

export interface ImportWorkspace {
  readonly directory: string;
  readonly sourceDatabasePath: string;
  readonly targetDatabasePath: string;
  readonly sourceSnapshotPath: string;
  readonly targetStagingPath: string;
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string | null;
  readonly sourceActivity: ImportActivityState;
  readonly targetActivity: ImportActivityState;
}

export class OfficialImportStorageError extends Schema.TaggedErrorClass<OfficialImportStorageError>()(
  "OfficialImportStorageError",
  {
    operation: Schema.String,
    path: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `${this.operation} failed for ${this.path}: ${this.reason}`;
  }
}

export class OfficialImportSchemaMismatchError extends Schema.TaggedErrorClass<OfficialImportSchemaMismatchError>()(
  "OfficialImportSchemaMismatchError",
  {
    path: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `The database at ${this.path} is not compatible with this T3 Turbo importer: ${this.reason}`;
  }
}

export class OfficialImportFingerprintMismatchError extends Schema.TaggedErrorClass<OfficialImportFingerprintMismatchError>()(
  "OfficialImportFingerprintMismatchError",
  {
    role: Schema.Literals(["source", "target"]),
    expected: Schema.String,
    actual: Schema.String,
  },
) {
  override get message(): string {
    return `The ${this.role} database changed after the import snapshot was created. Create a fresh plan before applying.`;
  }
}

export class OfficialImportActiveStateError extends Schema.TaggedErrorClass<OfficialImportActiveStateError>()(
  "OfficialImportActiveStateError",
  {
    role: Schema.Literals(["source", "target"]),
    path: Schema.String,
    activity: ImportActivityState,
  },
) {
  override get message(): string {
    return `The ${this.role} database has an active session, turn, or approval. Stop it before applying the import.`;
  }
}

export class OfficialImportLiveServerError extends Schema.TaggedErrorClass<OfficialImportLiveServerError>()(
  "OfficialImportLiveServerError",
  {
    role: Schema.Literals(["source", "target"]),
    runtimeStatePath: Schema.String,
    pid: Schema.Int,
  },
) {
  override get message(): string {
    return `The ${this.role} T3 server is still running (PID ${this.pid}). Quit it before applying the import.`;
  }
}

export class OfficialImportConfirmationError extends Schema.TaggedErrorClass<OfficialImportConfirmationError>()(
  "OfficialImportConfirmationError",
  {
    expected: Schema.String,
  },
) {
  override get message(): string {
    return `Restore requires the exact confirmation text: ${this.expected}`;
  }
}

export class OfficialImportLockError extends Schema.TaggedErrorClass<OfficialImportLockError>()(
  "OfficialImportLockError",
  {
    lockPath: Schema.String,
    ownerPid: Schema.NullOr(Schema.Int),
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Official import is already locked at ${this.lockPath}${this.ownerPid === null ? "" : ` by PID ${this.ownerPid}`}: ${this.reason}`;
  }
}

export type OfficialImportStorageFailure =
  | OfficialImportStorageError
  | OfficialImportSchemaMismatchError
  | OfficialImportFingerprintMismatchError
  | OfficialImportActiveStateError
  | OfficialImportLiveServerError
  | OfficialImportConfirmationError
  | OfficialImportLockError
  | OfficialImportCheckpointRefError;

const isOfficialImportStorageError = Schema.is(OfficialImportStorageError);
const isOfficialImportSchemaMismatchError = Schema.is(OfficialImportSchemaMismatchError);
const isOfficialImportLockError = Schema.is(OfficialImportLockError);

export const RESTORE_CONFIRMATION = "RESTORE T3 TURBO FROM IMPORT BACKUP";

const RowArraySchema = Schema.Array(Schema.Unknown);
const TableNameRowsSchema = Schema.Array(Schema.Struct({ name: Schema.String }));
const TableInfoRowsSchema = Schema.Array(Schema.Struct({ name: Schema.String }));
const MigrationRowsSchema = Schema.Array(
  Schema.Struct({ migrationId: Schema.Number, name: Schema.String }),
);
const CountRowSchema = Schema.Struct({ count: NonNegativeInt });
const ImportRuntimeState = Schema.Struct({ version: Schema.Literal(1), pid: Schema.Int });
const decodeImportRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ImportRuntimeState),
);
const ImportLockOwner = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  token: Schema.String,
});
const encodeImportLockOwner = Schema.encodeSync(Schema.fromJsonString(ImportLockOwner));
const decodeImportLockOwner = Schema.decodeUnknownSync(Schema.fromJsonString(ImportLockOwner));

const causeMessage = (cause: unknown): string =>
  Predicate.isError(cause) ? cause.message : String(cause);

const storageError = (operation: string, path: string) => (cause: unknown) =>
  new OfficialImportStorageError({ operation, path, reason: causeMessage(cause) });

const sqliteStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const sqliteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const errorCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

interface ImportLockLease {
  readonly lockPath: string;
  readonly token: string;
}

const readImportLockOwner = async (lockPath: string) => {
  try {
    const encoded = await NodeFSP.readFile(NodePath.join(lockPath, "owner.json"), "utf8");
    return decodeImportLockOwner(encoded);
  } catch {
    return null;
  }
};

const acquireImportLock = Effect.fn("acquireOfficialImportLock")(function* (
  targetDatabasePath: string,
) {
  const lockPath = `${targetDatabasePath}.official-import.lock`;
  const token = NodeCrypto.randomUUID();
  return yield* Effect.tryPromise({
    try: async (): Promise<ImportLockLease> => {
      await NodeFSP.mkdir(NodePath.dirname(targetDatabasePath), { recursive: true });
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const temporaryPath = `${lockPath}.candidate-${process.pid}-${NodeCrypto.randomUUID()}`;
        await NodeFSP.mkdir(temporaryPath, { recursive: false });
        try {
          await NodeFSP.writeFile(
            NodePath.join(temporaryPath, "owner.json"),
            `${encodeImportLockOwner({ version: 1, pid: process.pid, token })}\n`,
            { flag: "wx", mode: 0o600 },
          );
          try {
            await NodeFSP.rename(temporaryPath, lockPath);
            return { lockPath, token };
          } catch (cause) {
            if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(errorCode(cause) ?? "")) {
              throw cause;
            }
          }
        } finally {
          await NodeFSP.rm(temporaryPath, { recursive: true, force: true });
        }

        const owner = await readImportLockOwner(lockPath);
        if (owner === null || isProcessAlive(owner.pid)) {
          throw new OfficialImportLockError({
            lockPath,
            ownerPid: owner?.pid ?? null,
            reason:
              owner === null ? "lock owner metadata is unavailable" : "owner is still running",
          });
        }
        const stalePath = `${lockPath}.stale-${NodeCrypto.randomUUID()}`;
        try {
          await NodeFSP.rename(lockPath, stalePath);
          await NodeFSP.rm(stalePath, { recursive: true, force: true });
        } catch (cause) {
          if (!["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM"].includes(errorCode(cause) ?? "")) {
            throw cause;
          }
        }
      }
      throw new OfficialImportLockError({
        lockPath,
        ownerPid: null,
        reason: "lock acquisition did not converge",
      });
    },
    catch: (cause) =>
      isOfficialImportLockError(cause)
        ? cause
        : new OfficialImportLockError({
            lockPath,
            ownerPid: null,
            reason: causeMessage(cause),
          }),
  });
});

const releaseImportLock = Effect.fn("releaseOfficialImportLock")(function* (
  lease: ImportLockLease,
) {
  yield* Effect.promise(async () => {
    const owner = await readImportLockOwner(lease.lockPath);
    if (owner?.token !== lease.token) return;
    const releasedPath = `${lease.lockPath}.released-${NodeCrypto.randomUUID()}`;
    try {
      await NodeFSP.rename(lease.lockPath, releasedPath);
      await NodeFSP.rm(releasedPath, { recursive: true, force: true });
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT") throw cause;
    }
  });
});

export const withOfficialImportLock = <A, E, R>(
  targetDatabasePath: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | OfficialImportLockError, R> =>
  Effect.acquireUseRelease(
    acquireImportLock(targetDatabasePath),
    () => effect,
    (lease) => releaseImportLock(lease).pipe(Effect.ignore),
  );

export const withOfficialImportLocks = <A, E, R>(
  databasePaths: ReadonlyArray<string>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | OfficialImportLockError, R> => {
  const uniquePaths = Array.from(new Set(databasePaths)).toSorted((left, right) =>
    left.localeCompare(right),
  );
  return uniquePaths.reduceRight<Effect.Effect<A, E | OfficialImportLockError, R>>(
    (protectedEffect, databasePath) => withOfficialImportLock(databasePath, protectedEffect),
    effect,
  );
};

/** Fail closed when a live server still owns the database described by its runtime file. */
export const assertNoLiveImportServer = Effect.fn("assertNoLiveImportServer")(function* (
  role: "source" | "target",
  databasePath: string,
): Effect.fn.Return<void, OfficialImportStorageFailure, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeStatePath = path.join(path.dirname(databasePath), "server-runtime.json");
  if (
    !(yield* fs
      .exists(runtimeStatePath)
      .pipe(Effect.mapError(storageError("inspect import server ownership", runtimeStatePath))))
  ) {
    return;
  }
  const encoded = yield* fs
    .readFileString(runtimeStatePath)
    .pipe(Effect.mapError(storageError("read import server ownership", runtimeStatePath)));
  const runtime = yield* decodeImportRuntimeState(encoded).pipe(
    Effect.mapError(storageError("validate import server ownership", runtimeStatePath)),
  );
  if (isProcessAlive(runtime.pid)) {
    return yield* new OfficialImportLiveServerError({ role, runtimeStatePath, pid: runtime.pid });
  }
});

const withDatabase = <A>(
  path: string,
  readOnly: boolean,
  operation: string,
  use: (database: NodeSqlite.DatabaseSync) => A,
): Effect.Effect<A, OfficialImportStorageError> =>
  Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(path, { readOnly });
      try {
        return use(database);
      } finally {
        database.close();
      }
    },
    catch: storageError(operation, path),
  });

const decodeSync = <S extends Schema.Top>(schema: S, value: unknown): Schema.Schema.Type<S> =>
  Schema.decodeUnknownSync(schema as never)(value) as Schema.Schema.Type<S>;

const tableNames = (database: NodeSqlite.DatabaseSync): ReadonlyArray<string> =>
  decodeSync(
    TableNameRowsSchema,
    database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all(),
  ).map(({ name }) => name);

const tableColumns = (database: NodeSqlite.DatabaseSync, table: string): ReadonlyArray<string> =>
  decodeSync(
    TableInfoRowsSchema,
    database.prepare(`PRAGMA table_info(${sqliteIdentifier(table)})`).all(),
  ).map(({ name }) => name);

const validateDatabase = (
  database: NodeSqlite.DatabaseSync,
  path: string,
  requireCurrent: boolean,
): void => {
  const names = new Set(tableNames(database));
  if (!names.has("effect_sql_migrations")) {
    throw new OfficialImportSchemaMismatchError({
      path,
      reason: "missing table effect_sql_migrations",
    });
  }
  const migrations = decodeSync(
    MigrationRowsSchema,
    database
      .prepare(
        'SELECT migration_id AS "migrationId", name FROM effect_sql_migrations ORDER BY migration_id',
      )
      .all(),
  );
  const orderedPrefix =
    migrations.length <= migrationManifest.length &&
    migrations.every((migration, index) => {
      const expected = migrationManifest[index];
      return migration.migrationId === expected?.[0] && migration.name === expected?.[1];
    });
  if (!orderedPrefix || migrations.length < 5) {
    throw new OfficialImportSchemaMismatchError({
      path,
      reason: "migration history is not a supported ordered prefix of this build",
    });
  }
  if (requireCurrent && migrations.length !== migrationManifest.length) {
    throw new OfficialImportSchemaMismatchError({
      path,
      reason: "staging database was not migrated to the current schema",
    });
  }
  const latestMigration = migrations.at(-1)?.migrationId ?? 0;
  for (const [table, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
    if ((TABLE_INTRODUCTION_MIGRATION[table] ?? 0) > latestMigration) continue;
    if (!names.has(table)) {
      throw new OfficialImportSchemaMismatchError({ path, reason: `missing table ${table}` });
    }
    const columns = new Set(tableColumns(database, table));
    const missing = requiredColumns.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new OfficialImportSchemaMismatchError({
        path,
        reason: `table ${table} is missing columns: ${missing.join(", ")}`,
      });
    }
  }
};

export const validateCompatibleDatabase = Effect.fn("validateCompatibleDatabase")(
  (
    path: string,
    options?: { readonly requireCurrent?: boolean },
  ): Effect.Effect<void, OfficialImportStorageFailure> =>
    Effect.try({
      try: () => {
        const database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
        try {
          validateDatabase(database, path, options?.requireCurrent === true);
        } finally {
          database.close();
        }
      },
      catch: (cause) =>
        isOfficialImportSchemaMismatchError(cause)
          ? cause
          : storageError("validate schema", path)(cause),
    }),
);

const migrateDatabaseToCurrent = Effect.fn("migrateOfficialImportDatabaseToCurrent")(
  (path: string) =>
    Effect.void.pipe(
      Effect.provide(makeSqlitePersistenceLive(path)),
      Effect.scoped,
      Effect.mapError(storageError("migrate import staging database", path)),
    ),
);

const updateHashValue = (hash: ReturnType<typeof NodeCrypto.createHash>, value: unknown): void => {
  if (Predicate.isNull(value)) {
    hash.update("n:0:");
    return;
  }
  if (Predicate.isString(value)) {
    hash.update(`s:${Buffer.byteLength(value)}:`);
    hash.update(value);
    return;
  }
  if (Predicate.isNumber(value) || Predicate.isBigInt(value)) {
    const encoded = String(value);
    hash.update(`d:${encoded.length}:${encoded}`);
    return;
  }
  if (Predicate.isUint8Array(value)) {
    hash.update(`b:${value.byteLength}:`);
    hash.update(value);
    return;
  }
  throw new TypeError(`Unsupported SQLite value in fingerprint: ${String(value)}`);
};

const fingerprintOpenDatabase = (database: NodeSqlite.DatabaseSync): string => {
  const hash = NodeCrypto.createHash("sha256");
  const names = tableNames(database);
  for (const table of names) {
    const columns = tableColumns(database, table);
    hash.update(`table:${table}\ncolumns:${columns.join(",")}\n`);
    const columnList = columns.map(sqliteIdentifier).join(", ");
    const orderBy = columns.map(sqliteIdentifier).join(", ");
    const statement = database.prepare(
      `SELECT ${columnList} FROM ${sqliteIdentifier(table)} ORDER BY ${orderBy}`,
    );
    statement.setReturnArrays(true);
    for (const rawRow of statement.iterate()) {
      const row = decodeSync(RowArraySchema, rawRow);
      for (const value of row) {
        updateHashValue(hash, value);
      }
      hash.update("\n");
    }
  }
  return `sha256:${hash.digest("hex")}`;
};

export const fingerprintDatabase = Effect.fn("fingerprintDatabase")(
  (path: string): Effect.Effect<string, OfficialImportStorageError> =>
    withDatabase(path, true, "fingerprint database", fingerprintOpenDatabase),
);

const readActivityStateOpen = (database: NodeSqlite.DatabaseSync): ImportActivityState => {
  const count = (sql: string): number =>
    decodeSync(CountRowSchema, database.prepare(sql).get()).count;
  return {
    activeProviderSessions: count(
      "SELECT COUNT(*) AS count FROM provider_session_runtime WHERE status IN ('starting', 'connecting', 'running')",
    ),
    activeProjectedSessions: count(
      "SELECT COUNT(*) AS count FROM projection_thread_sessions WHERE status IN ('starting', 'connecting', 'running')",
    ),
    activeTurns: count(
      "SELECT COUNT(*) AS count FROM projection_turns WHERE state IN ('pending', 'running')",
    ),
    pendingApprovals: count(
      "SELECT COUNT(*) AS count FROM projection_pending_approvals WHERE status = 'pending'",
    ),
  };
};

export const readImportActivityState = Effect.fn("readImportActivityState")(
  (path: string): Effect.Effect<ImportActivityState, OfficialImportStorageError> =>
    withDatabase(path, true, "read import activity", readActivityStateOpen),
);

const isQuiescent = (activity: ImportActivityState): boolean =>
  activity.activeProviderSessions === 0 &&
  activity.activeProjectedSessions === 0 &&
  activity.activeTurns === 0 &&
  activity.pendingApprovals === 0;

const failWhenActive = (
  role: "source" | "target",
  path: string,
  activity: ImportActivityState,
): Effect.Effect<void, OfficialImportActiveStateError> =>
  isQuiescent(activity)
    ? Effect.void
    : Effect.fail(new OfficialImportActiveStateError({ role, path, activity }));

const snapshotDatabase = Effect.fn("snapshotDatabase")(
  (sourcePath: string, snapshotPath: string): Effect.Effect<void, OfficialImportStorageError> =>
    withDatabase(sourcePath, true, "create consistent snapshot", (database) => {
      database.exec(`VACUUM INTO ${sqliteStringLiteral(snapshotPath)}`);
    }),
);

const makeWorkspaceDirectory = Effect.fn("makeWorkspaceDirectory")(function* (
  targetDatabasePath: string,
): Effect.fn.Return<string, OfficialImportStorageError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = path.dirname(targetDatabasePath);
  return yield* fs
    .makeDirectory(parent, { recursive: true })
    .pipe(
      Effect.andThen(fs.makeTempDirectory({ directory: parent, prefix: ".t3-turbo-import-" })),
      Effect.mapError(storageError("create import workspace", parent)),
    );
});

/**
 * Create immutable, transactionally consistent source and target snapshots.
 * Repeating an import always starts here and produces a fresh plan against a
 * fresh target staging database.
 */
const prepareImportWorkspaceWithinLock = Effect.fn("prepareImportWorkspaceWithinLock")(
  function* (input: {
    readonly sourceDatabasePath: string;
    readonly targetDatabasePath: string;
  }): Effect.fn.Return<
    ImportWorkspace,
    OfficialImportStorageFailure,
    FileSystem.FileSystem | Path.Path
  > {
    const path = yield* Path.Path;
    const sourceDatabasePath = path.resolve(input.sourceDatabasePath);
    const targetDatabasePath = path.resolve(input.targetDatabasePath);
    if (sourceDatabasePath.toLowerCase() === targetDatabasePath.toLowerCase()) {
      return yield* new OfficialImportStorageError({
        operation: "prepare import",
        path: sourceDatabasePath,
        reason: "source and target database paths must be different",
      });
    }

    yield* validateCompatibleDatabase(sourceDatabasePath);
    const fs = yield* FileSystem.FileSystem;
    const targetExists = yield* fs
      .exists(targetDatabasePath)
      .pipe(Effect.mapError(storageError("inspect target database", targetDatabasePath)));
    if (targetExists) yield* validateCompatibleDatabase(targetDatabasePath);
    const directory = yield* makeWorkspaceDirectory(targetDatabasePath);
    return yield* Effect.gen(function* () {
      const sourceSnapshotPath = path.join(directory, "official-source.sqlite");
      const targetStagingPath = path.join(directory, "turbo-target-staging.sqlite");

      yield* snapshotDatabase(sourceDatabasePath, sourceSnapshotPath);
      if (targetExists) yield* snapshotDatabase(targetDatabasePath, targetStagingPath);

      const [sourceFingerprint, liveSourceFingerprint] = yield* Effect.all([
        fingerprintDatabase(sourceSnapshotPath),
        fingerprintDatabase(sourceDatabasePath),
      ]);
      if (sourceFingerprint !== liveSourceFingerprint) {
        return yield* new OfficialImportFingerprintMismatchError({
          role: "source",
          expected: sourceFingerprint,
          actual: liveSourceFingerprint,
        });
      }
      let targetFingerprint: string | null = null;
      if (targetExists) {
        const [snapshotFingerprint, liveTargetFingerprint] = yield* Effect.all([
          fingerprintDatabase(targetStagingPath),
          fingerprintDatabase(targetDatabasePath),
        ]);
        if (snapshotFingerprint !== liveTargetFingerprint) {
          return yield* new OfficialImportFingerprintMismatchError({
            role: "target",
            expected: snapshotFingerprint,
            actual: liveTargetFingerprint,
          });
        }
        targetFingerprint = snapshotFingerprint;
      }

      yield* Effect.all([
        migrateDatabaseToCurrent(sourceSnapshotPath),
        migrateDatabaseToCurrent(targetStagingPath),
      ]);
      yield* Effect.all([
        validateCompatibleDatabase(sourceSnapshotPath, { requireCurrent: true }),
        validateCompatibleDatabase(targetStagingPath, { requireCurrent: true }),
      ]);

      const [sourceActivity, targetActivity] = yield* Effect.all([
        readImportActivityState(sourceSnapshotPath),
        readImportActivityState(targetStagingPath),
      ]);
      return {
        directory,
        sourceDatabasePath,
        targetDatabasePath,
        sourceSnapshotPath,
        targetStagingPath,
        sourceFingerprint,
        targetFingerprint,
        sourceActivity,
        targetActivity,
      };
    }).pipe(
      Effect.onError(() =>
        fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
  },
);

export const assertWorkspaceReadyForApply = Effect.fn("assertWorkspaceReadyForApply")(function* (
  workspace: ImportWorkspace,
  options?: { readonly allowActive?: boolean },
): Effect.fn.Return<void, OfficialImportStorageFailure, FileSystem.FileSystem | Path.Path> {
  yield* Effect.all([
    assertNoLiveImportServer("source", workspace.sourceDatabasePath),
    assertNoLiveImportServer("target", workspace.targetDatabasePath),
  ]);
  const fs = yield* FileSystem.FileSystem;
  const targetExists = yield* fs
    .exists(workspace.targetDatabasePath)
    .pipe(Effect.mapError(storageError("inspect target database", workspace.targetDatabasePath)));
  const [sourceFingerprint, sourceActivity] = yield* Effect.all([
    fingerprintDatabase(workspace.sourceDatabasePath),
    readImportActivityState(workspace.sourceDatabasePath),
  ]);
  if (sourceFingerprint !== workspace.sourceFingerprint) {
    return yield* new OfficialImportFingerprintMismatchError({
      role: "source",
      expected: workspace.sourceFingerprint,
      actual: sourceFingerprint,
    });
  }
  if (workspace.targetFingerprint === null && targetExists) {
    const targetFingerprint = yield* fingerprintDatabase(workspace.targetDatabasePath);
    return yield* new OfficialImportFingerprintMismatchError({
      role: "target",
      expected: "absent",
      actual: targetFingerprint,
    });
  }
  if (workspace.targetFingerprint !== null && !targetExists) {
    return yield* new OfficialImportFingerprintMismatchError({
      role: "target",
      expected: workspace.targetFingerprint,
      actual: "absent",
    });
  }
  const targetActivity = targetExists
    ? yield* readImportActivityState(workspace.targetDatabasePath)
    : {
        activeProviderSessions: 0,
        activeProjectedSessions: 0,
        activeTurns: 0,
        pendingApprovals: 0,
      };
  if (workspace.targetFingerprint !== null) {
    const targetFingerprint = yield* fingerprintDatabase(workspace.targetDatabasePath);
    if (targetFingerprint !== workspace.targetFingerprint) {
      return yield* new OfficialImportFingerprintMismatchError({
        role: "target",
        expected: workspace.targetFingerprint,
        actual: targetFingerprint,
      });
    }
  }
  // A session or turn recorded as active in a database whose app is closed
  // (or uninstalled) can never finish; allowActive lets a deliberate caller
  // proceed anyway. Fingerprint and live-server checks above still apply.
  if (options?.allowActive !== true) {
    yield* failWhenActive("source", workspace.sourceDatabasePath, sourceActivity);
    if (targetExists) {
      yield* failWhenActive("target", workspace.targetDatabasePath, targetActivity);
    }
  }
});

export const readOrchestrationEvents = Effect.fn("readOrchestrationEvents")(
  (path: string): Effect.Effect<ReadonlyArray<OrchestrationEvent>, OfficialImportStorageError> =>
    withDatabase(path, true, "read orchestration events", (database) => {
      const rows: ReadonlyArray<unknown> = database
        .prepare(
          `SELECT
            sequence,
            event_id AS eventId,
            event_type AS type,
            aggregate_kind AS aggregateKind,
            stream_id AS aggregateId,
            occurred_at AS occurredAt,
            command_id AS commandId,
            causation_event_id AS causationEventId,
            correlation_id AS correlationId,
            payload_json AS payload,
            metadata_json AS metadata
          FROM orchestration_events
          ORDER BY sequence`,
        )
        .all();
      return rows.map((row) =>
        decodeSync(OrchestrationEvent, decodeSync(PersistedEventSchema, row)),
      );
    }),
);

export const readCommandReceipts = Effect.fn("readCommandReceipts")(
  (
    path: string,
  ): Effect.Effect<ReadonlyArray<OrchestrationCommandReceipt>, OfficialImportStorageError> =>
    withDatabase(path, true, "read command receipts", (database) => {
      const rows: ReadonlyArray<unknown> = database
        .prepare(
          `SELECT
            command_id AS commandId,
            aggregate_kind AS aggregateKind,
            aggregate_id AS aggregateId,
            accepted_at AS acceptedAt,
            result_sequence AS resultSequence,
            status,
            error
          FROM orchestration_command_receipts
          ORDER BY result_sequence, command_id`,
        )
        .all();
      return rows.map((row) => decodeSync(OrchestrationCommandReceipt, row));
    }),
);

export const readProjectRows = Effect.fn("readProjectRows")(
  (path: string): Effect.Effect<ReadonlyArray<ImportProjectRow>, OfficialImportStorageError> =>
    withDatabase(path, true, "read project projections", (database) => {
      const rows: ReadonlyArray<unknown> = database
        .prepare(
          `SELECT project_id AS projectId, workspace_root AS workspaceRoot, deleted_at AS deletedAt
           FROM projection_projects ORDER BY project_id`,
        )
        .all();
      return rows.map((row) => decodeSync(ImportProjectRow, row));
    }),
);

export const readThreadRows = Effect.fn("readThreadRows")(
  (path: string): Effect.Effect<ReadonlyArray<ImportThreadRow>, OfficialImportStorageError> =>
    withDatabase(path, true, "read thread projections", (database) => {
      const rows: ReadonlyArray<unknown> = database
        .prepare(
          `SELECT thread_id AS threadId, project_id AS projectId, updated_at AS updatedAt,
                  deleted_at AS deletedAt
           FROM projection_threads ORDER BY thread_id`,
        )
        .all();
      return rows.map((row) => decodeSync(ImportThreadRow, row));
    }),
);

export const readCheckpointDiffBlobs = Effect.fn("readCheckpointDiffBlobs")(
  (
    path: string,
    threadIds?: ReadonlyArray<ThreadId>,
  ): Effect.Effect<ReadonlyArray<ImportCheckpointDiffBlob>, OfficialImportStorageError> =>
    withDatabase(path, true, "read checkpoint diff blobs", (database) => {
      if (threadIds?.length === 0) return [];
      const where = threadIds ? `WHERE thread_id IN (${threadIds.map(() => "?").join(", ")})` : "";
      const rows: ReadonlyArray<unknown> = database
        .prepare(
          `SELECT thread_id AS threadId, from_turn_count AS fromTurnCount,
                  to_turn_count AS toTurnCount, diff, created_at AS createdAt
           FROM checkpoint_diff_blobs ${where}
           ORDER BY thread_id, from_turn_count, to_turn_count`,
        )
        .all(...(threadIds ?? []));
      return rows.map((row) => decodeSync(ImportCheckpointDiffBlob, row));
    }),
);

/**
 * Delete selected thread event streams from staging before a replace import.
 * Receipts pointing at removed events and non-canonical runtime/checkpoint rows
 * are deleted in the same transaction. Global event sequences are never reset
 * or renumbered, so subsequent appends continue above the previous high-water mark.
 */
export const deleteCanonicalThreadStreams = Effect.fn("deleteCanonicalThreadStreams")(
  (
    stagingPath: string,
    threadIds: ReadonlyArray<ThreadId>,
  ): Effect.Effect<number, OfficialImportStorageError> =>
    threadIds.length === 0
      ? Effect.succeed(0)
      : withDatabase(stagingPath, false, "delete canonical thread streams", (database) => {
          const deleteReceipts = database.prepare(
            `DELETE FROM orchestration_command_receipts
             WHERE result_sequence IN (
               SELECT sequence FROM orchestration_events
               WHERE aggregate_kind = 'thread' AND stream_id = ?
             )`,
          );
          const deleteEvents = database.prepare(
            "DELETE FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ?",
          );
          const deleteRuntime = database.prepare(
            "DELETE FROM provider_session_runtime WHERE thread_id = ?",
          );
          const deleteDiffs = database.prepare(
            "DELETE FROM checkpoint_diff_blobs WHERE thread_id = ?",
          );
          let deletedEvents = 0;
          database.exec("BEGIN IMMEDIATE");
          try {
            for (const threadId of threadIds) {
              deleteReceipts.run(threadId);
              deleteRuntime.run(threadId);
              deleteDiffs.run(threadId);
              deletedEvents += Number(deleteEvents.run(threadId).changes);
            }
            database.exec("COMMIT");
            return deletedEvents;
          } catch (cause) {
            database.exec("ROLLBACK");
            throw cause;
          }
        }),
);

/** Clear selected target bindings before safe source bindings are reinstalled. */
export const deleteProviderSessionRuntimeBindings = Effect.fn(
  "deleteProviderSessionRuntimeBindings",
)(
  (
    stagingPath: string,
    threadIds: ReadonlyArray<ThreadId>,
  ): Effect.Effect<number, OfficialImportStorageError> =>
    threadIds.length === 0
      ? Effect.succeed(0)
      : withDatabase(stagingPath, false, "clear imported provider bindings", (database) => {
          const statement = database.prepare(
            "DELETE FROM provider_session_runtime WHERE thread_id = ?",
          );
          let deleted = 0;
          database.exec("BEGIN IMMEDIATE");
          try {
            for (const threadId of threadIds) {
              deleted += Number(statement.run(threadId).changes);
            }
            database.exec("COMMIT");
            return deleted;
          } catch (cause) {
            database.exec("ROLLBACK");
            throw cause;
          }
        }),
);

/** Copy only fully valid, quiescent source continuation bindings into staging. */
export const copySettledProviderSessionRuntimeBindings = Effect.fn(
  "copySettledProviderSessionRuntimeBindings",
)(function* (input: {
  readonly sourcePath: string;
  readonly stagingPath: string;
  readonly threadIdMap: ReadonlyMap<ThreadId, ThreadId>;
}): Effect.fn.Return<ImportProviderBindingCopyResult, OfficialImportStorageError> {
  if (input.threadIdMap.size === 0) {
    return {
      copiedBindingCount: 0,
      skippedInvalidBindingCount: 0,
      skippedUnsettledBindingCount: 0,
    };
  }

  const prepared = yield* withDatabase(
    input.sourcePath,
    true,
    "read settled provider bindings",
    (database) => {
      const selectBinding = database.prepare(
        `SELECT
           thread_id AS threadId,
           provider_name AS providerName,
           provider_instance_id AS providerInstanceId,
           adapter_key AS adapterKey,
           runtime_mode AS runtimeMode,
           status,
           last_seen_at AS lastSeenAt,
           resume_cursor_json AS resumeCursor,
           runtime_payload_json AS runtimePayload
         FROM provider_session_runtime
         WHERE thread_id = ?`,
      );
      const activeProjectedSession = database.prepare(
        `SELECT COUNT(*) AS count FROM projection_thread_sessions
         WHERE thread_id = ? AND status IN ('starting', 'connecting', 'running')`,
      );
      const activeTurns = database.prepare(
        `SELECT COUNT(*) AS count FROM projection_turns
         WHERE thread_id = ? AND state IN ('pending', 'running')`,
      );
      const pendingApprovals = database.prepare(
        `SELECT COUNT(*) AS count FROM projection_pending_approvals
         WHERE thread_id = ? AND status = 'pending'`,
      );
      const bindings: Array<ProviderSessionRuntimePersistence.ProviderSessionRuntime> = [];
      let skippedInvalidBindingCount = 0;
      let skippedUnsettledBindingCount = 0;
      for (const [sourceThreadId, targetThreadId] of input.threadIdMap) {
        const raw = selectBinding.get(sourceThreadId);
        if (raw === undefined) continue;
        let binding: ProviderSessionRuntimePersistence.ProviderSessionRuntime;
        try {
          binding = decodeSync(ImportProviderSessionRuntimeRow, raw);
        } catch {
          skippedInvalidBindingCount += 1;
          continue;
        }
        const isUnsettled =
          binding.status === "starting" ||
          binding.status === "running" ||
          decodeSync(CountRowSchema, activeProjectedSession.get(sourceThreadId)).count > 0 ||
          decodeSync(CountRowSchema, activeTurns.get(sourceThreadId)).count > 0 ||
          decodeSync(CountRowSchema, pendingApprovals.get(sourceThreadId)).count > 0;
        if (isUnsettled) {
          skippedUnsettledBindingCount += 1;
          continue;
        }
        bindings.push({ ...binding, threadId: targetThreadId });
      }
      return { bindings, skippedInvalidBindingCount, skippedUnsettledBindingCount };
    },
  );

  const copiedBindingCount = yield* withDatabase(
    input.stagingPath,
    false,
    "copy settled provider bindings",
    (database) => {
      const upsert = database.prepare(
        `INSERT INTO provider_session_runtime (
           thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode,
           status, last_seen_at, resume_cursor_json, runtime_payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           provider_name = excluded.provider_name,
           provider_instance_id = excluded.provider_instance_id,
           adapter_key = excluded.adapter_key,
           runtime_mode = excluded.runtime_mode,
           status = excluded.status,
           last_seen_at = excluded.last_seen_at,
           resume_cursor_json = excluded.resume_cursor_json,
           runtime_payload_json = excluded.runtime_payload_json`,
      );
      let copied = 0;
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const binding of prepared.bindings) {
          upsert.run(
            binding.threadId,
            binding.providerName,
            binding.providerInstanceId,
            binding.adapterKey,
            binding.runtimeMode,
            binding.status,
            binding.lastSeenAt,
            binding.resumeCursor === null ? null : encodeUnknownJsonString(binding.resumeCursor),
            binding.runtimePayload === null
              ? null
              : encodeUnknownJsonString(binding.runtimePayload),
          );
          copied += 1;
        }
        database.exec("COMMIT");
        return copied;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
  );

  return {
    copiedBindingCount,
    skippedInvalidBindingCount: prepared.skippedInvalidBindingCount,
    skippedUnsettledBindingCount: prepared.skippedUnsettledBindingCount,
  };
});

/** Copy selected checkpoint diffs into staging while remapping their thread ids. */
export const copyCheckpointDiffBlobs = Effect.fn("copyCheckpointDiffBlobs")(function* (input: {
  readonly sourcePath: string;
  readonly stagingPath: string;
  readonly threadIdMap: ReadonlyMap<ThreadId, ThreadId>;
}): Effect.fn.Return<number, OfficialImportStorageError> {
  if (input.threadIdMap.size === 0) return 0;
  const blobs = yield* readCheckpointDiffBlobs(
    input.sourcePath,
    Array.from(input.threadIdMap.keys()),
  );
  return yield* withDatabase(input.stagingPath, false, "copy checkpoint diff blobs", (database) => {
    const upsert = database.prepare(
      `INSERT INTO checkpoint_diff_blobs (
          thread_id, from_turn_count, to_turn_count, diff, created_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, from_turn_count, to_turn_count) DO UPDATE SET
          diff = excluded.diff,
          created_at = excluded.created_at`,
    );
    let copied = 0;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const blob of blobs) {
        const targetThreadId = input.threadIdMap.get(blob.threadId);
        if (targetThreadId === undefined) continue;
        upsert.run(targetThreadId, blob.fromTurnCount, blob.toTurnCount, blob.diff, blob.createdAt);
        copied += 1;
      }
      database.exec("COMMIT");
      return copied;
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  });
});

const inferActorKind = (
  event: Omit<OrchestrationEvent, "sequence">,
): typeof OrchestrationActorKind.Type => {
  if (event.commandId !== null && event.commandId.startsWith("provider:")) return "provider";
  if (event.commandId !== null && event.commandId.startsWith("server:")) return "server";
  if (
    event.metadata.providerTurnId !== undefined ||
    event.metadata.providerItemId !== undefined ||
    event.metadata.adapterKey !== undefined
  ) {
    return "provider";
  }
  return event.commandId === null ? "server" : "client";
};

/** Append transformed canonical events to staging; SQLite assigns new global sequences. */
export const appendCanonicalEvents = Effect.fn("appendCanonicalEvents")(function* (
  workspace: ImportWorkspace,
  events: ReadonlyArray<OrchestrationEvent>,
  options?: { readonly allowActive?: boolean },
): Effect.fn.Return<
  ReadonlyMap<number, number>,
  OfficialImportStorageFailure,
  FileSystem.FileSystem | Path.Path
> {
  yield* assertWorkspaceReadyForApply(workspace, options);
  return yield* withDatabase(
    workspace.targetStagingPath,
    false,
    "append canonical import events",
    (database) => {
      const insert = database.prepare(
        `INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES (
          ?, ?, ?,
          COALESCE((SELECT MAX(stream_version) + 1 FROM orchestration_events
                    WHERE aggregate_kind = ? AND stream_id = ?), 0),
          ?, ?, ?, ?, ?, ?, ?, ?
        )`,
      );
      const sequenceMap = new Map<number, number>();
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const event of events) {
          if (sequenceMap.has(event.sequence)) {
            throw new Error(`duplicate source sequence ${event.sequence}`);
          }
          const result = insert.run(
            event.eventId,
            event.aggregateKind,
            event.aggregateId,
            event.aggregateKind,
            event.aggregateId,
            event.type,
            event.occurredAt,
            event.commandId,
            event.causationEventId,
            event.correlationId,
            inferActorKind(event),
            encodeUnknownJsonString(event.payload),
            encodeUnknownJsonString(event.metadata),
          );
          const destinationSequence = Number(result.lastInsertRowid);
          if (!Number.isSafeInteger(destinationSequence)) {
            throw new RangeError(`invalid destination sequence ${String(result.lastInsertRowid)}`);
          }
          sequenceMap.set(event.sequence, destinationSequence);
        }
        database.exec("COMMIT");
        return sequenceMap;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
  );
});

/** Copy only receipts whose source result sequence was appended in this import. */
export const rebuildCopiedCommandReceipts = Effect.fn("rebuildCopiedCommandReceipts")(
  (
    stagingPath: string,
    receipts: ReadonlyArray<OrchestrationCommandReceipt>,
    sequenceMap: ReadonlyMap<number, number>,
  ): Effect.Effect<number, OfficialImportStorageError> =>
    withDatabase(stagingPath, false, "rebuild copied command receipts", (database) => {
      const upsert = database.prepare(
        `INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(command_id) DO UPDATE SET
          aggregate_kind = excluded.aggregate_kind,
          aggregate_id = excluded.aggregate_id,
          accepted_at = excluded.accepted_at,
          result_sequence = excluded.result_sequence,
          status = excluded.status,
          error = excluded.error`,
      );
      let copied = 0;
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const receipt of receipts) {
          const destinationSequence = sequenceMap.get(receipt.resultSequence);
          if (destinationSequence === undefined) continue;
          upsert.run(
            receipt.commandId,
            receipt.aggregateKind,
            receipt.aggregateId,
            receipt.acceptedAt,
            destinationSequence,
            receipt.status,
            receipt.error,
          );
          copied += 1;
        }
        database.exec("COMMIT");
        return copied;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    }),
);

/** Remove read models before replaying canonical events; retained provider bindings survive. */
export const clearDerivedImportState = Effect.fn("clearDerivedImportState")(
  (stagingPath: string): Effect.Effect<void, OfficialImportStorageError> =>
    withDatabase(stagingPath, false, "clear derived import state", (database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const table of DERIVED_TABLES) {
          database.exec(`DELETE FROM ${sqliteIdentifier(table)}`);
        }
        database.prepare("DELETE FROM sqlite_sequence WHERE name = 'projection_turns'").run();
        database.exec("COMMIT");
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    }),
);

const safeTimestamp = (isoDateTime: string): string => isoDateTime.replaceAll(/[-:.]/g, "");

const writeJsonAtomic = Effect.fn("writeJsonAtomic")(function* (path: string, encoded: string) {
  const fs = yield* FileSystem.FileSystem;
  const temporaryPath = `${path}.tmp-${NodeCrypto.randomUUID()}`;
  yield* fs.writeFileString(temporaryPath, `${encoded}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  yield* fs.rename(temporaryPath, path);
});

interface MovedDatabaseFiles {
  readonly databasePath: string;
  readonly walPath: string | null;
  readonly shmPath: string | null;
}

const moveDatabaseFiles = Effect.fn("moveDatabaseFiles")(function* (
  sourceDatabasePath: string,
  destinationDatabasePath: string,
): Effect.fn.Return<MovedDatabaseFiles, OfficialImportStorageError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const rename = (source: string, destination: string) =>
    fs
      .rename(source, destination)
      .pipe(Effect.mapError(storageError("move database file", source)));
  const moved: Array<readonly [string, string]> = [];
  const move = Effect.gen(function* () {
    yield* rename(sourceDatabasePath, destinationDatabasePath);
    moved.push([sourceDatabasePath, destinationDatabasePath]);
    for (const suffix of ["-wal", "-shm"] as const) {
      const source = `${sourceDatabasePath}${suffix}`;
      if (
        !(yield* fs
          .exists(source)
          .pipe(Effect.mapError(storageError("inspect database sidecar", source))))
      ) {
        continue;
      }
      const destination = `${destinationDatabasePath}${suffix}`;
      yield* rename(source, destination);
      moved.push([source, destination]);
    }
    return {
      databasePath: destinationDatabasePath,
      walPath: moved.some(([source]) => source.endsWith("-wal"))
        ? `${destinationDatabasePath}-wal`
        : null,
      shmPath: moved.some(([source]) => source.endsWith("-shm"))
        ? `${destinationDatabasePath}-shm`
        : null,
    } satisfies MovedDatabaseFiles;
  });
  const result = yield* Effect.result(move);
  if (result._tag === "Success") return result.success;
  for (const [source, destination] of moved.toReversed()) {
    yield* rename(destination, source).pipe(Effect.ignore);
  }
  return yield* result.failure;
});

const fingerprintFile = async (path: string): Promise<string> =>
  `sha256:${NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(path))
    .digest("hex")}`;

const prepareAttachmentChanges = Effect.fn("prepareOfficialImportAttachmentChanges")(function* (
  attachments: ReadonlyArray<StagedImportAttachment>,
  suffix: string,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const changes: Array<ImportAttachmentChange> = [];
      for (const attachment of attachments) {
        const importedFingerprint = await fingerprintFile(attachment.stagedPath);
        let previousFingerprint: string | null = null;
        try {
          previousFingerprint = await fingerprintFile(attachment.targetPath);
        } catch (cause) {
          if (errorCode(cause) !== "ENOENT") throw cause;
        }
        if (previousFingerprint === importedFingerprint) continue;
        if (previousFingerprint !== null && !attachment.allowReplace) {
          throw new OfficialImportStorageError({
            operation: "prepare attachment cutover",
            path: attachment.targetPath,
            reason: "a different target file already uses this attachment id",
          });
        }
        changes.push({
          targetPath: attachment.targetPath,
          stagedPath: attachment.stagedPath,
          backupPath:
            previousFingerprint === null
              ? null
              : `${attachment.targetPath}.import-backup-${suffix}`,
          importedFingerprint,
          previousFingerprint,
        });
      }
      return changes;
    },
    catch: (cause) =>
      isOfficialImportStorageError(cause)
        ? cause
        : storageError(
            "prepare attachment cutover",
            attachments.at(0)?.targetPath ?? "unknown",
          )(cause),
  });
});

const applyAttachmentChanges = Effect.fn("applyOfficialImportAttachmentChanges")(function* (
  changes: ReadonlyArray<ImportAttachmentChange>,
) {
  yield* Effect.tryPromise({
    try: async () => {
      for (const change of changes) {
        await NodeFSP.mkdir(NodePath.dirname(change.targetPath), { recursive: true });
        if (change.backupPath !== null) {
          await NodeFSP.rename(change.targetPath, change.backupPath);
        }
        await NodeFSP.rename(change.stagedPath, change.targetPath);
      }
    },
    catch: storageError("apply attachment cutover", changes.at(0)?.targetPath ?? "unknown"),
  });
});

const rollbackAttachmentChanges = Effect.fn("rollbackOfficialImportAttachmentChanges")(function* (
  changes: ReadonlyArray<ImportAttachmentChange>,
) {
  yield* Effect.tryPromise({
    try: async () => {
      for (const change of changes.toReversed()) {
        let targetFingerprint: string | null = null;
        try {
          targetFingerprint = await fingerprintFile(change.targetPath);
        } catch (cause) {
          if (errorCode(cause) !== "ENOENT") throw cause;
        }
        if (targetFingerprint === change.importedFingerprint) {
          await NodeFSP.mkdir(NodePath.dirname(change.stagedPath), { recursive: true });
          try {
            await NodeFSP.rename(change.targetPath, change.stagedPath);
          } catch (cause) {
            if (errorCode(cause) !== "EEXIST") throw cause;
            await NodeFSP.rm(change.targetPath);
          }
          targetFingerprint = null;
        }
        if (targetFingerprint !== null && targetFingerprint !== change.previousFingerprint) {
          throw new Error(`attachment changed after cutover: ${change.targetPath}`);
        }
        if (change.backupPath !== null) {
          try {
            await NodeFSP.rename(change.backupPath, change.targetPath);
          } catch (cause) {
            if (errorCode(cause) !== "ENOENT") throw cause;
            if (targetFingerprint !== change.previousFingerprint) throw cause;
          }
        }
      }
    },
    catch: storageError("roll back attachment cutover", changes.at(0)?.targetPath ?? "unknown"),
  });
});

const rollbackPreparedCutover = Effect.fn("rollbackPreparedOfficialImportCutover")(function* (
  receipt: ImportCutoverReceipt,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetExists = yield* fs.exists(receipt.targetDatabasePath);
  if (targetExists) {
    const targetFingerprint = yield* fingerprintDatabase(receipt.targetDatabasePath);
    if (targetFingerprint === receipt.importedTargetFingerprint) {
      const stagingExists = yield* fs.exists(receipt.stagingDatabasePath);
      const destination = stagingExists
        ? `${receipt.stagingDatabasePath}.recovered-${NodeCrypto.randomUUID()}`
        : receipt.stagingDatabasePath;
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* moveDatabaseFiles(receipt.targetDatabasePath, destination);
    } else if (targetFingerprint !== receipt.previousTargetFingerprint) {
      return yield* new OfficialImportStorageError({
        operation: "recover interrupted import",
        path: receipt.targetDatabasePath,
        reason: "target database no longer matches either journaled fingerprint",
      });
    }
  }
  if (receipt.backupDatabasePath !== null && (yield* fs.exists(receipt.backupDatabasePath))) {
    if (yield* fs.exists(receipt.targetDatabasePath)) {
      const current = yield* fingerprintDatabase(receipt.targetDatabasePath);
      if (current !== receipt.previousTargetFingerprint) {
        return yield* new OfficialImportStorageError({
          operation: "recover interrupted import",
          path: receipt.targetDatabasePath,
          reason: "cannot restore the journaled backup over a changed target",
        });
      }
    } else {
      yield* moveDatabaseFiles(receipt.backupDatabasePath, receipt.targetDatabasePath);
    }
  }
  yield* rollbackImportCheckpointRefChanges(receipt.checkpointRefChanges);
  yield* rollbackAttachmentChanges(receipt.attachmentChanges);
});

/**
 * Replace the target only after source/target freshness and quiescence checks.
 * The old database and any WAL/SHM siblings are moved to a timestamped backup.
 */
export const cutoverImportWithinLock = Effect.fn("cutoverImportWithinLock")(function* (
  workspace: ImportWorkspace,
  options: {
    readonly attachments?: ReadonlyArray<StagedImportAttachment>;
    readonly checkpointRefChanges?: ReadonlyArray<ImportCheckpointRefChange>;
    readonly allowActive?: boolean;
  } = {},
): Effect.fn.Return<
  { readonly receipt: ImportCutoverReceipt; readonly receiptPath: string },
  OfficialImportStorageFailure,
  FileSystem.FileSystem | Path.Path
> {
  yield* assertWorkspaceReadyForApply(workspace, options);
  yield* validateCompatibleDatabase(workspace.targetStagingPath, { requireCurrent: true });
  const importedTargetFingerprint = yield* fingerprintDatabase(workspace.targetStagingPath);
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const suffix = `${safeTimestamp(createdAt)}-${NodeCrypto.randomUUID().slice(0, 8)}`;
  const backupDatabasePath =
    workspace.targetFingerprint === null
      ? null
      : `${workspace.targetDatabasePath}.backup-${suffix}`;
  const receiptPath = `${workspace.targetDatabasePath}.import-${suffix}.json`;
  const attachmentChanges = yield* prepareAttachmentChanges(options.attachments ?? [], suffix);
  const preparedReceipt: ImportCutoverReceipt = {
    version: 2,
    kind: "t3-turbo-official-import",
    status: "prepared",
    createdAt,
    sourceDatabasePath: workspace.sourceDatabasePath,
    targetDatabasePath: workspace.targetDatabasePath,
    stagingDatabasePath: workspace.targetStagingPath,
    backupDatabasePath,
    backupWalPath: null,
    backupShmPath: null,
    sourceFingerprint: workspace.sourceFingerprint,
    previousTargetFingerprint: workspace.targetFingerprint,
    importedTargetFingerprint,
    attachmentChanges,
    checkpointRefChanges: options.checkpointRefChanges ?? [],
  };

  yield* writeJsonAtomic(receiptPath, encodeCutoverReceipt(preparedReceipt)).pipe(
    Effect.mapError(storageError("persist prepared import receipt", receiptPath)),
  );
  const result = yield* Effect.result(
    Effect.gen(function* () {
      yield* applyAttachmentChanges(attachmentChanges);
      yield* applyImportCheckpointRefChanges(preparedReceipt.checkpointRefChanges);
      const moved =
        backupDatabasePath === null
          ? null
          : yield* moveDatabaseFiles(workspace.targetDatabasePath, backupDatabasePath);
      yield* moveDatabaseFiles(workspace.targetStagingPath, workspace.targetDatabasePath);
      const receipt: ImportCutoverReceipt = {
        ...preparedReceipt,
        status: "complete",
        backupWalPath: moved?.walPath ?? null,
        backupShmPath: moved?.shmPath ?? null,
      };
      yield* writeJsonAtomic(receiptPath, encodeCutoverReceipt(receipt)).pipe(
        Effect.mapError(storageError("persist complete import receipt", receiptPath)),
      );
      return { receipt, receiptPath };
    }),
  );
  if (result._tag === "Success") return result.success;
  const rollback = yield* Effect.result(rollbackPreparedCutover(preparedReceipt));
  if (rollback._tag === "Failure") {
    return yield* new OfficialImportStorageError({
      operation: "roll back interrupted import",
      path: workspace.targetDatabasePath,
      reason: `${causeMessage(result.failure)}; rollback also failed: ${causeMessage(rollback.failure)}`,
    });
  }
  return yield* result.failure;
});

const readCompleteCutoverReceipt = Effect.fn("readCompleteCutoverReceipt")(function* (
  receiptPath: string,
): Effect.fn.Return<ImportCutoverReceipt, OfficialImportStorageFailure, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const encoded = yield* fs
    .readFileString(receiptPath)
    .pipe(Effect.mapError(storageError("read import receipt", receiptPath)));
  const receipt = yield* decodeCutoverReceipt(encoded).pipe(
    Effect.mapError(storageError("decode import receipt", receiptPath)),
  );
  if (receipt.status !== "complete") {
    return yield* new OfficialImportStorageError({
      operation: "decode import receipt",
      path: receiptPath,
      reason: "cutover receipt is not complete",
    });
  }
  return receipt;
});

/**
 * Redo begins by restoring a completed cutover receipt. The caller must then
 * call prepareImportWorkspace and produce a fresh plan; stale plans are never
 * replayed implicitly.
 */
const applyRestoreAttachmentChanges = Effect.fn("applyOfficialImportRestoreAttachmentChanges")(
  function* (changes: ReadonlyArray<ImportRestoreAttachmentChange>) {
    yield* Effect.tryPromise({
      try: async () => {
        for (const change of changes) {
          try {
            const current = await fingerprintFile(change.targetPath);
            if (current !== change.importedFingerprint) {
              throw new Error(`imported attachment changed before restore: ${change.targetPath}`);
            }
            await NodeFSP.rename(change.targetPath, change.importedDisplacedPath);
          } catch (cause) {
            if (errorCode(cause) !== "ENOENT") throw cause;
          }
          if (change.previousBackupPath !== null) {
            await NodeFSP.rename(change.previousBackupPath, change.targetPath);
          }
        }
      },
      catch: storageError("restore imported attachments", changes.at(0)?.targetPath ?? "unknown"),
    });
  },
);

const rollbackRestoreAttachmentChanges = Effect.fn(
  "rollbackOfficialImportRestoreAttachmentChanges",
)(function* (changes: ReadonlyArray<ImportRestoreAttachmentChange>) {
  yield* Effect.tryPromise({
    try: async () => {
      for (const change of changes.toReversed()) {
        let targetFingerprint: string | null = null;
        try {
          targetFingerprint = await fingerprintFile(change.targetPath);
        } catch (cause) {
          if (errorCode(cause) !== "ENOENT") throw cause;
        }
        if (
          change.previousBackupPath !== null &&
          targetFingerprint === change.previousFingerprint
        ) {
          await NodeFSP.rename(change.targetPath, change.previousBackupPath);
          targetFingerprint = null;
        }
        try {
          await NodeFSP.rename(change.importedDisplacedPath, change.targetPath);
          targetFingerprint = change.importedFingerprint;
        } catch (cause) {
          if (errorCode(cause) !== "ENOENT") throw cause;
        }
        if (targetFingerprint !== change.importedFingerprint) {
          throw new Error(`cannot recover imported attachment: ${change.targetPath}`);
        }
      }
    },
    catch: storageError(
      "roll back imported attachment restore",
      changes.at(0)?.targetPath ?? "unknown",
    ),
  });
});

const rollbackPreparedRestore = Effect.fn("rollbackPreparedOfficialImportRestore")(function* (
  receipt: ImportRestoreReceipt,
) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* fs.exists(receipt.displacedDatabasePath)) {
    if (yield* fs.exists(receipt.targetDatabasePath)) {
      const targetFingerprint = yield* fingerprintDatabase(receipt.targetDatabasePath);
      if (targetFingerprint !== receipt.restoredFingerprint) {
        return yield* new OfficialImportStorageError({
          operation: "recover interrupted import restore",
          path: receipt.targetDatabasePath,
          reason: "restored target changed before the restore receipt committed",
        });
      }
      const destination =
        receipt.restoredStagingPath !== null && !(yield* fs.exists(receipt.restoredStagingPath))
          ? receipt.restoredStagingPath
          : `${receipt.targetDatabasePath}.restore-recovered-${NodeCrypto.randomUUID()}`;
      yield* moveDatabaseFiles(receipt.targetDatabasePath, destination);
    }
    yield* moveDatabaseFiles(receipt.displacedDatabasePath, receipt.targetDatabasePath);
  } else {
    const current = yield* fingerprintDatabase(receipt.targetDatabasePath);
    if (current !== receipt.importedTargetFingerprint) {
      return yield* new OfficialImportStorageError({
        operation: "recover interrupted import restore",
        path: receipt.targetDatabasePath,
        reason: "current imported target is unavailable",
      });
    }
  }
  yield* applyImportCheckpointRefChanges(receipt.checkpointRefChanges);
  yield* rollbackRestoreAttachmentChanges(receipt.attachmentChanges);
});

export const restoreImportBackupWithinLock = Effect.fn("restoreImportBackupWithinLock")(
  function* (input: {
    readonly receiptPath: string;
    readonly confirmation: string;
  }): Effect.fn.Return<
    { readonly receipt: ImportRestoreReceipt; readonly receiptPath: string },
    OfficialImportStorageFailure,
    FileSystem.FileSystem | Path.Path
  > {
    if (input.confirmation !== RESTORE_CONFIRMATION) {
      return yield* new OfficialImportConfirmationError({ expected: RESTORE_CONFIRMATION });
    }
    const cutoverReceipt = yield* readCompleteCutoverReceipt(input.receiptPath);
    const path = yield* Path.Path;
    if (cutoverReceipt.backupDatabasePath !== null) {
      yield* validateCompatibleDatabase(cutoverReceipt.backupDatabasePath);
    }
    yield* assertNoLiveImportServer("target", cutoverReceipt.targetDatabasePath);
    const currentActivity = yield* readImportActivityState(cutoverReceipt.targetDatabasePath);
    yield* failWhenActive("target", cutoverReceipt.targetDatabasePath, currentActivity);
    const currentFingerprint = yield* fingerprintDatabase(cutoverReceipt.targetDatabasePath);
    if (currentFingerprint !== cutoverReceipt.importedTargetFingerprint) {
      return yield* new OfficialImportFingerprintMismatchError({
        role: "target",
        expected: cutoverReceipt.importedTargetFingerprint,
        actual: currentFingerprint,
      });
    }

    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const suffix = `${safeTimestamp(createdAt)}-${NodeCrypto.randomUUID().slice(0, 8)}`;
    const restoredStagingPath = `${cutoverReceipt.targetDatabasePath}.restore-staging-${suffix}`;
    const displacedDatabasePath = `${cutoverReceipt.targetDatabasePath}.restore-backup-${suffix}`;
    const restoreReceiptPath = `${cutoverReceipt.targetDatabasePath}.restore-${suffix}.json`;
    if (cutoverReceipt.backupDatabasePath !== null) {
      yield* snapshotDatabase(cutoverReceipt.backupDatabasePath, restoredStagingPath);
      yield* validateCompatibleDatabase(restoredStagingPath);
    }
    const restoredFingerprint =
      cutoverReceipt.backupDatabasePath === null
        ? null
        : yield* fingerprintDatabase(restoredStagingPath);
    const attachmentRoot = path.resolve(
      path.dirname(cutoverReceipt.targetDatabasePath),
      "attachments",
    );
    for (const change of cutoverReceipt.attachmentChanges) {
      const relative = path.relative(attachmentRoot, path.resolve(change.targetPath));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        return yield* new OfficialImportStorageError({
          operation: "validate imported attachment receipt",
          path: change.targetPath,
          reason: "attachment path is outside the target attachments directory",
        });
      }
    }
    const attachmentChanges = cutoverReceipt.attachmentChanges.map((change) => ({
      targetPath: change.targetPath,
      importedDisplacedPath: `${change.targetPath}.restore-backup-${suffix}`,
      previousBackupPath: change.backupPath,
      importedFingerprint: change.importedFingerprint,
      previousFingerprint: change.previousFingerprint,
    }));
    const preparedReceipt: ImportRestoreReceipt = {
      version: 2,
      kind: "t3-turbo-official-import-restore",
      status: "prepared",
      createdAt,
      targetDatabasePath: cutoverReceipt.targetDatabasePath,
      restoredFromDatabasePath: cutoverReceipt.backupDatabasePath,
      restoredStagingPath: cutoverReceipt.backupDatabasePath === null ? null : restoredStagingPath,
      displacedDatabasePath,
      attachmentChanges,
      displacedAttachmentPaths: attachmentChanges.map((change) => change.importedDisplacedPath),
      checkpointRefChanges: cutoverReceipt.checkpointRefChanges,
      importedTargetFingerprint: cutoverReceipt.importedTargetFingerprint,
      restoredFingerprint,
    };
    yield* writeJsonAtomic(restoreReceiptPath, encodeRestoreReceipt(preparedReceipt)).pipe(
      Effect.mapError(storageError("persist prepared restore receipt", restoreReceiptPath)),
    );
    const result = yield* Effect.result(
      Effect.gen(function* () {
        yield* applyRestoreAttachmentChanges(attachmentChanges);
        yield* rollbackImportCheckpointRefChanges(cutoverReceipt.checkpointRefChanges);
        yield* moveDatabaseFiles(cutoverReceipt.targetDatabasePath, displacedDatabasePath);
        if (cutoverReceipt.backupDatabasePath !== null) {
          yield* moveDatabaseFiles(restoredStagingPath, cutoverReceipt.targetDatabasePath);
        }
        const receipt: ImportRestoreReceipt = { ...preparedReceipt, status: "complete" };
        yield* writeJsonAtomic(restoreReceiptPath, encodeRestoreReceipt(receipt)).pipe(
          Effect.mapError(storageError("persist complete restore receipt", restoreReceiptPath)),
        );
        return { receipt, receiptPath: restoreReceiptPath };
      }),
    );
    if (result._tag === "Success") return result.success;
    const rollback = yield* Effect.result(rollbackPreparedRestore(preparedReceipt));
    if (rollback._tag === "Failure") {
      return yield* new OfficialImportStorageError({
        operation: "roll back import restore",
        path: cutoverReceipt.targetDatabasePath,
        reason: `${causeMessage(result.failure)}; rollback also failed: ${causeMessage(rollback.failure)}`,
      });
    }
    return yield* result.failure;
  },
);

export const recoverOfficialImportTransactionsWithinLock = Effect.fn(
  "recoverOfficialImportTransactionsWithinLock",
)(function* (targetDatabasePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedTarget = path.resolve(targetDatabasePath);
  const directory = path.dirname(resolvedTarget);
  const basename = path.basename(resolvedTarget);
  const entries = yield* fs
    .readDirectory(directory)
    .pipe(Effect.mapError(storageError("scan official import receipts", directory)));
  for (const entry of entries.toSorted()) {
    const isCutover = entry.startsWith(`${basename}.import-`) && entry.endsWith(".json");
    const isRestore = entry.startsWith(`${basename}.restore-`) && entry.endsWith(".json");
    if (!isCutover && !isRestore) continue;
    const receiptPath = path.join(directory, entry);
    const encoded = yield* fs
      .readFileString(receiptPath)
      .pipe(Effect.mapError(storageError("read official import recovery receipt", receiptPath)));
    if (isCutover) {
      const receipt = yield* decodeCutoverReceipt(encoded).pipe(
        Effect.mapError(storageError("decode official import recovery receipt", receiptPath)),
      );
      if (
        path.resolve(receipt.targetDatabasePath) !== resolvedTarget ||
        receipt.status !== "prepared"
      ) {
        continue;
      }
      yield* rollbackPreparedCutover(receipt);
      yield* writeJsonAtomic(
        receiptPath,
        encodeCutoverReceipt({ ...receipt, status: "rolled-back" }),
      ).pipe(Effect.mapError(storageError("complete import recovery receipt", receiptPath)));
      continue;
    }
    const receipt = yield* decodeRestoreReceipt(encoded).pipe(
      Effect.mapError(storageError("decode official import restore receipt", receiptPath)),
    );
    if (
      path.resolve(receipt.targetDatabasePath) !== resolvedTarget ||
      receipt.status !== "prepared"
    ) {
      continue;
    }
    yield* rollbackPreparedRestore(receipt);
    yield* writeJsonAtomic(
      receiptPath,
      encodeRestoreReceipt({ ...receipt, status: "rolled-back" }),
    ).pipe(Effect.mapError(storageError("complete import restore recovery", receiptPath)));
  }
});

export const recoverOfficialImportTransactions = Effect.fn("recoverOfficialImportTransactions")(
  function* (targetDatabasePath: string) {
    const path = yield* Path.Path;
    const resolvedTarget = path.resolve(targetDatabasePath);
    return yield* withOfficialImportLock(
      resolvedTarget,
      recoverOfficialImportTransactionsWithinLock(resolvedTarget),
    );
  },
);

export const prepareImportWorkspace = Effect.fn("prepareImportWorkspace")(function* (input: {
  readonly sourceDatabasePath: string;
  readonly targetDatabasePath: string;
}) {
  const path = yield* Path.Path;
  const resolvedTarget = path.resolve(input.targetDatabasePath);
  return yield* withOfficialImportLock(
    resolvedTarget,
    recoverOfficialImportTransactionsWithinLock(resolvedTarget).pipe(
      Effect.andThen(prepareImportWorkspaceWithinLock(input)),
    ),
  );
});

export const cutoverImport = Effect.fn("cutoverImport")(function* (
  workspace: ImportWorkspace,
  options: {
    readonly attachments?: ReadonlyArray<StagedImportAttachment>;
    readonly checkpointRefChanges?: ReadonlyArray<ImportCheckpointRefChange>;
  } = {},
) {
  return yield* withOfficialImportLocks(
    [workspace.sourceDatabasePath, workspace.targetDatabasePath],
    recoverOfficialImportTransactionsWithinLock(workspace.targetDatabasePath).pipe(
      Effect.andThen(cutoverImportWithinLock(workspace, options)),
    ),
  );
});

export const restoreImportBackup = Effect.fn("restoreImportBackup")(function* (input: {
  readonly receiptPath: string;
  readonly confirmation: string;
}) {
  if (input.confirmation !== RESTORE_CONFIRMATION) {
    return yield* new OfficialImportConfirmationError({ expected: RESTORE_CONFIRMATION });
  }
  const receipt = yield* readCompleteCutoverReceipt(input.receiptPath);
  return yield* withOfficialImportLock(
    receipt.targetDatabasePath,
    recoverOfficialImportTransactionsWithinLock(receipt.targetDatabasePath).pipe(
      Effect.andThen(restoreImportBackupWithinLock(input)),
    ),
  );
});

/** Remove a prepared workspace after success or abandonment. */
export const removeImportWorkspace = Effect.fn("removeImportWorkspace")(function* (
  workspace: ImportWorkspace,
): Effect.fn.Return<void, OfficialImportStorageError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (
    path.resolve(path.dirname(workspace.directory)) !==
      path.resolve(path.dirname(workspace.targetDatabasePath)) ||
    !path.basename(workspace.directory).startsWith(".t3-turbo-import-")
  ) {
    return yield* new OfficialImportStorageError({
      operation: "remove import workspace",
      path: workspace.directory,
      reason: "workspace path is outside the guarded import directory pattern",
    });
  }
  return yield* fs
    .remove(workspace.directory, { recursive: true, force: false })
    .pipe(Effect.mapError(storageError("remove import workspace", workspace.directory)));
});
