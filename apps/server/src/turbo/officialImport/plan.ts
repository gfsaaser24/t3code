// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  NonNegativeInt,
  OrchestrationProposedPlanId,
  ProjectId,
  ThreadId,
  TurnId,
  type ChatAttachmentId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const OfficialImportCollisionChoice = Schema.Literals(["skip", "replace", "clone"]);
export type OfficialImportCollisionChoice = typeof OfficialImportCollisionChoice.Type;
export const OfficialImportCollisionChoices = Schema.Record(
  Schema.String,
  OfficialImportCollisionChoice,
);
export type OfficialImportCollisionChoices = typeof OfficialImportCollisionChoices.Type;

export const OfficialImportStreamClassification = Schema.Literals([
  "missing",
  "target-prefix",
  "equal",
  "source-behind",
  "divergent",
]);
export type OfficialImportStreamClassification = typeof OfficialImportStreamClassification.Type;

export const OfficialImportThreadAction = Schema.Literals([
  "import",
  "fast-forward",
  "noop",
  "needs-choice",
  "skip",
  "replace",
  "clone",
]);
export type OfficialImportThreadAction = typeof OfficialImportThreadAction.Type;

export const OfficialImportIdentityKind = Schema.Literals([
  "project",
  "thread",
  "event",
  "command",
  "message",
  "turn",
  "activity",
  "approval-request",
  "proposed-plan",
  "attachment",
  "checkpoint-ref",
]);
export type OfficialImportIdentityKind = typeof OfficialImportIdentityKind.Type;

const idRecord = <Value extends Schema.Top>(value: Value) => Schema.Record(Schema.String, value);

export const OfficialImportIdMap = Schema.Struct({
  projectIds: idRecord(ProjectId),
  threadIds: idRecord(ThreadId),
  eventIds: idRecord(EventId),
  commandIds: idRecord(CommandId),
  messageIds: idRecord(MessageId),
  turnIds: idRecord(TurnId),
  activityIds: idRecord(EventId),
  approvalRequestIds: idRecord(ApprovalRequestId),
  proposedPlanIds: idRecord(OrchestrationProposedPlanId),
  attachmentIds: idRecord(Schema.String),
  checkpointRefs: idRecord(CheckpointRef),
});
export type OfficialImportIdMap = typeof OfficialImportIdMap.Type;

export interface OfficialImportProjectStream {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly events: ReadonlyArray<OrchestrationEvent>;
}

export interface OfficialImportThreadStream {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly events: ReadonlyArray<OrchestrationEvent>;
}

export interface OfficialImportDataset {
  readonly projects: ReadonlyArray<OfficialImportProjectStream>;
  readonly threads: ReadonlyArray<OfficialImportThreadStream>;
}

export interface OfficialImportProjectPlan {
  readonly sourceProjectId: ProjectId;
  readonly targetProjectId: ProjectId;
  readonly action: "import" | "reuse";
  readonly sourceFingerprint: string;
  readonly sourceHeadFingerprint: string | null;
  readonly targetFingerprint: string | null;
  readonly targetHeadFingerprint: string | null;
}

export interface OfficialImportThreadPlan {
  readonly sourceThreadId: ThreadId;
  /** Existing Turbo stream compared during planning, before a clone destination is allocated. */
  readonly matchedTargetThreadId: ThreadId | null;
  readonly targetThreadId: ThreadId;
  readonly targetProjectId: ProjectId;
  readonly classification: OfficialImportStreamClassification;
  readonly action: OfficialImportThreadAction;
  readonly appendFrom: number;
  readonly sourceFingerprint: string;
  readonly sourceHeadFingerprint: string | null;
  readonly targetFingerprint: string | null;
  readonly targetHeadFingerprint: string | null;
}

export interface OfficialImportPlan {
  readonly projects: ReadonlyArray<OfficialImportProjectPlan>;
  readonly threads: ReadonlyArray<OfficialImportThreadPlan>;
  readonly idMap: OfficialImportIdMap;
}

export const OfficialImportProjectPlanSchema = Schema.Struct({
  sourceProjectId: ProjectId,
  targetProjectId: ProjectId,
  action: Schema.Literals(["import", "reuse"]),
  sourceFingerprint: Schema.String,
  sourceHeadFingerprint: Schema.NullOr(Schema.String),
  targetFingerprint: Schema.NullOr(Schema.String),
  targetHeadFingerprint: Schema.NullOr(Schema.String),
});

export const OfficialImportThreadPlanSchema = Schema.Struct({
  sourceThreadId: ThreadId,
  matchedTargetThreadId: Schema.NullOr(ThreadId),
  targetThreadId: ThreadId,
  targetProjectId: ProjectId,
  classification: OfficialImportStreamClassification,
  action: OfficialImportThreadAction,
  appendFrom: NonNegativeInt,
  sourceFingerprint: Schema.String,
  sourceHeadFingerprint: Schema.NullOr(Schema.String),
  targetFingerprint: Schema.NullOr(Schema.String),
  targetHeadFingerprint: Schema.NullOr(Schema.String),
});

