// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import type { OrchestrationCommandReceipt } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  prepareImportCheckpointRefChanges,
  type ImportCheckpointRefInput,
} from "./checkpointRefs.ts";
import {
  OfficialImportCollisionChoice,
  OfficialImportIdMap,
  OfficialImportPlanSchema,
  assertOfficialImportPlanFresh,
  planOfficialImport,
  remapOfficialImportCommandReceiptIdentity,
  transformOfficialImportEvent,
  type OfficialImportDataset,
  type OfficialImportPlan,
} from "./plan.ts";
import { OfficialImportProjectionReplayError, rebuildOfficialImportProjections } from "./replay.ts";
import {
  ImportActivityState,
  appendCanonicalEvents,
  assertWorkspaceReadyForApply,
  clearDerivedImportState,
  copyCheckpointDiffBlobs,
  copySettledProviderSessionRuntimeBindings,
  cutoverImportWithinLock,
  deleteCanonicalThreadStreams,
  deleteProviderSessionRuntimeBindings,
  prepareImportWorkspace,
  readCommandReceipts,
  readOrchestrationEvents,
  recoverOfficialImportTransactionsWithinLock,
  rebuildCopiedCommandReceipts,
  removeImportWorkspace,
  withOfficialImportLocks,
  type StagedImportAttachment,
  type ImportWorkspace,
  type OfficialImportStorageFailure,
} from "./storage.ts";

export const ImportWorkspaceSchema = Schema.Struct({
  directory: Schema.String,
  sourceDatabasePath: Schema.String,
  targetDatabasePath: Schema.String,
  sourceSnapshotPath: Schema.String,
  targetStagingPath: Schema.String,
  sourceFingerprint: Schema.String,
  targetFingerprint: Schema.NullOr(Schema.String),
  sourceActivity: ImportActivityState,
  targetActivity: ImportActivityState,
});

export const PreparedOfficialImport = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("t3-turbo-official-import-plan"),
  createdAt: IsoDateTime,
  workspace: ImportWorkspaceSchema,
  plan: OfficialImportPlanSchema,
});
export type PreparedOfficialImport = typeof PreparedOfficialImport.Type;

export const OfficialImportApplyResult = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("t3-turbo-official-import-result"),
  receiptPath: Schema.String,
  importedEventCount: NonNegativeInt,
  copiedReceiptCount: NonNegativeInt,
  copiedCheckpointDiffCount: NonNegativeInt,
  copiedProviderBindingCount: NonNegativeInt,
  skippedInvalidProviderBindingCount: NonNegativeInt,
  skippedUnsettledProviderBindingCount: NonNegativeInt,
  copiedAttachmentCount: NonNegativeInt,
});
export type OfficialImportApplyResult = typeof OfficialImportApplyResult.Type;

