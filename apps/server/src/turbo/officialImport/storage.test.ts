// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PlatformError from "effect/PlatformError";
import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";

import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { prepareImportCheckpointRefChanges } from "./checkpointRefs.ts";
import { prepareOfficialImport } from "./execute.ts";
import {
  RESTORE_CONFIRMATION,
  appendCanonicalEvents,
  assertNoLiveImportServer,
  clearDerivedImportState,
  copyCheckpointDiffBlobs,
  copySettledProviderSessionRuntimeBindings,
  cutoverImport,
  deleteCanonicalThreadStreams,
  deleteProviderSessionRuntimeBindings,
  fingerprintDatabase,
  prepareImportWorkspace,
  readCheckpointDiffBlobs,
  readCommandReceipts,
  readImportActivityState,
  readOrchestrationEvents,
  readProjectRows,
  recoverOfficialImportTransactions,
  rebuildCopiedCommandReceipts,
  restoreImportBackup,
  withOfficialImportLock,
} from "./storage.ts";

const NOW = "2026-08-04T12:00:00.000Z";
const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

const schemaSql = `
  CREATE TABLE effect_sql_migrations (
    migration_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE orchestration_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    aggregate_kind TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    stream_version INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    command_id TEXT,
    causation_event_id TEXT,
    correlation_id TEXT,
    actor_kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    UNIQUE (aggregate_kind, stream_id, stream_version)
  );
  CREATE TABLE orchestration_command_receipts (
    command_id TEXT PRIMARY KEY,
    aggregate_kind TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    result_sequence INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT
  );
  CREATE TABLE checkpoint_diff_blobs (
    thread_id TEXT NOT NULL,
    from_turn_count INTEGER NOT NULL,
    to_turn_count INTEGER NOT NULL,
    diff TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (thread_id, from_turn_count, to_turn_count)
  );
  CREATE TABLE projection_projects (
    project_id TEXT PRIMARY KEY,
    workspace_root TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE TABLE projection_threads (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE TABLE projection_thread_messages (message_id TEXT PRIMARY KEY);
  CREATE TABLE projection_thread_activities (activity_id TEXT PRIMARY KEY);
  CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY, status TEXT NOT NULL);
  CREATE TABLE projection_turns (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    state TEXT NOT NULL
  );
  CREATE TABLE projection_pending_approvals (
    request_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL
  );
  CREATE TABLE projection_state (
    projector TEXT PRIMARY KEY,
    last_applied_sequence INTEGER NOT NULL
  );
  CREATE TABLE projection_thread_proposed_plans (plan_id TEXT PRIMARY KEY);
  CREATE TABLE provider_session_runtime (
    thread_id TEXT PRIMARY KEY,
    provider_name TEXT NOT NULL DEFAULT 'codex',
    provider_instance_id TEXT,
    adapter_key TEXT NOT NULL DEFAULT 'codex',
    runtime_mode TEXT NOT NULL DEFAULT 'full-access',
    status TEXT NOT NULL,
    last_seen_at TEXT NOT NULL DEFAULT '2026-08-04T12:00:00.000Z',
    resume_cursor_json TEXT,
    runtime_payload_json TEXT
  );
`;

const makeProjectCreatedPayload = (projectId: string, workspaceRoot: string) =>
  JSON.stringify({
    projectId,
    title: projectId,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  });