/** JSON-safe schema for persisted CLI plan files. */
export const OfficialImportPlanSchema = Schema.Struct({
  projects: Schema.Array(OfficialImportProjectPlanSchema),
  threads: Schema.Array(OfficialImportThreadPlanSchema),
  idMap: OfficialImportIdMap,
});

export interface OfficialImportCommandReceiptIdentity {
  readonly commandId: CommandId;
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
}

export interface AllocateOfficialImportIdentityInput {
  readonly kind: OfficialImportIdentityKind;
  readonly sourceId: string;
  readonly targetThreadId?: ThreadId;
  readonly checkpointTurnCount?: number;
}

export type AllocateOfficialImportIdentity = (input: AllocateOfficialImportIdentityInput) => string;

export interface PlanOfficialImportInput {
  readonly source: OfficialImportDataset;
  readonly target: OfficialImportDataset;
  readonly collisionChoices?: Readonly<Record<string, OfficialImportCollisionChoice>>;
  /** Identity mappings from the last receipt make a cloned import idempotent on later runs. */
  readonly existingIdMap?: OfficialImportIdMap;
  readonly allocateIdentity?: AllocateOfficialImportIdentity;
}

export class OfficialImportPlanningError extends Schema.TaggedErrorClass<OfficialImportPlanningError>()(
  "OfficialImportPlanningError",
  {
    reason: Schema.Literals([
      "duplicate-project-id",
      "duplicate-thread-id",
      "ambiguous-workspace-root",
      "invalid-allocated-id",
    ]),
    detail: Schema.String,
  },
) {}

export interface OfficialImportPlanStaleIssue {
  readonly scope: "source-project" | "target-project" | "source-thread" | "target-thread";
  readonly id: string;
  readonly reason: "missing" | "appeared" | "fingerprint-changed" | "head-changed";
}

export class OfficialImportPlanStaleError extends Schema.TaggedErrorClass<OfficialImportPlanStaleError>()(
  "OfficialImportPlanStaleError",
  {
    issues: Schema.Array(
      Schema.Struct({ scope: Schema.String, id: Schema.String, reason: Schema.String }),
    ),
  },
) {}

const emptyIdMap = (): OfficialImportIdMap => ({
  projectIds: {},
  threadIds: {},
  eventIds: {},
  commandIds: {},
  messageIds: {},
  turnIds: {},
  activityIds: {},
  approvalRequestIds: {},
  proposedPlanIds: {},
  attachmentIds: {},
  checkpointRefs: {},
});

const copyIdMap = (idMap: OfficialImportIdMap | undefined): OfficialImportIdMap => ({
  projectIds: { ...idMap?.projectIds },
  threadIds: { ...idMap?.threadIds },
  eventIds: { ...idMap?.eventIds },
  commandIds: { ...idMap?.commandIds },
  messageIds: { ...idMap?.messageIds },
  turnIds: { ...idMap?.turnIds },
  activityIds: { ...idMap?.activityIds },
  approvalRequestIds: { ...idMap?.approvalRequestIds },
  proposedPlanIds: { ...idMap?.proposedPlanIds },
  attachmentIds: { ...idMap?.attachmentIds },
  checkpointRefs: { ...idMap?.checkpointRefs },
});

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Cannot fingerprint a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`Cannot fingerprint value of type ${typeof value}`);
};

const sha256 = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

export const fingerprintOfficialImportEvent = (event: OrchestrationEvent): string => {
  const { sequence: _destinationSequence, ...stableEvent } = event;
  return sha256(canonicalJson(stableEvent));
};

export const fingerprintOfficialImportStream = (
  events: ReadonlyArray<OrchestrationEvent>,
): string => sha256(canonicalJson(events.map(fingerprintOfficialImportEvent)));

const headFingerprint = (events: ReadonlyArray<OrchestrationEvent>): string | null => {
  const event = events.at(-1);
  return event ? fingerprintOfficialImportEvent(event) : null;
};

export const classifyOfficialImportStream = (
  source: ReadonlyArray<OrchestrationEvent>,
  target: ReadonlyArray<OrchestrationEvent> | undefined,
): OfficialImportStreamClassification => {
  if (!target) return "missing";
  const sourceFingerprints = source.map(fingerprintOfficialImportEvent);
  const targetFingerprints = target.map(fingerprintOfficialImportEvent);
  const commonLength = Math.min(sourceFingerprints.length, targetFingerprints.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (sourceFingerprints[index] !== targetFingerprints[index]) return "divergent";
  }
  if (sourceFingerprints.length === targetFingerprints.length) return "equal";
  return sourceFingerprints.length > targetFingerprints.length ? "target-prefix" : "source-behind";
};

/**
 * Normalizes path spelling for project coalescing without resolving symlinks or touching disk.
 * Windows drive and UNC paths are case-insensitive; POSIX paths retain case.
 */
export const normalizeOfficialImportWorkspaceRoot = (workspaceRoot: string): string => {
  let normalized = workspaceRoot
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/g, "");
  if (/^[a-z]:\//i.test(normalized) || workspaceRoot.trim().startsWith("\\\\")) {
    normalized = normalized.toLocaleLowerCase("en-US");
  }
  return normalized;
};