export class OfficialImportDatasetError extends Schema.TaggedErrorClass<OfficialImportDatasetError>()(
  "OfficialImportDatasetError",
  {
    aggregateKind: Schema.Literals(["project", "thread"]),
    aggregateId: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot import ${this.aggregateKind} ${this.aggregateId}: ${this.reason}.`;
  }
}

export class OfficialImportUnresolvedCollisionsError extends Schema.TaggedErrorClass<OfficialImportUnresolvedCollisionsError>()(
  "OfficialImportUnresolvedCollisionsError",
  { threadIds: Schema.Array(ThreadId) },
) {
  override get message(): string {
    return `Choose skip, replace, or clone for: ${this.threadIds.join(", ")}.`;
  }
}

export class OfficialImportAttachmentError extends Schema.TaggedErrorClass<OfficialImportAttachmentError>()(
  "OfficialImportAttachmentError",
  {
    operation: Schema.String,
    sourcePath: Schema.String,
    targetPath: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `${this.operation} failed for attachment ${NodePath.basename(this.targetPath)}: ${this.reason}`;
  }
}

const isOfficialImportAttachmentError = Schema.is(OfficialImportAttachmentError);

export type OfficialImportExecutionFailure =
  | OfficialImportDatasetError
  | OfficialImportUnresolvedCollisionsError
  | OfficialImportAttachmentError
  | OfficialImportProjectionReplayError
  | OfficialImportStorageFailure;

const groupEvents = (
  events: ReadonlyArray<OrchestrationEvent>,
  aggregateKind: "project" | "thread",
): ReadonlyMap<string, ReadonlyArray<OrchestrationEvent>> => {
  const grouped = new Map<string, Array<OrchestrationEvent>>();
  for (const event of events) {
    if (event.aggregateKind !== aggregateKind) continue;
    const stream = grouped.get(event.aggregateId) ?? [];
    stream.push(event);
    grouped.set(event.aggregateId, stream);
  }
  return grouped;
};

/** Derive the planner's compact stream inventory from canonical events, never projections. */
export const buildOfficialImportDataset = (
  events: ReadonlyArray<OrchestrationEvent>,
): OfficialImportDataset => {
  const projectStreams = groupEvents(events, "project");
  const threadStreams = groupEvents(events, "thread");
  const projects: Array<OfficialImportDataset["projects"][number]> = [];
  const threads: Array<OfficialImportDataset["threads"][number]> = [];

  for (const [aggregateId, stream] of projectStreams) {
    let projectId: ProjectId | undefined;
    let workspaceRoot: string | undefined;
    for (const event of stream) {
      if (event.type === "project.created") {
        projectId = event.payload.projectId;
        workspaceRoot = event.payload.workspaceRoot;
      } else if (
        event.type === "project.meta-updated" &&
        event.payload.workspaceRoot !== undefined
      ) {
        workspaceRoot = event.payload.workspaceRoot;
      }
    }
    if (projectId === undefined || workspaceRoot === undefined) {
      throw new OfficialImportDatasetError({
        aggregateKind: "project",
        aggregateId,
        reason: "canonical stream has no complete project.created event",
      });
    }
    projects.push({ projectId, workspaceRoot, events: stream });
  }

  for (const [aggregateId, stream] of threadStreams) {
    const created = stream.find((event) => event.type === "thread.created");
    if (created?.type !== "thread.created") {
      throw new OfficialImportDatasetError({
        aggregateKind: "thread",
        aggregateId,
        reason: "canonical stream has no thread.created event",
      });
    }
    threads.push({
      threadId: created.payload.threadId,
      projectId: created.payload.projectId,
      events: stream,
    });
  }

  return { projects, threads };
};

export interface PrepareOfficialImportInput {
  readonly sourceDatabasePath: string;
  readonly targetDatabasePath: string;
  readonly collisionChoices?: Readonly<Record<string, OfficialImportCollisionChoice>>;
  readonly existingIdMap?: OfficialImportIdMap;
}

export const prepareOfficialImport = Effect.fn("prepareOfficialImport")(function* (
  input: PrepareOfficialImportInput,
) {
  const workspace = yield* prepareImportWorkspace(input);
  return yield* Effect.gen(function* () {
    const [sourceEvents, targetEvents] = yield* Effect.all([
      readOrchestrationEvents(workspace.sourceSnapshotPath),
      readOrchestrationEvents(workspace.targetStagingPath),
    ]);
    const plan = planOfficialImport({
      source: buildOfficialImportDataset(sourceEvents),
      target: buildOfficialImportDataset(targetEvents),
      ...(input.collisionChoices === undefined ? {} : { collisionChoices: input.collisionChoices }),
      ...(input.existingIdMap === undefined ? {} : { existingIdMap: input.existingIdMap }),
    });
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    return {
      version: 1,
      kind: "t3-turbo-official-import-plan",
      createdAt,
      workspace,
      plan,
    } as const;
  }).pipe(Effect.onError(() => removeImportWorkspace(workspace).pipe(Effect.ignore)));
});

const selectEventsToImport = (input: {
  readonly source: OfficialImportDataset;
  readonly plan: OfficialImportPlan;
}): ReadonlyArray<OrchestrationEvent> => {
  const selected: Array<OrchestrationEvent> = [];
  const sourceProjects = new Map(input.source.projects.map((item) => [item.projectId, item]));
  const sourceThreads = new Map(input.source.threads.map((item) => [item.threadId, item]));

  for (const project of input.plan.projects) {
    if (project.action !== "import") continue;
    const source = sourceProjects.get(project.sourceProjectId);
    if (source) selected.push(...source.events);
  }
  for (const thread of input.plan.threads) {
    if (thread.action === "noop" || thread.action === "skip" || thread.action === "needs-choice") {
      continue;
    }
    const source = sourceThreads.get(thread.sourceThreadId);
    if (!source) continue;
    selected.push(...source.events.slice(thread.action === "fast-forward" ? thread.appendFrom : 0));
  }
  return selected.toSorted((left, right) => left.sequence - right.sequence);
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
};

const collectAttachmentPairs = (input: {
  readonly sourceEvents: ReadonlyArray<OrchestrationEvent>;
  readonly transformedEvents: ReadonlyArray<OrchestrationEvent>;
  readonly workspace: ImportWorkspace;
  readonly plan: OfficialImportPlan;
}): ReadonlyArray<StagedImportAttachment> => {
  const sourceAttachmentsDir = NodePath.join(
    NodePath.dirname(input.workspace.sourceDatabasePath),
    "attachments",
  );
  const targetAttachmentsDir = NodePath.join(
    NodePath.dirname(input.workspace.targetDatabasePath),
    "attachments",
  );
  const stagingAttachmentsDir = NodePath.join(input.workspace.directory, "attachments");
  const pairs = new Map<string, StagedImportAttachment>();
  const actionByThreadId = new Map<string, OfficialImportPlan["threads"][number]["action"]>(
    input.plan.threads.map((thread) => [thread.sourceThreadId, thread.action] as const),
  );

  for (let index = 0; index < input.sourceEvents.length; index += 1) {
    const sourceEvent = input.sourceEvents[index];
    const transformedEvent = input.transformedEvents[index];
    if (
      sourceEvent?.type !== "thread.message-sent" ||
      transformedEvent?.type !== "thread.message-sent"
    ) {
      continue;
    }
    const sourceAttachments = sourceEvent.payload.attachments ?? [];
    const transformedAttachments = transformedEvent.payload.attachments ?? [];
    for (
      let attachmentIndex = 0;
      attachmentIndex < sourceAttachments.length;
      attachmentIndex += 1
    ) {
      const sourceAttachment = sourceAttachments[attachmentIndex];
      const transformedAttachment = transformedAttachments[attachmentIndex];
      if (!sourceAttachment || !transformedAttachment) continue;
      const sourceRelativePath = attachmentRelativePath(sourceAttachment);
      const targetRelativePath = attachmentRelativePath(transformedAttachment);
      pairs.set(targetRelativePath, {
        sourcePath: NodePath.join(sourceAttachmentsDir, sourceRelativePath),
        stagedPath: NodePath.join(stagingAttachmentsDir, targetRelativePath),
        targetPath: NodePath.join(targetAttachmentsDir, targetRelativePath),
        allowReplace: actionByThreadId.get(sourceEvent.aggregateId) === "replace",
      });
    }
  }
  return Array.from(pairs.values());
};

const collectCheckpointRefInputs = (input: {
  readonly source: OfficialImportDataset;
  readonly sourceEvents: ReadonlyArray<OrchestrationEvent>;
  readonly transformedEvents: ReadonlyArray<OrchestrationEvent>;
}): ReadonlyArray<ImportCheckpointRefInput> => {
  const threadById = new Map<string, OfficialImportDataset["threads"][number]>(
    input.source.threads.map((thread) => [thread.threadId, thread]),
  );
  const projectById = new Map(input.source.projects.map((project) => [project.projectId, project]));
  const refs: Array<ImportCheckpointRefInput> = [];
  for (let index = 0; index < input.sourceEvents.length; index += 1) {
    const sourceEvent = input.sourceEvents[index];
    const transformedEvent = input.transformedEvents[index];
    if (
      sourceEvent?.type !== "thread.turn-diff-completed" ||
      transformedEvent?.type !== "thread.turn-diff-completed" ||
      sourceEvent.payload.checkpointRef === transformedEvent.payload.checkpointRef
    ) {
      continue;
    }
    const thread = threadById.get(sourceEvent.aggregateId);
    const project = thread ? projectById.get(thread.projectId) : undefined;
    const created = thread?.events.find((event) => event.type === "thread.created");
    if (!thread || !project || created?.type !== "thread.created") continue;
    refs.push({
      repositoryPath: created.payload.worktreePath ?? project.workspaceRoot,
      sourceRef: sourceEvent.payload.checkpointRef,
      targetRef: transformedEvent.payload.checkpointRef,
    });
  }
  return refs;
};

const stageAttachments = Effect.fn("stageOfficialImportAttachments")(function* (
  attachments: ReadonlyArray<StagedImportAttachment>,
) {
  yield* Effect.tryPromise({
    try: async () => {
      for (const attachment of attachments) {
        if (!(await fileExists(attachment.sourcePath))) {
          throw new OfficialImportAttachmentError({
            operation: "read source",
            sourcePath: attachment.sourcePath,
            targetPath: attachment.targetPath,
            reason: "source file is missing",
          });
        }
        await NodeFSP.mkdir(NodePath.dirname(attachment.stagedPath), { recursive: true });
        await NodeFSP.copyFile(
          attachment.sourcePath,
          attachment.stagedPath,
          NodeFS.constants.COPYFILE_EXCL,
        );
      }
    },
    catch: (cause) =>
      isOfficialImportAttachmentError(cause)
        ? cause
        : new OfficialImportAttachmentError({
            operation: "stage",
            sourcePath: attachments.at(0)?.sourcePath ?? "unknown",
            targetPath: attachments.at(0)?.targetPath ?? "unknown",
            reason: String(cause),
          }),
  });
});

const remapReceipts = (
  receipts: ReadonlyArray<OrchestrationCommandReceipt>,
  idMap: OfficialImportIdMap,
): ReadonlyArray<OrchestrationCommandReceipt> =>
  receipts.map((receipt) => ({
    ...receipt,
    ...remapOfficialImportCommandReceiptIdentity(receipt, idMap),
  }));

/** Apply a previously reviewed plan to staging, verify projections, then atomically cut over. */
const applyPreparedOfficialImportWithinLock = Effect.fn("applyPreparedOfficialImportWithinLock")(
  function* (
    prepared: PreparedOfficialImport,
  ): Effect.fn.Return<
    OfficialImportApplyResult,
    OfficialImportExecutionFailure,
    FileSystem.FileSystem | Path.Path
  > {
    const unresolved = prepared.plan.threads
      .filter((thread) => thread.action === "needs-choice")
      .map((thread) => thread.sourceThreadId);
    if (unresolved.length > 0) {
      return yield* new OfficialImportUnresolvedCollisionsError({ threadIds: unresolved });
    }

    yield* assertWorkspaceReadyForApply(prepared.workspace);
    const [sourceEvents, targetEvents, sourceReceipts] = yield* Effect.all([
      readOrchestrationEvents(prepared.workspace.sourceSnapshotPath),
      readOrchestrationEvents(prepared.workspace.targetStagingPath),
      readCommandReceipts(prepared.workspace.sourceSnapshotPath),
    ]);
    const source = buildOfficialImportDataset(sourceEvents);
    const target = buildOfficialImportDataset(targetEvents);
    yield* Effect.sync(() => assertOfficialImportPlanFresh(prepared.plan, source, target));

    const selectedSourceEvents = selectEventsToImport({ source, plan: prepared.plan });
    const transformedEvents = selectedSourceEvents.map((event) =>
      transformOfficialImportEvent(event, prepared.plan.idMap),
    );
    const attachments = collectAttachmentPairs({
      sourceEvents: selectedSourceEvents,
      transformedEvents,
      workspace: prepared.workspace,
      plan: prepared.plan,
    });
    yield* stageAttachments(attachments);
    const checkpointRefChanges = yield* prepareImportCheckpointRefChanges(
      collectCheckpointRefInputs({ source, sourceEvents: selectedSourceEvents, transformedEvents }),
    );

    const replacedThreadIds = prepared.plan.threads.flatMap((thread) =>
      thread.action === "replace" && thread.matchedTargetThreadId !== null
        ? [thread.matchedTargetThreadId]
        : [],
    );
    yield* deleteCanonicalThreadStreams(prepared.workspace.targetStagingPath, replacedThreadIds);
    const importedThreadIds = prepared.plan.threads.flatMap((thread) =>
      thread.action === "import" || thread.action === "replace" || thread.action === "clone"
        ? [thread.targetThreadId]
        : [],
    );
    yield* deleteProviderSessionRuntimeBindings(
      prepared.workspace.targetStagingPath,
      importedThreadIds,
    );
    const providerBindingCopies = new Map(
      prepared.plan.threads.flatMap((thread) =>
        thread.action === "import" || thread.action === "replace"
          ? [[thread.sourceThreadId, thread.targetThreadId] as const]
          : [],
      ),
    );
    const providerBindingResult = yield* copySettledProviderSessionRuntimeBindings({
      sourcePath: prepared.workspace.sourceSnapshotPath,
      stagingPath: prepared.workspace.targetStagingPath,
      threadIdMap: providerBindingCopies,
    });
    const sequenceMap = yield* appendCanonicalEvents(prepared.workspace, transformedEvents);
    const copiedReceiptCount = yield* rebuildCopiedCommandReceipts(
      prepared.workspace.targetStagingPath,
      remapReceipts(sourceReceipts, prepared.plan.idMap),
      sequenceMap,
    );

    const copiedThreadIds = new Map(
      prepared.plan.threads.flatMap((thread) =>
        thread.action === "noop" || thread.action === "skip" || thread.action === "needs-choice"
          ? []
          : [[thread.sourceThreadId, thread.targetThreadId] as const],
      ),
    );
    const copiedCheckpointDiffCount = yield* copyCheckpointDiffBlobs({
      sourcePath: prepared.workspace.sourceSnapshotPath,
      stagingPath: prepared.workspace.targetStagingPath,
      threadIdMap: copiedThreadIds,
    });
    yield* clearDerivedImportState(prepared.workspace.targetStagingPath);
    yield* rebuildOfficialImportProjections({
      databasePath: prepared.workspace.targetStagingPath,
      sandboxBaseDir: NodePath.join(prepared.workspace.directory, "projection-sandbox"),
    });

    const cutover = yield* cutoverImportWithinLock(prepared.workspace, {
      attachments,
      checkpointRefChanges,
    });
    yield* removeImportWorkspace(prepared.workspace).pipe(Effect.ignore);

    return {
      version: 1,
      kind: "t3-turbo-official-import-result",
      receiptPath: cutover.receiptPath,
      importedEventCount: transformedEvents.length,
      copiedReceiptCount,
      copiedCheckpointDiffCount,
      copiedProviderBindingCount: providerBindingResult.copiedBindingCount,
      skippedInvalidProviderBindingCount: providerBindingResult.skippedInvalidBindingCount,
      skippedUnsettledProviderBindingCount: providerBindingResult.skippedUnsettledBindingCount,
      copiedAttachmentCount: cutover.receipt.attachmentChanges.length,
    };
  },
);

export const applyPreparedOfficialImport = Effect.fn("applyPreparedOfficialImport")(function* (
  prepared: PreparedOfficialImport,
) {
  return yield* withOfficialImportLocks(
    [prepared.workspace.sourceDatabasePath, prepared.workspace.targetDatabasePath],
    recoverOfficialImportTransactionsWithinLock(prepared.workspace.targetDatabasePath).pipe(
      Effect.andThen(applyPreparedOfficialImportWithinLock(prepared)),
    ),
  );
});
