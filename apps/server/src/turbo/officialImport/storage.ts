import * as NodeCrypto from "node:crypto";
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
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { migrationManifest } from "../../persistence/Migrations.ts";
import { OrchestrationCommandReceipt } from "../../persistence/Services/OrchestrationCommandReceipts.ts";

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
  "provider_session_runtime",
] as const;

const REQUIRED_COLUMNS = {
  effect_sql_migrations: ["migration_id", "name"],
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
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

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

export const ImportCutoverReceipt = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("t3-turbo-official-import"),
  status: Schema.Literals(["prepared", "complete"]),
  createdAt: IsoDateTime,
  sourceDatabasePath: Schema.String,
  targetDatabasePath: Schema.String,
  backupDatabasePath: Schema.String,
  backupWalPath: Schema.NullOr(Schema.String),
  backupShmPath: Schema.NullOr(Schema.String),
  sourceFingerprint: Schema.String,
  previousTargetFingerprint: Schema.String,
  importedTargetFingerprint: Schema.String,
  installedAttachmentPaths: Schema.Array(Schema.String),
});
export type ImportCutoverReceipt = typeof ImportCutoverReceipt.Type;

export const ImportRestoreReceipt = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("t3-turbo-official-import-restore"),
  createdAt: IsoDateTime,
  targetDatabasePath: Schema.String,
  restoredFromDatabasePath: Schema.String,
  displacedDatabasePath: Schema.String,
  displacedAttachmentPaths: Schema.Array(Schema.String),
  restoredFingerprint: Schema.String,
});
export type ImportRestoreReceipt = typeof ImportRestoreReceipt.Type;

const encodeCutoverReceipt = Schema.encodeSync(Schema.fromJsonString(ImportCutoverReceipt));
const encodeRestoreReceipt = Schema.encodeSync(Schema.fromJsonString(ImportRestoreReceipt));

export interface ImportWorkspace {
  readonly directory: string;
  readonly sourceDatabasePath: string;
  readonly targetDatabasePath: string;
  readonly sourceSnapshotPath: string;
  readonly targetStagingPath: string;
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
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

export type OfficialImportStorageFailure =
  | OfficialImportStorageError
  | OfficialImportSchemaMismatchError
  | OfficialImportFingerprintMismatchError
  | OfficialImportActiveStateError
  | OfficialImportLiveServerError
  | OfficialImportConfirmationError;

export const RESTORE_CONFIRMATION = "RESTORE T3 TURBO FROM IMPORT BACKUP";

const RowArraySchema = Schema.Array(Schema.Unknown);
const TableNameRowsSchema = Schema.Array(Schema.Struct({ name: Schema.String }));
const TableInfoRowsSchema = Schema.Array(Schema.Struct({ name: Schema.String }));
const MigrationRowsSchema = Schema.Array(
  Schema.Struct({ migrationId: Schema.Number, name: Schema.String }),
);
const CountRowSchema = Schema.Struct({ count: NonNegativeInt });
const ImportRuntimeState = Schema.Struct({ version: Schema.Literal(1), pid: Schema.Int });

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
  const runtime = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ImportRuntimeState))(
    encoded,
  ).pipe(Effect.mapError(storageError("validate import server ownership", runtimeStatePath)));
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