const safeAttachmentThreadSegment = (threadId: ThreadId): string => {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80)
    .replace(/[-_]+$/g, "");
  return segment || "thread";
};

const defaultAllocateIdentity: AllocateOfficialImportIdentity = (input) => {
  const digest = sha256(
    canonicalJson({
      kind: input.kind,
      sourceId: input.sourceId,
      targetThreadId: input.targetThreadId ?? null,
      checkpointTurnCount: input.checkpointTurnCount ?? null,
    }),
  );
  if (input.kind === "attachment" && input.targetThreadId) {
    return `${safeAttachmentThreadSegment(input.targetThreadId)}-${digest.slice(0, 32)}`;
  }
  if (
    input.kind === "checkpoint-ref" &&
    input.targetThreadId &&
    input.checkpointTurnCount !== undefined
  ) {
    const threadSegment = Buffer.from(input.targetThreadId, "utf8").toString("base64url");
    return `refs/t3/checkpoints/${threadSegment}/turn/${input.checkpointTurnCount}`;
  }
  return `official-import-${input.kind}-${digest.slice(0, 32)}`;
};

type MutableIdMap = {
  -readonly [Key in keyof OfficialImportIdMap]: Record<string, OfficialImportIdMap[Key][string]>;
};

const asMutableIdMap = (idMap: OfficialImportIdMap): MutableIdMap => idMap;

const allocateMapped = <Id extends string>(input: {
  readonly map: { [sourceId: string]: Id };
  readonly sourceId: Id;
  readonly kind: OfficialImportIdentityKind;
  readonly allocate: AllocateOfficialImportIdentity;
  readonly targetThreadId?: ThreadId;
  readonly checkpointTurnCount?: number;
  readonly make: (value: string) => Id;
}): Id => {
  const existing = input.map[input.sourceId];
  if (existing) return existing;
  const allocated = input.allocate({
    kind: input.kind,
    sourceId: input.sourceId,
    ...(input.targetThreadId ? { targetThreadId: input.targetThreadId } : {}),
    ...(input.checkpointTurnCount === undefined
      ? {}
      : { checkpointTurnCount: input.checkpointTurnCount }),
  });
  try {
    const value = input.make(allocated);
    input.map[input.sourceId] = value;
    return value;
  } catch {
    throw new OfficialImportPlanningError({
      reason: "invalid-allocated-id",
      detail: `${input.kind} allocator returned an invalid identity`,
    });
  }
};

const makeIdentity = <Id extends string>(value: string): Id => value as Id;

const remap = <Id extends string>(map: Readonly<Record<string, Id>>, value: Id): Id =>
  map[value] ?? value;

const remapNullable = <Id extends string>(
  map: Readonly<Record<string, Id>>,
  value: Id | null,
): Id | null => (value === null ? null : remap(map, value));

const remapOptional = <Id extends string>(
  map: Readonly<Record<string, Id>>,
  value: Id | undefined,
): Id | undefined => (value === undefined ? undefined : remap(map, value));

const remapBase = (event: OrchestrationEvent, idMap: OfficialImportIdMap) => ({
  eventId: remap(idMap.eventIds, event.eventId),
  aggregateId:
    event.aggregateKind === "project"
      ? remap(idMap.projectIds, ProjectId.make(event.aggregateId))
      : remap(idMap.threadIds, ThreadId.make(event.aggregateId)),
  commandId: remapNullable(idMap.commandIds, event.commandId),
  causationEventId: remapNullable(idMap.eventIds, event.causationEventId),
  correlationId: remapNullable(idMap.commandIds, event.correlationId),
  metadata: {
    ...event.metadata,
    requestId: remapOptional(idMap.approvalRequestIds, event.metadata.requestId),
  },
});

/** Remaps the identity columns of a copied receipt; resultSequence is rebuilt by storage. */
export const remapOfficialImportCommandReceiptIdentity = (
  receipt: OfficialImportCommandReceiptIdentity,
  idMap: OfficialImportIdMap,
): OfficialImportCommandReceiptIdentity => ({
  commandId: remap(idMap.commandIds, receipt.commandId),
  aggregateKind: receipt.aggregateKind,
  aggregateId:
    receipt.aggregateKind === "project"
      ? remap(idMap.projectIds, ProjectId.make(receipt.aggregateId))
      : remap(idMap.threadIds, ThreadId.make(receipt.aggregateId)),
});