function createFixtureDatabase(
  path: string,
  input: { readonly id: string; readonly active?: boolean },
): void {
  const projectId = `project-${input.id}`;
  const eventId = `event-${input.id}`;
  const commandId = `command-${input.id}`;
  const threadId = `thread-${input.id}`;
  const database = new NodeSqlite.DatabaseSync(path);
  try {
    database.exec(schemaSql);
    const insertMigration = database.prepare(
      "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)",
    );
    for (const [migrationId, name] of migrationManifest) {
      insertMigration.run(migrationId, name);
    }
    database
      .prepare(
        `INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES (?, 'project', ?, 0, 'project.created', ?, ?, NULL, ?, 'client', ?, '{}')`,
      )
      .run(
        eventId,
        projectId,
        NOW,
        commandId,
        commandId,
        makeProjectCreatedPayload(projectId, path),
      );
    database
      .prepare(
        `INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error
        ) VALUES (?, 'project', ?, ?, 1, 'accepted', NULL)`,
      )
      .run(commandId, projectId, NOW);
    database
      .prepare(
        "INSERT INTO projection_projects (project_id, workspace_root, deleted_at) VALUES (?, ?, NULL)",
      )
      .run(projectId, path);
    database
      .prepare(
        "INSERT INTO projection_threads (thread_id, project_id, updated_at, deleted_at) VALUES (?, ?, ?, NULL)",
      )
      .run(threadId, projectId, NOW);
    database
      .prepare("INSERT INTO projection_thread_sessions (thread_id, status) VALUES (?, ?)")
      .run(threadId, input.active ? "running" : "stopped");
    database
      .prepare("INSERT INTO provider_session_runtime (thread_id, status) VALUES (?, ?)")
      .run(threadId, input.active ? "running" : "stopped");
    database
      .prepare(
        `INSERT INTO checkpoint_diff_blobs
          (thread_id, from_turn_count, to_turn_count, diff, created_at)
         VALUES (?, 0, 1, ?, ?)`,
      )
      .run(threadId, `diff-${input.id}`, NOW);
    if (input.active) {
      database
        .prepare("INSERT INTO projection_turns (thread_id, state) VALUES (?, 'running')")
        .run(threadId);
      database
        .prepare(
          "INSERT INTO projection_pending_approvals (request_id, thread_id, status) VALUES (?, ?, 'pending')",
        )
        .run(`request-${input.id}`, threadId);
    }
  } finally {
    database.close();
  }
}

const withDatabases = <A, E, R>(
  use: (paths: {
    readonly directory: string;
    readonly source: string;
    readonly target: string;
  }) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-official-import-storage-")),
    ),
    (directory) => {
      const source = NodePath.join(directory, "source.sqlite");
      const target = NodePath.join(directory, "target.sqlite");
      createFixtureDatabase(source, { id: "source" });
      createFixtureDatabase(target, { id: "target" });
      return use({ directory, source, target });
    },
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );

const withTemporaryDirectory = <A, E, R>(
  prefix: string,
  use: (directory: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix))),
    use,
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );

const initializeDatabaseThroughMigration = (path: string, migrationId: number) =>
  runMigrations({ toMigrationInclusive: migrationId }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: path })),
    Effect.scoped,
  );

const git = (repositoryPath: string, args: ReadonlyArray<string>) =>
  Effect.promise(() => execFileAsync("git", ["-C", repositoryPath, ...args]));

const resolveGitRef = (repositoryPath: string, ref: string) =>
  Effect.promise(() =>
    execFileAsync("git", ["-C", repositoryPath, "rev-parse", ref]).then(
      ({ stdout }) => stdout.trim(),
      () => null,
    ),
  );