const validateDatabase = (database: NodeSqlite.DatabaseSync, path: string): void => {
  const names = new Set(tableNames(database));
  for (const [table, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
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

  const migrations = decodeSync(
    MigrationRowsSchema,
    database
      .prepare(
        'SELECT migration_id AS "migrationId", name FROM effect_sql_migrations ORDER BY migration_id',
      )
      .all(),
  );
  const exact =
    migrations.length === migrationManifest.length &&
    migrations.every((migration, index) => {
      const expected = migrationManifest[index];
      return migration.migrationId === expected?.[0] && migration.name === expected?.[1];
    });
  if (!exact) {
    throw new OfficialImportSchemaMismatchError({
      path,
      reason: "migration history differs from this build",
    });
  }
};

export const validateCompatibleDatabase = Effect.fn("validateCompatibleDatabase")(
  (path: string): Effect.Effect<void, OfficialImportStorageFailure> =>
    Effect.try({
      try: () => {
        const database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
        try {
          validateDatabase(database, path);
        } finally {
          database.close();
        }
      },
      catch: (cause) =>
        Schema.is(OfficialImportSchemaMismatchError)(cause)
          ? cause
          : storageError("validate schema", path)(cause),
    }),
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
export const prepareImportWorkspace = Effect.fn("prepareImportWorkspace")(function* (input: {
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
  yield* validateCompatibleDatabase(targetDatabasePath);
  const directory = yield* makeWorkspaceDirectory(targetDatabasePath);
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const sourceSnapshotPath = path.join(directory, "official-source.sqlite");
    const targetStagingPath = path.join(directory, "turbo-target-staging.sqlite");

    yield* snapshotDatabase(sourceDatabasePath, sourceSnapshotPath);
    yield* snapshotDatabase(targetDatabasePath, targetStagingPath);
    yield* validateCompatibleDatabase(sourceSnapshotPath);
    yield* validateCompatibleDatabase(targetStagingPath);

    const [sourceFingerprint, liveSourceFingerprint, targetFingerprint, liveTargetFingerprint] =
      yield* Effect.all([
        fingerprintDatabase(sourceSnapshotPath),
        fingerprintDatabase(sourceDatabasePath),
        fingerprintDatabase(targetStagingPath),
        fingerprintDatabase(targetDatabasePath),
      ]);
    if (sourceFingerprint !== liveSourceFingerprint) {
      return yield* new OfficialImportFingerprintMismatchError({
        role: "source",
        expected: sourceFingerprint,
        actual: liveSourceFingerprint,
      });
    }
    if (targetFingerprint !== liveTargetFingerprint) {
      return yield* new OfficialImportFingerprintMismatchError({
        role: "target",
        expected: targetFingerprint,
        actual: liveTargetFingerprint,
      });
    }

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
});

export const assertWorkspaceReadyForApply = Effect.fn("assertWorkspaceReadyForApply")(function* (
  workspace: ImportWorkspace,
): Effect.fn.Return<void, OfficialImportStorageFailure, FileSystem.FileSystem | Path.Path> {
  yield* Effect.all([
    assertNoLiveImportServer("source", workspace.sourceDatabasePath),
    assertNoLiveImportServer("target", workspace.targetDatabasePath),
  ]);
  const [sourceFingerprint, targetFingerprint, sourceActivity, targetActivity] = yield* Effect.all([
    fingerprintDatabase(workspace.sourceDatabasePath),
    fingerprintDatabase(workspace.targetDatabasePath),
    readImportActivityState(workspace.sourceDatabasePath),
    readImportActivityState(workspace.targetDatabasePath),
  ]);
  if (sourceFingerprint !== workspace.sourceFingerprint) {
    return yield* new OfficialImportFingerprintMismatchError({
      role: "source",
      expected: workspace.sourceFingerprint,
      actual: sourceFingerprint,
    });
  }
  if (targetFingerprint !== workspace.targetFingerprint) {
    return yield* new OfficialImportFingerprintMismatchError({
      role: "target",
      expected: workspace.targetFingerprint,
      actual: targetFingerprint,
    });
  }
  yield* failWhenActive("source", workspace.sourceDatabasePath, sourceActivity);
  yield* failWhenActive("target", workspace.targetDatabasePath, targetActivity);
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
): Effect.fn.Return<
  ReadonlyMap<number, number>,
  OfficialImportStorageFailure,
  FileSystem.FileSystem | Path.Path
> {
  yield* assertWorkspaceReadyForApply(workspace);
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

/** Remove all read models and provider bindings before replaying every canonical event. */
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

/**
 * Replace the target only after source/target freshness and quiescence checks.
 * The old database and any WAL/SHM siblings are moved to a timestamped backup.
 */
export const cutoverImport = Effect.fn("cutoverImport")(function* (
  workspace: ImportWorkspace,
  installedAttachmentPaths: ReadonlyArray<string> = [],
): Effect.fn.Return<
  { readonly receipt: ImportCutoverReceipt; readonly receiptPath: string },
  OfficialImportStorageFailure,
  FileSystem.FileSystem | Path.Path
> {
  yield* assertWorkspaceReadyForApply(workspace);
  yield* validateCompatibleDatabase(workspace.targetStagingPath);
  const importedTargetFingerprint = yield* fingerprintDatabase(workspace.targetStagingPath);
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const suffix = `${safeTimestamp(createdAt)}-${NodeCrypto.randomUUID().slice(0, 8)}`;
  const backupDatabasePath = `${workspace.targetDatabasePath}.backup-${suffix}`;
  const receiptPath = `${workspace.targetDatabasePath}.import-${suffix}.json`;
  const preparedReceipt: ImportCutoverReceipt = {
    version: 1,
    kind: "t3-turbo-official-import",
    status: "prepared",
    createdAt,
    sourceDatabasePath: workspace.sourceDatabasePath,
    targetDatabasePath: workspace.targetDatabasePath,
    backupDatabasePath,
    backupWalPath: null,
    backupShmPath: null,
    sourceFingerprint: workspace.sourceFingerprint,
    previousTargetFingerprint: workspace.targetFingerprint,
    importedTargetFingerprint,
    installedAttachmentPaths,
  };

  const fs = yield* FileSystem.FileSystem;
  const moved = yield* moveDatabaseFiles(workspace.targetDatabasePath, backupDatabasePath);
  const installResult = yield* Effect.result(
    fs.rename(workspace.targetStagingPath, workspace.targetDatabasePath),
  );
  if (installResult._tag === "Failure") {
    const restoreResult = yield* Effect.result(
      moveDatabaseFiles(backupDatabasePath, workspace.targetDatabasePath),
    );
    if (restoreResult._tag === "Failure") {
      return yield* new OfficialImportStorageError({
        operation: "roll back failed import install",
        path: workspace.targetDatabasePath,
        reason: `${causeMessage(installResult.failure)}; backup restore also failed: ${causeMessage(restoreResult.failure)}`,
      });
    }
    return yield* new OfficialImportStorageError({
      operation: "atomically install imported database",
      path: workspace.targetDatabasePath,
      reason: causeMessage(installResult.failure),
    });
  }

  const receipt: ImportCutoverReceipt = {
    ...preparedReceipt,
    status: "complete",
    backupWalPath: moved.walPath,
    backupShmPath: moved.shmPath,
  };
  const receiptResult = yield* Effect.result(
    writeJsonAtomic(receiptPath, encodeCutoverReceipt(receipt)),
  );
  if (receiptResult._tag === "Success") return { receipt, receiptPath };

  // Receipt persistence is part of cutover. If it fails, put the imported
  // database back in the guarded workspace and restore the exact old target.
  const failedImportedPath = `${workspace.targetStagingPath}.receipt-failed-${NodeCrypto.randomUUID()}`;
  const displaceImportedResult = yield* Effect.result(
    moveDatabaseFiles(workspace.targetDatabasePath, failedImportedPath),
  );
  if (displaceImportedResult._tag === "Failure") {
    return yield* new OfficialImportStorageError({
      operation: "roll back import after receipt failure",
      path: workspace.targetDatabasePath,
      reason: `${causeMessage(receiptResult.failure)}; imported database could not be displaced: ${causeMessage(displaceImportedResult.failure)}`,
    });
  }

  const restoreResult = yield* Effect.result(
    moveDatabaseFiles(backupDatabasePath, workspace.targetDatabasePath),
  );
  if (restoreResult._tag === "Failure") {
    const retainImportedResult = yield* Effect.result(
      moveDatabaseFiles(failedImportedPath, workspace.targetDatabasePath),
    );
    return yield* new OfficialImportStorageError({
      operation: "roll back import after receipt failure",
      path: workspace.targetDatabasePath,
      reason:
        retainImportedResult._tag === "Success"
          ? `${causeMessage(receiptResult.failure)}; old target restore failed, so the complete imported database was retained: ${causeMessage(restoreResult.failure)}`
          : `${causeMessage(receiptResult.failure)}; old target restore failed: ${causeMessage(restoreResult.failure)}; imported database recovery also failed: ${causeMessage(retainImportedResult.failure)}`,
    });
  }

  return yield* new OfficialImportStorageError({
    operation: "persist import recovery receipt",
    path: receiptPath,
    reason: causeMessage(receiptResult.failure),
  });
});

const readCompleteCutoverReceipt = Effect.fn("readCompleteCutoverReceipt")(function* (
  receiptPath: string,
): Effect.fn.Return<ImportCutoverReceipt, OfficialImportStorageFailure, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const encoded = yield* fs
    .readFileString(receiptPath)
    .pipe(Effect.mapError(storageError("read import receipt", receiptPath)));
  const receipt = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ImportCutoverReceipt))(
    encoded,
  ).pipe(Effect.mapError(storageError("decode import receipt", receiptPath)));
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
export const restoreImportBackup = Effect.fn("restoreImportBackup")(function* (input: {
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
  yield* validateCompatibleDatabase(cutoverReceipt.backupDatabasePath);
  yield* assertNoLiveImportServer("target", cutoverReceipt.targetDatabasePath);
  const currentActivity = yield* readImportActivityState(cutoverReceipt.targetDatabasePath);
  yield* failWhenActive("target", cutoverReceipt.targetDatabasePath, currentActivity);

  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const suffix = `${safeTimestamp(createdAt)}-${NodeCrypto.randomUUID().slice(0, 8)}`;
  const restoredStagingPath = `${cutoverReceipt.targetDatabasePath}.restore-staging-${suffix}`;
  const displacedDatabasePath = `${cutoverReceipt.targetDatabasePath}.restore-backup-${suffix}`;
  const restoreReceiptPath = `${cutoverReceipt.targetDatabasePath}.restore-${suffix}.json`;
  yield* snapshotDatabase(cutoverReceipt.backupDatabasePath, restoredStagingPath);
  yield* validateCompatibleDatabase(restoredStagingPath);
  const restoredFingerprint = yield* fingerprintDatabase(restoredStagingPath);
  const attachmentRoot = path.resolve(
    path.dirname(cutoverReceipt.targetDatabasePath),
    "attachments",
  );
  for (const attachmentPath of cutoverReceipt.installedAttachmentPaths) {
    const relative = path.relative(attachmentRoot, path.resolve(attachmentPath));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* new OfficialImportStorageError({
        operation: "validate imported attachment receipt",
        path: attachmentPath,
        reason: "attachment path is outside the target attachments directory",
      });
    }
  }

  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const displacedAttachments: Array<readonly [string, string]> = [];
    for (const attachmentPath of cutoverReceipt.installedAttachmentPaths) {
      if (!(yield* fs.exists(attachmentPath))) continue;
      const backupPath = `${attachmentPath}.restore-backup-${suffix}`;
      const result = yield* Effect.result(fs.rename(attachmentPath, backupPath));
      if (result._tag === "Failure") {
        for (const [originalPath, displacedPath] of displacedAttachments.toReversed()) {
          yield* fs.rename(displacedPath, originalPath).pipe(Effect.ignore);
        }
        return yield* result.failure;
      }
      displacedAttachments.push([attachmentPath, backupPath]);
    }
    const moveTargetResult = yield* Effect.result(
      moveDatabaseFiles(cutoverReceipt.targetDatabasePath, displacedDatabasePath),
    );
    if (moveTargetResult._tag === "Failure") {
      for (const [originalPath, displacedPath] of displacedAttachments.toReversed()) {
        yield* fs.rename(displacedPath, originalPath).pipe(Effect.ignore);
      }
      return yield* moveTargetResult.failure;
    }
    const restoreResult = yield* Effect.result(
      fs.rename(restoredStagingPath, cutoverReceipt.targetDatabasePath),
    );
    if (restoreResult._tag === "Failure") {
      yield* moveDatabaseFiles(displacedDatabasePath, cutoverReceipt.targetDatabasePath);
      for (const [originalPath, displacedPath] of displacedAttachments.toReversed()) {
        yield* fs.rename(displacedPath, originalPath).pipe(Effect.ignore);
      }
      return yield* restoreResult.failure;
    }
    const receipt: ImportRestoreReceipt = {
      version: 1,
      kind: "t3-turbo-official-import-restore",
      createdAt,
      targetDatabasePath: cutoverReceipt.targetDatabasePath,
      restoredFromDatabasePath: cutoverReceipt.backupDatabasePath,
      displacedDatabasePath,
      displacedAttachmentPaths: displacedAttachments.map(([, backupPath]) => backupPath),
      restoredFingerprint,
    };
    yield* writeJsonAtomic(restoreReceiptPath, encodeRestoreReceipt(receipt));
    return { receipt, receiptPath: restoreReceiptPath };
  }).pipe(
    Effect.mapError(storageError("restore import backup", cutoverReceipt.targetDatabasePath)),
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