/** Remaps only schema-known T3-owned identities. Opaque provider payloads and IDs stay untouched. */
export const transformOfficialImportEvent = (
  event: OrchestrationEvent,
  idMap: OfficialImportIdMap,
): OrchestrationEvent => {
  const base = remapBase(event, idMap);
  switch (event.type) {
    case "project.created":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, projectId: remap(idMap.projectIds, event.payload.projectId) },
      };
    case "project.meta-updated":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, projectId: remap(idMap.projectIds, event.payload.projectId) },
      };
    case "project.deleted":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, projectId: remap(idMap.projectIds, event.payload.projectId) },
      };
    case "thread.created":
      return {
        ...event,
        ...base,
        payload: {
          ...event.payload,
          threadId: remap(idMap.threadIds, event.payload.threadId),
          projectId: remap(idMap.projectIds, event.payload.projectId),
        },
      };
    case "thread.deleted":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, threadId: remap(idMap.threadIds, event.payload.threadId) },
      };
    case "thread.archived":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, threadId: remap(idMap.threadIds, event.payload.threadId) },
      };
    case "thread.unarchived":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, threadId: remap(idMap.threadIds, event.payload.threadId) },
      };
    case "thread.pinned":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, threadId: remap(idMap.threadIds, event.payload.threadId) },
      };
    case "thread.unpinned":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, threadId: remap(idMap.threadIds, event.payload.threadId) },
      };
    case "thread.settled":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, threadId: remap(idMap.threadIds, event.payload.threadId) },
      };
    case "thread.unsettled":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, threadId: remap(idMap.threadIds, event.payload.threadId) },
      };
    case "thread.snoozed":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, threadId: remap(idMap.threadIds, event.payload.threadId) },
      };
    case "thread.unsnoozed":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, threadId: remap(idMap.threadIds, event.payload.threadId) },
      };
    case "thread.runtime-mode-set":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, threadId: remap(idMap.threadIds, event.payload.threadId) },
      };
    case "thread.interaction-mode-set":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, threadId: remap(idMap.threadIds, event.payload.threadId) },
      };
    case "thread.checkpoint-revert-requested":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, threadId: remap(idMap.threadIds, event.payload.threadId) },
      };
    case "thread.reverted":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, threadId: remap(idMap.threadIds, event.payload.threadId) },
      };
    case "thread.session-stop-requested":
      return {
        ...event,
        ...base,
        payload: { ...event.payload, threadId: remap(idMap.threadIds, event.payload.threadId) },
      };
    case "thread.meta-updated":
      return {
        ...event,
        ...base,
        payload: {
          ...event.payload,
          threadId: remap(idMap.threadIds, event.payload.threadId),
          titleRegeneration:
            event.payload.titleRegeneration === undefined ||
            event.payload.titleRegeneration === null
              ? event.payload.titleRegeneration
              : {
                  ...event.payload.titleRegeneration,
                  requestId: remap(idMap.commandIds, event.payload.titleRegeneration.requestId),
                },
        },
      };
    case "thread.message-sent":
      return {
        ...event,
        ...base,
        payload: {
          ...event.payload,
          threadId: remap(idMap.threadIds, event.payload.threadId),
          messageId: remap(idMap.messageIds, event.payload.messageId),
          turnId: remapNullable(idMap.turnIds, event.payload.turnId),
          attachments: event.payload.attachments?.map((attachment) => ({
            ...attachment,
            id: remap(idMap.attachmentIds, attachment.id) as ChatAttachmentId,
          })),
        },
      };
    case "thread.turn-start-requested":
      return {
        ...event,
        ...base,
        payload: {
          ...event.payload,
          threadId: remap(idMap.threadIds, event.payload.threadId),
          messageId: remap(idMap.messageIds, event.payload.messageId),
          sourceProposedPlan: event.payload.sourceProposedPlan
            ? {
                threadId: remap(idMap.threadIds, event.payload.sourceProposedPlan.threadId),
                planId: remap(idMap.proposedPlanIds, event.payload.sourceProposedPlan.planId),
              }
            : undefined,
        },
      };
    case "thread.turn-interrupt-requested":
      return {
        ...event,
        ...base,
        payload: {
          ...event.payload,
          threadId: remap(idMap.threadIds, event.payload.threadId),
          turnId: remapOptional(idMap.turnIds, event.payload.turnId),
        },
      };
    case "thread.approval-response-requested":
      return {
        ...event,
        ...base,
        payload: {
          ...event.payload,
          threadId: remap(idMap.threadIds, event.payload.threadId),
          requestId: remap(idMap.approvalRequestIds, event.payload.requestId),
        },
      };
    case "thread.user-input-response-requested":
      return {
        ...event,
        ...base,
        payload: {
          ...event.payload,
          threadId: remap(idMap.threadIds, event.payload.threadId),
          requestId: remap(idMap.approvalRequestIds, event.payload.requestId),
        },
      };
    case "thread.session-set":
      return {
        ...event,
        ...base,
        payload: {
          ...event.payload,
          threadId: remap(idMap.threadIds, event.payload.threadId),
          session: {
            ...event.payload.session,
            threadId: remap(idMap.threadIds, event.payload.session.threadId),
            activeTurnId: remapNullable(idMap.turnIds, event.payload.session.activeTurnId),
          },
        },
      };
    case "thread.proposed-plan-upserted":
      return {
        ...event,
        ...base,
        payload: {
          ...event.payload,
          threadId: remap(idMap.threadIds, event.payload.threadId),
          proposedPlan: {
            ...event.payload.proposedPlan,
            id: remap(idMap.proposedPlanIds, event.payload.proposedPlan.id),
            turnId: remapNullable(idMap.turnIds, event.payload.proposedPlan.turnId),
            implementationThreadId: remapNullable(
              idMap.threadIds,
              event.payload.proposedPlan.implementationThreadId,
            ),
          },
        },
      };
    case "thread.turn-diff-completed":
      return {
        ...event,
        ...base,
        payload: {
          ...event.payload,
          threadId: remap(idMap.threadIds, event.payload.threadId),
          turnId: remap(idMap.turnIds, event.payload.turnId),
          checkpointRef: remap(idMap.checkpointRefs, event.payload.checkpointRef),
          assistantMessageId: remapNullable(idMap.messageIds, event.payload.assistantMessageId),
        },
      };
    case "thread.activity-appended":
      return {
        ...event,
        ...base,
        payload: {
          ...event.payload,
          threadId: remap(idMap.threadIds, event.payload.threadId),
          activity: {
            ...event.payload.activity,
            id: remap(idMap.activityIds, event.payload.activity.id),
            turnId: remapNullable(idMap.turnIds, event.payload.activity.turnId),
          },
        },
      };
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
};