it.effect("imports only into staging and never modifies the source database", () =>
  withDatabases(({ source, target }) =>
    Effect.gen(function* () {
      const sourceBefore = yield* fingerprintDatabase(source);
      const targetBefore = yield* fingerprintDatabase(target);
      const workspace = yield* prepareImportWorkspace({
        sourceDatabasePath: source,
        targetDatabasePath: target,
      });
      const events = yield* readOrchestrationEvents(workspace.sourceSnapshotPath);
      const receipts = yield* readCommandReceipts(workspace.sourceSnapshotPath);
      const sequenceMap = yield* appendCanonicalEvents(workspace, events);
      assert.equal(sequenceMap.get(1), 2);
      assert.equal(
        yield* rebuildCopiedCommandReceipts(workspace.targetStagingPath, receipts, sequenceMap),
        1,
      );

      assert.equal((yield* readOrchestrationEvents(source)).length, 1);
      assert.equal((yield* readOrchestrationEvents(target)).length, 1);
      assert.equal((yield* readOrchestrationEvents(workspace.targetStagingPath)).length, 2);
      assert.equal(yield* fingerprintDatabase(source), sourceBefore);
      assert.equal(yield* fingerprintDatabase(target), targetBefore);

      yield* clearDerivedImportState(workspace.targetStagingPath);
      assert.equal((yield* readProjectRows(workspace.targetStagingPath)).length, 0);
      assert.deepEqual(yield* readImportActivityState(workspace.targetStagingPath), {
        activeProviderSessions: 0,
        activeProjectedSessions: 0,
        activeTurns: 0,
        pendingApprovals: 0,
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rolls back a failed staged append and leaves the target unchanged", () =>
  withDatabases(({ source, target }) =>
    Effect.gen(function* () {
      const targetBefore = yield* fingerprintDatabase(target);
      const workspace = yield* prepareImportWorkspace({
        sourceDatabasePath: source,
        targetDatabasePath: target,
      });
      const [event] = yield* readOrchestrationEvents(workspace.sourceSnapshotPath);
      assert.ok(event !== undefined);
      const result = yield* Effect.result(appendCanonicalEvents(workspace, [event, event]));
      assert.equal(result._tag, "Failure");
      assert.equal((yield* readOrchestrationEvents(workspace.targetStagingPath)).length, 1);
      assert.equal(yield* fingerprintDatabase(target), targetBefore);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("creates a recoverable backup and restores it only with confirmation", () =>
  withDatabases(({ source, target }) =>
    Effect.gen(function* () {
      const targetBefore = yield* fingerprintDatabase(target);
      const sourceBefore = yield* fingerprintDatabase(source);
      const workspace = yield* prepareImportWorkspace({
        sourceDatabasePath: source,
        targetDatabasePath: target,
      });
      const installedAttachmentPath = NodePath.join(
        NodePath.dirname(target),
        "attachments",
        "imported-attachment",
      );
      const stagedAttachmentPath = NodePath.join(
        workspace.directory,
        "attachments",
        "imported-attachment",
      );
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(stagedAttachmentPath), { recursive: true }),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(stagedAttachmentPath, "imported"));
      const events = yield* readOrchestrationEvents(workspace.sourceSnapshotPath);
      yield* appendCanonicalEvents(workspace, events);
      const cutover = yield* cutoverImport(workspace, {
        attachments: [
          {
            sourcePath: stagedAttachmentPath,
            stagedPath: stagedAttachmentPath,
            targetPath: installedAttachmentPath,
            allowReplace: false,
          },
        ],
      });
      assert.equal(cutover.receipt.status, "complete");
      assert.equal((yield* readOrchestrationEvents(target)).length, 2);
      assert.notEqual(yield* fingerprintDatabase(target), targetBefore);
      assert.equal(yield* fingerprintDatabase(source), sourceBefore);

      const denied = yield* Effect.result(
        restoreImportBackup({ receiptPath: cutover.receiptPath, confirmation: "restore" }),
      );
      assert.equal(denied._tag, "Failure");

      const restored = yield* restoreImportBackup({
        receiptPath: cutover.receiptPath,
        confirmation: RESTORE_CONFIRMATION,
      });
      assert.equal(restored.receipt.kind, "t3-turbo-official-import-restore");
      assert.equal(restored.receipt.displacedAttachmentPaths.length, 1);
      assert.isTrue(
        yield* Effect.promise(() =>
          NodeFSP.access(installedAttachmentPath).then(
            () => false,
            () => true,
          ),
        ),
      );
      yield* Effect.promise(() => NodeFSP.access(restored.receipt.displacedAttachmentPaths[0]!));
      assert.equal(yield* fingerprintDatabase(target), targetBefore);
      assert.equal((yield* readOrchestrationEvents(target)).length, 1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("restores the exact target when writing the recovery receipt fails", () =>
  withDatabases(({ source, target }) =>
    Effect.gen(function* () {
      const targetBefore = yield* fingerprintDatabase(target);
      const workspace = yield* prepareImportWorkspace({
        sourceDatabasePath: source,
        targetDatabasePath: target,
      });
      const events = yield* readOrchestrationEvents(workspace.sourceSnapshotPath);
      yield* appendCanonicalEvents(workspace, events);

      const fileSystem = yield* FileSystem.FileSystem;
      const receiptFailure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "writeFileString",
        pathOrDescriptor: target,
      });
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFileString: (path, contents, options) =>
          String(path).includes(".import-")
            ? Effect.fail(receiptFailure)
            : fileSystem.writeFileString(path, contents, options),
      });

      const result = yield* cutoverImport(workspace).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
        Effect.result,
      );

      assert.equal(result._tag, "Failure");
      assert.equal(yield* fingerprintDatabase(target), targetBefore);
      assert.equal((yield* readOrchestrationEvents(target)).length, 1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("blocks apply when a runtime descriptor belongs to a live process", () =>
  withDatabases(({ directory, source }) =>
    Effect.gen(function* () {
      const runtimeStatePath = NodePath.join(directory, "server-runtime.json");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(runtimeStatePath, `{"version":1,"pid":${process.pid}}`),
      );

      const result = yield* Effect.result(assertNoLiveImportServer("source", source));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "OfficialImportLiveServerError");
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("removes a fresh import workspace when preparation fails after snapshotting", () =>
  withDatabases(({ directory, source, target }) =>
    Effect.gen(function* () {
      const existingWorkspaceName = ".t3-turbo-import-user-kept";
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(directory, existingWorkspaceName)));
      const database = new NodeSqlite.DatabaseSync(source);
      try {
        database
          .prepare(
            `INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
            ) VALUES (?, 'thread', ?, 0, 'thread.deleted', ?, ?, NULL, ?, 'client', ?, '{}')`,
          )
          .run(
            "event-incomplete-thread",
            "thread-incomplete",
            NOW,
            "command-incomplete-thread",
            "command-incomplete-thread",
            `{"threadId":"thread-incomplete","deletedAt":"${NOW}"}`,
          );
      } finally {
        database.close();
      }

      const exit = yield* Effect.exit(
        prepareOfficialImport({ sourceDatabasePath: source, targetDatabasePath: target }),
      );
      assert.equal(exit._tag, "Failure");
      const leftovers = (yield* Effect.promise(() => NodeFSP.readdir(directory))).filter((entry) =>
        entry.startsWith(".t3-turbo-import-"),
      );
      assert.deepEqual(leftovers, [existingWorkspaceName]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("replaces selected thread streams without renumbering and remaps checkpoint diffs", () =>
  withDatabases(({ source, target }) =>
    Effect.gen(function* () {
      const database = new NodeSqlite.DatabaseSync(target);
      try {
        database
          .prepare(
            `INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
            ) VALUES (?, 'thread', ?, 0, 'thread.created', ?, ?, NULL, ?, 'client', '{}', '{}')`,
          )
          .run(
            "event-target-thread",
            "thread-target",
            NOW,
            "command-target-thread",
            "command-target-thread",
          );
        database
          .prepare(
            `INSERT INTO orchestration_command_receipts (
              command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error
            ) VALUES (?, 'thread', ?, ?, 2, 'accepted', NULL)`,
          )
          .run("command-target-thread", "thread-target", NOW);
      } finally {
        database.close();
      }

      const workspace = yield* prepareImportWorkspace({
        sourceDatabasePath: source,
        targetDatabasePath: target,
      });
      assert.equal(
        yield* deleteCanonicalThreadStreams(workspace.targetStagingPath, [
          ThreadId.make("thread-target"),
        ]),
        1,
      );
      assert.equal((yield* readCommandReceipts(workspace.targetStagingPath)).length, 1);
      assert.equal(
        (yield* readCheckpointDiffBlobs(workspace.targetStagingPath, [
          ThreadId.make("thread-target"),
        ])).length,
        0,
      );
      const staging = new NodeSqlite.DatabaseSync(workspace.targetStagingPath, {
        readOnly: true,
      });
      try {
        assert.equal(
          staging
            .prepare("SELECT COUNT(*) AS count FROM provider_session_runtime WHERE thread_id = ?")
            .get("thread-target")?.count,
          0,
        );
      } finally {
        staging.close();
      }

      const sourceEvents = yield* readOrchestrationEvents(workspace.sourceSnapshotPath);
      const sequenceMap = yield* appendCanonicalEvents(workspace, sourceEvents);
      assert.equal(sequenceMap.get(1), 3);

      assert.equal(
        yield* copyCheckpointDiffBlobs({
          sourcePath: workspace.sourceSnapshotPath,
          stagingPath: workspace.targetStagingPath,
          threadIdMap: new Map([[ThreadId.make("thread-source"), ThreadId.make("thread-clone")]]),
        }),
        1,
      );
      const copied = yield* readCheckpointDiffBlobs(workspace.targetStagingPath, [
        ThreadId.make("thread-clone"),
      ]);
      assert.equal(copied.length, 1);
      assert.equal(copied[0]?.diff, "diff-source");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("blocks apply while a session, turn, or approval is active", () =>
  Effect.acquireUseRelease(
    Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-official-import-active-")),
    ),
    (directory) =>
      Effect.gen(function* () {
        const source = NodePath.join(directory, "source.sqlite");
        const target = NodePath.join(directory, "target.sqlite");
        createFixtureDatabase(source, { id: "source", active: true });
        createFixtureDatabase(target, { id: "target" });
        const workspace = yield* prepareImportWorkspace({
          sourceDatabasePath: source,
          targetDatabasePath: target,
        });
        assert.deepEqual(workspace.sourceActivity, {
          activeProviderSessions: 1,
          activeProjectedSessions: 1,
          activeTurns: 1,
          pendingApprovals: 1,
        });
        const events = yield* readOrchestrationEvents(workspace.sourceSnapshotPath);
        const result = yield* Effect.result(appendCanonicalEvents(workspace, events));
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure._tag, "OfficialImportActiveStateError");
        }
        assert.equal((yield* readOrchestrationEvents(target)).length, 1);
      }),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("recovers an interrupted prepared cutover before the next startup", () =>
  withDatabases(({ source, target }) =>
    Effect.gen(function* () {
      const targetBefore = yield* fingerprintDatabase(target);
      const workspace = yield* prepareImportWorkspace({
        sourceDatabasePath: source,
        targetDatabasePath: target,
      });
      const events = yield* readOrchestrationEvents(workspace.sourceSnapshotPath);
      yield* appendCanonicalEvents(workspace, events);
      const cutover = yield* cutoverImport(workspace);
      assert.notEqual(yield* fingerprintDatabase(target), targetBefore);

      const completeReceipt = yield* Effect.promise(() =>
        NodeFSP.readFile(cutover.receiptPath, "utf8"),
      );
      const preparedReceipt = completeReceipt.replace(
        /"status"\s*:\s*"complete"/,
        '"status":"prepared"',
      );
      assert.notEqual(preparedReceipt, completeReceipt);
      yield* Effect.promise(() => NodeFSP.writeFile(cutover.receiptPath, preparedReceipt));

      yield* recoverOfficialImportTransactions(target);

      assert.equal(yield* fingerprintDatabase(target), targetBefore);
      assert.include(
        yield* Effect.promise(() => NodeFSP.readFile(cutover.receiptPath, "utf8")),
        '"status":"rolled-back"',
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rolls a restore back when its complete receipt cannot be persisted", () =>
  withDatabases(({ source, target }) =>
    Effect.gen(function* () {
      const workspace = yield* prepareImportWorkspace({
        sourceDatabasePath: source,
        targetDatabasePath: target,
      });
      const events = yield* readOrchestrationEvents(workspace.sourceSnapshotPath);
      yield* appendCanonicalEvents(workspace, events);
      const cutover = yield* cutoverImport(workspace);
      const importedFingerprint = yield* fingerprintDatabase(target);

      const fileSystem = yield* FileSystem.FileSystem;
      let restoreReceiptWrites = 0;
      const receiptFailure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "writeFileString",
        pathOrDescriptor: target,
      });
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFileString: (path, contents, options) => {
          if (String(path).includes(".restore-")) {
            restoreReceiptWrites += 1;
            if (restoreReceiptWrites === 2) return Effect.fail(receiptFailure);
          }
          return fileSystem.writeFileString(path, contents, options);
        },
      });

      const result = yield* restoreImportBackup({
        receiptPath: cutover.receiptPath,
        confirmation: RESTORE_CONFIRMATION,
      }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem), Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(restoreReceiptWrites, 2);
      assert.equal(yield* fingerprintDatabase(target), importedFingerprint);
      assert.equal((yield* readOrchestrationEvents(target)).length, 2);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("backs up and restores conflicting attachments for replace mode", () =>
  withDatabases(({ source, target }) =>
    Effect.gen(function* () {
      const workspace = yield* prepareImportWorkspace({
        sourceDatabasePath: source,
        targetDatabasePath: target,
      });
      const targetAttachment = NodePath.join(
        NodePath.dirname(target),
        "attachments",
        "thread-target",
        "attachment.txt",
      );
      const stagedAttachment = NodePath.join(
        workspace.directory,
        "attachments",
        "thread-target",
        "attachment.txt",
      );
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.mkdir(NodePath.dirname(targetAttachment), { recursive: true }),
          NodeFSP.mkdir(NodePath.dirname(stagedAttachment), { recursive: true }),
        ]),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(targetAttachment, "turbo-original"));
      yield* Effect.promise(() => NodeFSP.writeFile(stagedAttachment, "official-replacement"));
      const events = yield* readOrchestrationEvents(workspace.sourceSnapshotPath);
      yield* appendCanonicalEvents(workspace, events);

      const cutover = yield* cutoverImport(workspace, {
        attachments: [
          {
            sourcePath: stagedAttachment,
            stagedPath: stagedAttachment,
            targetPath: targetAttachment,
            allowReplace: true,
          },
        ],
      });

      assert.equal(
        yield* Effect.promise(() => NodeFSP.readFile(targetAttachment, "utf8")),
        "official-replacement",
      );
      const backupPath = cutover.receipt.attachmentChanges[0]?.backupPath;
      assert.isString(backupPath);
      assert.equal(
        yield* Effect.promise(() => NodeFSP.readFile(backupPath!, "utf8")),
        "turbo-original",
      );

      const restored = yield* restoreImportBackup({
        receiptPath: cutover.receiptPath,
        confirmation: RESTORE_CONFIRMATION,
      });
      assert.equal(
        yield* Effect.promise(() => NodeFSP.readFile(targetAttachment, "utf8")),
        "turbo-original",
      );
      assert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(restored.receipt.displacedAttachmentPaths[0]!, "utf8"),
        ),
        "official-replacement",
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("journals cloned checkpoint refs and restores their previous state", () =>
  withDatabases(({ directory, source, target }) =>
    Effect.gen(function* () {
      const repositoryPath = NodePath.join(directory, "repository");
      yield* Effect.promise(() => NodeFSP.mkdir(repositoryPath));
      yield* git(repositoryPath, ["init"]);
      yield* git(repositoryPath, ["config", "user.email", "import@test.invalid"]);
      yield* git(repositoryPath, ["config", "user.name", "Import Test"]);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(repositoryPath, "file.txt"), "checkpoint"),
      );
      yield* git(repositoryPath, ["add", "file.txt"]);
      yield* git(repositoryPath, ["commit", "-m", "checkpoint"]);
      const sourceRef = "refs/t3/checkpoints/source-thread/turn/1";
      const targetRef = "refs/t3/checkpoints/cloned-thread/turn/1";
      yield* git(repositoryPath, ["update-ref", sourceRef, "HEAD"]);
      const changes = yield* prepareImportCheckpointRefChanges([
        { repositoryPath, sourceRef, targetRef },
      ]);
      assert.equal(changes.length, 1);

      const workspace = yield* prepareImportWorkspace({
        sourceDatabasePath: source,
        targetDatabasePath: target,
      });
      const events = yield* readOrchestrationEvents(workspace.sourceSnapshotPath);
      yield* appendCanonicalEvents(workspace, events);
      const cutover = yield* cutoverImport(workspace, { checkpointRefChanges: changes });

      assert.equal(yield* resolveGitRef(repositoryPath, targetRef), changes[0]?.importedOid);
      assert.deepEqual(cutover.receipt.checkpointRefChanges, changes);

      yield* restoreImportBackup({
        receiptPath: cutover.receiptPath,
        confirmation: RESTORE_CONFIRMATION,
      });
      assert.equal(yield* resolveGitRef(repositoryPath, targetRef), null);
      assert.equal(yield* resolveGitRef(repositoryPath, sourceRef), changes[0]?.importedOid);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("copies settled import and replace bindings while clearing clone bindings", () =>
  withDatabases(({ source, target }) =>
    Effect.gen(function* () {
      const sourceDatabase = new NodeSqlite.DatabaseSync(source);
      const targetDatabase = new NodeSqlite.DatabaseSync(target);
      try {
        const insertSource = sourceDatabase.prepare(
          `INSERT INTO provider_session_runtime
             (thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status,
              last_seen_at, resume_cursor_json, runtime_payload_json)
           VALUES (?, 'codex', 'codex', 'codex', 'full-access', 'stopped', ?, ?, ?)`,
        );
        insertSource.run(
          "thread-replace",
          NOW,
          '{"sessionId":"replace-source"}',
          '{"cwd":"/source"}',
        );
        insertSource.run("thread-clone", NOW, '{"sessionId":"clone-source"}', null);
        targetDatabase
          .prepare(
            `UPDATE provider_session_runtime
             SET provider_name = 'cursor', adapter_key = 'cursor', runtime_payload_json = ?
             WHERE thread_id = 'thread-target'`,
          )
          .run('{"retained":true}');
        const insertTarget = targetDatabase.prepare(
          `INSERT INTO provider_session_runtime (thread_id, provider_name, status)
           VALUES (?, 'cursor', 'stopped')`,
        );
        insertTarget.run("thread-replace");
        insertTarget.run("thread-clone");
      } finally {
        sourceDatabase.close();
        targetDatabase.close();
      }

      const workspace = yield* prepareImportWorkspace({
        sourceDatabasePath: source,
        targetDatabasePath: target,
      });
      assert.equal(
        yield* deleteProviderSessionRuntimeBindings(workspace.targetStagingPath, [
          ThreadId.make("thread-imported"),
          ThreadId.make("thread-replace"),
          ThreadId.make("thread-clone"),
        ]),
        2,
      );
      const copied = yield* copySettledProviderSessionRuntimeBindings({
        sourcePath: workspace.sourceSnapshotPath,
        stagingPath: workspace.targetStagingPath,
        threadIdMap: new Map([
          [ThreadId.make("thread-source"), ThreadId.make("thread-imported")],
          [ThreadId.make("thread-replace"), ThreadId.make("thread-replace")],
        ]),
      });
      assert.deepEqual(copied, {
        copiedBindingCount: 2,
        skippedInvalidBindingCount: 0,
        skippedUnsettledBindingCount: 0,
      });
      yield* clearDerivedImportState(workspace.targetStagingPath);
      const inspected = new NodeSqlite.DatabaseSync(workspace.targetStagingPath, {
        readOnly: true,
      });
      try {
        const rows = inspected
          .prepare(
            `SELECT thread_id AS threadId, provider_name AS providerName,
                    resume_cursor_json AS resumeCursor, runtime_payload_json AS runtimePayload
             FROM provider_session_runtime ORDER BY thread_id`,
          )
          .all();
        assert.deepEqual(rows, [
          {
            threadId: "thread-imported",
            providerName: "codex",
            resumeCursor: null,
            runtimePayload: null,
          },
          {
            threadId: "thread-replace",
            providerName: "codex",
            resumeCursor: '{"sessionId":"replace-source"}',
            runtimePayload: '{"cwd":"/source"}',
          },
          {
            threadId: "thread-target",
            providerName: "cursor",
            resumeCursor: null,
            runtimePayload: '{"retained":true}',
          },
        ]);
      } finally {
        inspected.close();
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("skips invalid provider bindings without disturbing retained Turbo bindings", () =>
  withDatabases(({ source, target }) =>
    Effect.gen(function* () {
      const sourceDatabase = new NodeSqlite.DatabaseSync(source);
      try {
        sourceDatabase
          .prepare(
            `INSERT INTO provider_session_runtime
               (thread_id, provider_name, adapter_key, runtime_mode, status, last_seen_at)
             VALUES ('thread-invalid', 'codex', 'codex', 'full-access', 'unknown', ?)`,
          )
          .run(NOW);
      } finally {
        sourceDatabase.close();
      }
      const workspace = yield* prepareImportWorkspace({
        sourceDatabasePath: source,
        targetDatabasePath: target,
      });
      const copied = yield* copySettledProviderSessionRuntimeBindings({
        sourcePath: workspace.sourceSnapshotPath,
        stagingPath: workspace.targetStagingPath,
        threadIdMap: new Map([[ThreadId.make("thread-invalid"), ThreadId.make("thread-invalid")]]),
      });
      assert.deepEqual(copied, {
        copiedBindingCount: 0,
        skippedInvalidBindingCount: 1,
        skippedUnsettledBindingCount: 0,
      });
      const inspected = new NodeSqlite.DatabaseSync(workspace.targetStagingPath, {
        readOnly: true,
      });
      try {
        const rows = inspected
          .prepare("SELECT thread_id AS threadId FROM provider_session_runtime ORDER BY thread_id")
          .all();
        assert.deepEqual(rows, [{ threadId: "thread-target" }]);
      } finally {
        inspected.close();
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("accepts an ordered migration prefix and migrates only the staging copy", () =>
  withTemporaryDirectory("t3-official-import-prefix-", (directory) =>
    Effect.gen(function* () {
      const source = NodePath.join(directory, "source.sqlite");
      const target = NodePath.join(directory, "target.sqlite");
      createFixtureDatabase(source, { id: "source" });
      yield* initializeDatabaseThroughMigration(target, 34);

      const workspace = yield* prepareImportWorkspace({
        sourceDatabasePath: source,
        targetDatabasePath: target,
      });
      const targetDatabase = new NodeSqlite.DatabaseSync(target, { readOnly: true });
      const stagingDatabase = new NodeSqlite.DatabaseSync(workspace.targetStagingPath, {
        readOnly: true,
      });
      try {
        assert.equal(
          targetDatabase.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()
            ?.id,
          34,
        );
        assert.equal(
          stagingDatabase.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()
            ?.id,
          migrationManifest.at(-1)?.[0],
        );
      } finally {
        targetDatabase.close();
        stagingDatabase.close();
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("imports into and restores an absent first-run Turbo database", () =>
  withTemporaryDirectory("t3-official-import-first-run-", (directory) =>
    Effect.gen(function* () {
      const source = NodePath.join(directory, "source.sqlite");
      const target = NodePath.join(directory, "turbo", "state.sqlite");
      createFixtureDatabase(source, { id: "source" });

      const workspace = yield* prepareImportWorkspace({
        sourceDatabasePath: source,
        targetDatabasePath: target,
      });
      assert.equal(workspace.targetFingerprint, null);
      assert.isFalse(
        yield* Effect.promise(() =>
          NodeFSP.access(target).then(
            () => true,
            () => false,
          ),
        ),
      );
      const events = yield* readOrchestrationEvents(workspace.sourceSnapshotPath);
      yield* appendCanonicalEvents(workspace, events);
      const cutover = yield* cutoverImport(workspace);
      assert.equal(cutover.receipt.backupDatabasePath, null);
      assert.equal((yield* readOrchestrationEvents(target)).length, 1);

      const restored = yield* restoreImportBackup({
        receiptPath: cutover.receiptPath,
        confirmation: RESTORE_CONFIRMATION,
      });
      assert.equal(restored.receipt.restoredFingerprint, null);
      assert.isFalse(
        yield* Effect.promise(() =>
          NodeFSP.access(target).then(
            () => true,
            () => false,
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("holds the filesystem import lock until the protected operation completes", () =>
  withTemporaryDirectory("t3-official-import-lock-", (directory) =>
    Effect.gen(function* () {
      const target = NodePath.join(directory, "state.sqlite");
      const acquired = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* withOfficialImportLock(
        target,
        Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(acquired);

      const contender = yield* withOfficialImportLock(target, Effect.void).pipe(Effect.result);
      assert.equal(contender._tag, "Failure");
      if (contender._tag === "Failure") {
        assert.equal(contender.failure._tag, "OfficialImportLockError");
      }

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* withOfficialImportLock(target, Effect.void);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
