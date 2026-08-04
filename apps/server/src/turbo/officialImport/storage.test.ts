// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { migrationManifest } from "../../persistence/Migrations.ts";
import {
  RESTORE_CONFIRMATION,
  appendCanonicalEvents,
  clearDerivedImportState,
  copyCheckpointDiffBlobs,
  cutoverImport,
  deleteCanonicalThreadStreams,
  fingerprintDatabase,
  prepareImportWorkspace,
  readCheckpointDiffBlobs,
  readCommandReceipts,
  readImportActivityState,
  readOrchestrationEvents,
  readProjectRows,
  rebuildCopiedCommandReceipts,
  restoreImportBackup,
} from "./storage.ts";

const NOW = "2026-08-04T12:00:00.000Z";

const schemaSql = `
  CREATE TABLE effect_sql_migrations (
    migration_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
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
  CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, status TEXT NOT NULL);
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
    Effect.promise(() => mkdtemp(join(tmpdir(), "t3-official-import-storage-"))),
    (directory) => {
      const source = join(directory, "source.sqlite");
      const target = join(directory, "target.sqlite");
      createFixtureDatabase(source, { id: "source" });
      createFixtureDatabase(target, { id: "target" });
      return use({ directory, source, target });
    },
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
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
      const events = yield* readOrchestrationEvents(workspace.sourceSnapshotPath);
      yield* appendCanonicalEvents(workspace, events);
      const cutover = yield* cutoverImport(workspace);
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
      assert.equal(yield* fingerprintDatabase(target), targetBefore);
      assert.equal((yield* readOrchestrationEvents(target)).length, 1);
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
    Effect.promise(() => mkdtemp(join(tmpdir(), "t3-official-import-active-"))),
    (directory) =>
      Effect.gen(function* () {
        const source = join(directory, "source.sqlite");
        const target = join(directory, "target.sqlite");
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
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  ).pipe(Effect.provide(NodeServices.layer)),
);