type OfficialImportEventIdentity =
  | { readonly kind: "event"; readonly sourceId: EventId }
  | { readonly kind: "command"; readonly sourceId: CommandId }
  | { readonly kind: "message"; readonly sourceId: MessageId }
  | { readonly kind: "turn"; readonly sourceId: TurnId }
  | { readonly kind: "activity"; readonly sourceId: EventId }
  | { readonly kind: "approval-request"; readonly sourceId: ApprovalRequestId }
  | { readonly kind: "proposed-plan"; readonly sourceId: OrchestrationProposedPlanId }
  | { readonly kind: "attachment"; readonly sourceId: ChatAttachmentId }
  | {
      readonly kind: "checkpoint-ref";
      readonly sourceId: CheckpointRef;
      readonly checkpointTurnCount: number;
    };

type OfficialImportEventIdentityKind = OfficialImportEventIdentity["kind"];
type OfficialImportIdentityCounts = Record<OfficialImportEventIdentityKind, Map<string, number>>;

const emptyIdentityCounts = (): OfficialImportIdentityCounts => ({
  event: new Map(),
  command: new Map(),
  message: new Map(),
  turn: new Map(),
  activity: new Map(),
  "approval-request": new Map(),
  "proposed-plan": new Map(),
  attachment: new Map(),
  "checkpoint-ref": new Map(),
});

const visitOfficialImportEventIdentities = (
  events: ReadonlyArray<OrchestrationEvent>,
  visit: (identity: OfficialImportEventIdentity) => void,
): void => {
  for (const event of events) {
    visit({ kind: "event", sourceId: event.eventId });
    if (event.commandId) visit({ kind: "command", sourceId: event.commandId });
    if (event.causationEventId) visit({ kind: "event", sourceId: event.causationEventId });
    if (event.correlationId) visit({ kind: "command", sourceId: event.correlationId });
    if (event.metadata.requestId) {
      visit({ kind: "approval-request", sourceId: event.metadata.requestId });
    }
    switch (event.type) {
      case "project.created":
      case "project.meta-updated":
      case "project.deleted":
      case "thread.created":
      case "thread.deleted":
      case "thread.archived":
      case "thread.unarchived":
      case "thread.pinned":
      case "thread.unpinned":
      case "thread.settled":
      case "thread.unsettled":
      case "thread.snoozed":
      case "thread.unsnoozed":
      case "thread.runtime-mode-set":
      case "thread.interaction-mode-set":
      case "thread.checkpoint-revert-requested":
      case "thread.reverted":
      case "thread.session-stop-requested":
        break;
      case "thread.meta-updated":
        if (event.payload.titleRegeneration) {
          visit({ kind: "command", sourceId: event.payload.titleRegeneration.requestId });
        }
        break;
      case "thread.message-sent":
        visit({ kind: "message", sourceId: event.payload.messageId });
        if (event.payload.turnId) visit({ kind: "turn", sourceId: event.payload.turnId });
        event.payload.attachments?.forEach((attachment) =>
          visit({ kind: "attachment", sourceId: attachment.id }),
        );
        break;
      case "thread.turn-start-requested":
        visit({ kind: "message", sourceId: event.payload.messageId });
        if (event.payload.sourceProposedPlan) {
          visit({ kind: "proposed-plan", sourceId: event.payload.sourceProposedPlan.planId });
        }
        break;
      case "thread.turn-interrupt-requested":
        if (event.payload.turnId) visit({ kind: "turn", sourceId: event.payload.turnId });
        break;
      case "thread.approval-response-requested":
      case "thread.user-input-response-requested":
        visit({ kind: "approval-request", sourceId: event.payload.requestId });
        break;
      case "thread.session-set":
        if (event.payload.session.activeTurnId) {
          visit({ kind: "turn", sourceId: event.payload.session.activeTurnId });
        }
        break;
      case "thread.proposed-plan-upserted":
        visit({ kind: "proposed-plan", sourceId: event.payload.proposedPlan.id });
        if (event.payload.proposedPlan.turnId) {
          visit({ kind: "turn", sourceId: event.payload.proposedPlan.turnId });
        }
        break;
      case "thread.turn-diff-completed":
        visit({ kind: "turn", sourceId: event.payload.turnId });
        visit({
          kind: "checkpoint-ref",
          sourceId: event.payload.checkpointRef,
          checkpointTurnCount: event.payload.checkpointTurnCount,
        });
        if (event.payload.assistantMessageId) {
          visit({ kind: "message", sourceId: event.payload.assistantMessageId });
        }
        break;
      case "thread.activity-appended":
        visit({ kind: "activity", sourceId: event.payload.activity.id });
        if (event.payload.activity.turnId) {
          visit({ kind: "turn", sourceId: event.payload.activity.turnId });
        }
        break;
      default: {
        const unhandled: never = event;
        return unhandled;
      }
    }
  }
};

const collectOfficialImportIdentityCounts = (
  events: ReadonlyArray<OrchestrationEvent>,
): OfficialImportIdentityCounts => {
  const counts = emptyIdentityCounts();
  visitOfficialImportEventIdentities(events, ({ kind, sourceId }) => {
    const kindCounts = counts[kind];
    kindCounts.set(sourceId, (kindCounts.get(sourceId) ?? 0) + 1);
  });
  return counts;
};

const identityCollidesOutside = (
  allTargetCounts: OfficialImportIdentityCounts,
  excludedTargetCounts: OfficialImportIdentityCounts | undefined,
  kind: OfficialImportEventIdentityKind,
  sourceId: string,
): boolean =>
  (allTargetCounts[kind].get(sourceId) ?? 0) > (excludedTargetCounts?.[kind].get(sourceId) ?? 0);

const allocateEventIdentities = (input: {
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly targetThreadId?: ThreadId;
  readonly idMap: OfficialImportIdMap;
  readonly allocate: AllocateOfficialImportIdentity;
  readonly shouldAllocate: (kind: OfficialImportEventIdentityKind, sourceId: string) => boolean;
}): void => {
  const idMap = asMutableIdMap(input.idMap);
  const targetThreadId = input.targetThreadId;
  const shared = { allocate: input.allocate, ...(targetThreadId ? { targetThreadId } : {}) };
  visitOfficialImportEventIdentities(input.events, (identity) => {
    if (!input.shouldAllocate(identity.kind, identity.sourceId)) return;
    switch (identity.kind) {
      case "event":
        allocateMapped({
          ...shared,
          map: idMap.eventIds,
          sourceId: identity.sourceId,
          kind: identity.kind,
          make: EventId.make,
        });
        break;
      case "command":
        allocateMapped({
          ...shared,
          map: idMap.commandIds,
          sourceId: identity.sourceId,
          kind: identity.kind,
          make: CommandId.make,
        });
        break;
      case "message":
        allocateMapped({
          ...shared,
          map: idMap.messageIds,
          sourceId: identity.sourceId,
          kind: identity.kind,
          make: MessageId.make,
        });
        break;
      case "turn":
        allocateMapped({
          ...shared,
          map: idMap.turnIds,
          sourceId: identity.sourceId,
          kind: identity.kind,
          make: TurnId.make,
        });
        break;
      case "activity":
        allocateMapped({
          ...shared,
          map: idMap.activityIds,
          sourceId: identity.sourceId,
          kind: identity.kind,
          make: EventId.make,
        });
        break;
      case "approval-request":
        allocateMapped({
          ...shared,
          map: idMap.approvalRequestIds,
          sourceId: identity.sourceId,
          kind: identity.kind,
          make: ApprovalRequestId.make,
        });
        break;
      case "proposed-plan":
        allocateMapped({
          ...shared,
          map: idMap.proposedPlanIds,
          sourceId: identity.sourceId,
          kind: identity.kind,
          make: OrchestrationProposedPlanId.make,
        });
        break;
      case "attachment":
        allocateMapped({
          ...shared,
          map: idMap.attachmentIds,
          sourceId: identity.sourceId,
          kind: identity.kind,
          make: makeIdentity<ChatAttachmentId>,
        });
        break;
      case "checkpoint-ref":
        allocateMapped({
          ...shared,
          map: idMap.checkpointRefs,
          sourceId: identity.sourceId,
          kind: identity.kind,
          checkpointTurnCount: identity.checkpointTurnCount,
          make: CheckpointRef.make,
        });
        break;
      default: {
        const unhandled: never = identity;
        return unhandled;
      }
    }
  });
};

const indexUnique = <Item, Id extends string>(
  items: ReadonlyArray<Item>,
  getId: (item: Item) => Id,
  duplicateReason: "duplicate-project-id" | "duplicate-thread-id",
): ReadonlyMap<Id, Item> => {
  const indexed = new Map<Id, Item>();
  for (const item of items) {
    const id = getId(item);
    if (indexed.has(id)) {
      throw new OfficialImportPlanningError({ reason: duplicateReason, detail: id });
    }
    indexed.set(id, item);
  }
  return indexed;
};

const projectFingerprint = (project: OfficialImportProjectStream): string =>
  fingerprintOfficialImportStream(project.events);

const threadFingerprint = (thread: OfficialImportThreadStream): string =>
  fingerprintOfficialImportStream(thread.events);

export const planOfficialImport = (input: PlanOfficialImportInput): OfficialImportPlan => {
  const allocate = input.allocateIdentity ?? defaultAllocateIdentity;
  let idMap = copyIdMap(input.existingIdMap ?? emptyIdMap());
  let mutableIdMap = asMutableIdMap(idMap);
  const targetProjectsById = indexUnique(
    input.target.projects,
    (project) => project.projectId,
    "duplicate-project-id",
  );
  const targetThreadsById = indexUnique(
    input.target.threads,
    (thread) => thread.threadId,
    "duplicate-thread-id",
  );
  indexUnique(input.source.projects, (project) => project.projectId, "duplicate-project-id");
  indexUnique(input.source.threads, (thread) => thread.threadId, "duplicate-thread-id");
  const targetIdentityCounts = collectOfficialImportIdentityCounts([
    ...input.target.projects.flatMap((project) => project.events),
    ...input.target.threads.flatMap((thread) => thread.events),
  ]);
  const targetThreadIdentityCounts = new Map(
    input.target.threads.map(
      (thread) => [thread.threadId, collectOfficialImportIdentityCounts(thread.events)] as const,
    ),
  );

  const targetProjectsByRoot = new Map<string, OfficialImportProjectStream>();
  for (const project of input.target.projects) {
    const root = normalizeOfficialImportWorkspaceRoot(project.workspaceRoot);
    const existing = targetProjectsByRoot.get(root);
    if (existing && existing.projectId !== project.projectId) {
      throw new OfficialImportPlanningError({
        reason: "ambiguous-workspace-root",
        detail: project.workspaceRoot,
      });
    }
    targetProjectsByRoot.set(root, project);
  }

  const projects: Array<OfficialImportProjectPlan> = [];
  for (const sourceProject of input.source.projects) {
    const root = normalizeOfficialImportWorkspaceRoot(sourceProject.workspaceRoot);
    const byRoot = targetProjectsByRoot.get(root);
    const priorTargetId = idMap.projectIds[sourceProject.projectId];
    const priorTarget = priorTargetId ? targetProjectsById.get(priorTargetId) : undefined;
    const targetProject = byRoot ?? priorTarget;
    let targetProjectId: ProjectId;
    if (targetProject) {
      targetProjectId = targetProject.projectId;
    } else if (!targetProjectsById.has(sourceProject.projectId)) {
      targetProjectId = sourceProject.projectId;
    } else {
      targetProjectId = allocateMapped({
        map: mutableIdMap.projectIds,
        sourceId: sourceProject.projectId,
        kind: "project",
        allocate,
        make: ProjectId.make,
      });
    }
    mutableIdMap.projectIds[sourceProject.projectId] = targetProjectId;
    if (!targetProject) {
      allocateEventIdentities({
        events: sourceProject.events,
        idMap,
        allocate,
        shouldAllocate: (kind, sourceId) =>
          identityCollidesOutside(targetIdentityCounts, undefined, kind, sourceId),
      });
    }
    projects.push({
      sourceProjectId: sourceProject.projectId,
      targetProjectId,
      action: targetProject ? "reuse" : "import",
      sourceFingerprint: projectFingerprint(sourceProject),
      sourceHeadFingerprint: headFingerprint(sourceProject.events),
      targetFingerprint: targetProject ? projectFingerprint(targetProject) : null,
      targetHeadFingerprint: targetProject ? headFingerprint(targetProject.events) : null,
    });
  }

  const provisionalThreads: Array<OfficialImportThreadPlan> = [];
  for (const sourceThread of input.source.threads) {
    const idMapBeforeCollisionAllocation = copyIdMap(idMap);
    const priorTargetId = idMap.threadIds[sourceThread.threadId];
    const targetThread =
      (priorTargetId ? targetThreadsById.get(priorTargetId) : undefined) ??
      targetThreadsById.get(sourceThread.threadId);
    const excludedTargetCounts = targetThread
      ? targetThreadIdentityCounts.get(targetThread.threadId)
      : undefined;
    const collisionTargetThreadId = targetThread?.threadId ?? sourceThread.threadId;
    allocateEventIdentities({
      events: sourceThread.events,
      targetThreadId: collisionTargetThreadId,
      idMap,
      allocate,
      shouldAllocate: (kind, sourceId) =>
        identityCollidesOutside(targetIdentityCounts, excludedTargetCounts, kind, sourceId),
    });
    const comparisonEvents = targetThread
      ? sourceThread.events.map((event) => transformOfficialImportEvent(event, idMap))
      : sourceThread.events;
    const classification = classifyOfficialImportStream(comparisonEvents, targetThread?.events);
    const choice = input.collisionChoices?.[sourceThread.threadId];
    let action: OfficialImportThreadAction;
    let appendFrom = 0;
    let targetThreadId = targetThread?.threadId ?? sourceThread.threadId;
    switch (classification) {
      case "missing":
        action = "import";
        break;
      case "target-prefix":
        action = "fast-forward";
        appendFrom = targetThread?.events.length ?? 0;
        break;
      case "equal":
      case "source-behind":
        action = "noop";
        appendFrom = sourceThread.events.length;
        break;
      case "divergent":
        action = choice ?? "needs-choice";
        if (action === "clone") {
          idMap = idMapBeforeCollisionAllocation;
          mutableIdMap = asMutableIdMap(idMap);
          targetThreadId = allocateMapped({
            map: mutableIdMap.threadIds,
            sourceId: sourceThread.threadId,
            kind: "thread",
            allocate,
            make: ThreadId.make,
          });
        }
        break;
    }
    if (action === "noop" || action === "skip" || action === "needs-choice") {
      idMap = idMapBeforeCollisionAllocation;
      mutableIdMap = asMutableIdMap(idMap);
    }
    mutableIdMap.threadIds[sourceThread.threadId] = targetThreadId;
    if (action === "clone" || targetThreadId !== sourceThread.threadId) {
      allocateEventIdentities({
        events: sourceThread.events,
        targetThreadId,
        idMap,
        allocate,
        shouldAllocate: () => true,
      });
    }
    provisionalThreads.push({
      sourceThreadId: sourceThread.threadId,
      matchedTargetThreadId: targetThread?.threadId ?? null,
      targetThreadId,
      targetProjectId: remap(idMap.projectIds, sourceThread.projectId),
      classification,
      action,
      appendFrom,
      sourceFingerprint: threadFingerprint(sourceThread),
      sourceHeadFingerprint: headFingerprint(sourceThread.events),
      targetFingerprint: targetThread ? threadFingerprint(targetThread) : null,
      targetHeadFingerprint: targetThread ? headFingerprint(targetThread.events) : null,
    });
  }

  return { projects, threads: provisionalThreads, idMap };
};

const pushStreamStaleIssues = (input: {
  readonly scope: OfficialImportPlanStaleIssue["scope"];
  readonly id: string;
  readonly expectedFingerprint: string | null;
  readonly expectedHeadFingerprint: string | null;
  readonly actual: ReadonlyArray<OrchestrationEvent> | undefined;
  readonly issues: Array<OfficialImportPlanStaleIssue>;
}): void => {
  if (!input.actual) {
    if (input.expectedFingerprint !== null) {
      input.issues.push({ scope: input.scope, id: input.id, reason: "missing" });
    }
    return;
  }
  if (input.expectedFingerprint === null) {
    input.issues.push({ scope: input.scope, id: input.id, reason: "appeared" });
    return;
  }
  if (fingerprintOfficialImportStream(input.actual) !== input.expectedFingerprint) {
    input.issues.push({ scope: input.scope, id: input.id, reason: "fingerprint-changed" });
  }
  if (headFingerprint(input.actual) !== input.expectedHeadFingerprint) {
    input.issues.push({ scope: input.scope, id: input.id, reason: "head-changed" });
  }
};

export const validateOfficialImportPlan = (
  plan: OfficialImportPlan,
  currentSource: OfficialImportDataset,
  currentTarget: OfficialImportDataset,
): ReadonlyArray<OfficialImportPlanStaleIssue> => {
  const issues: Array<OfficialImportPlanStaleIssue> = [];
  const sourceProjects = new Map(currentSource.projects.map((item) => [item.projectId, item]));
  const targetProjects = new Map(currentTarget.projects.map((item) => [item.projectId, item]));
  const sourceThreads = new Map(currentSource.threads.map((item) => [item.threadId, item]));
  const targetThreads = new Map(currentTarget.threads.map((item) => [item.threadId, item]));

  for (const project of plan.projects) {
    pushStreamStaleIssues({
      scope: "source-project",
      id: project.sourceProjectId,
      expectedFingerprint: project.sourceFingerprint,
      expectedHeadFingerprint: project.sourceHeadFingerprint,
      actual: sourceProjects.get(project.sourceProjectId)?.events,
      issues,
    });
    pushStreamStaleIssues({
      scope: "target-project",
      id: project.targetProjectId,
      expectedFingerprint: project.targetFingerprint,
      expectedHeadFingerprint: project.targetHeadFingerprint,
      actual: targetProjects.get(project.targetProjectId)?.events,
      issues,
    });
  }
  for (const thread of plan.threads) {
    pushStreamStaleIssues({
      scope: "source-thread",
      id: thread.sourceThreadId,
      expectedFingerprint: thread.sourceFingerprint,
      expectedHeadFingerprint: thread.sourceHeadFingerprint,
      actual: sourceThreads.get(thread.sourceThreadId)?.events,
      issues,
    });
    pushStreamStaleIssues({
      scope: "target-thread",
      id: thread.matchedTargetThreadId ?? thread.targetThreadId,
      expectedFingerprint: thread.targetFingerprint,
      expectedHeadFingerprint: thread.targetHeadFingerprint,
      actual: targetThreads.get(thread.matchedTargetThreadId ?? thread.targetThreadId)?.events,
      issues,
    });
    if (
      thread.matchedTargetThreadId !== null &&
      thread.matchedTargetThreadId !== thread.targetThreadId &&
      targetThreads.has(thread.targetThreadId)
    ) {
      issues.push({
        scope: "target-thread",
        id: thread.targetThreadId,
        reason: "appeared",
      });
    }
  }
  return issues;
};

export const assertOfficialImportPlanFresh = (
  plan: OfficialImportPlan,
  currentSource: OfficialImportDataset,
  currentTarget: OfficialImportDataset,
): void => {
  const issues = validateOfficialImportPlan(plan, currentSource, currentTarget);
  if (issues.length > 0) {
    throw new OfficialImportPlanStaleError({ issues });
  }
};
