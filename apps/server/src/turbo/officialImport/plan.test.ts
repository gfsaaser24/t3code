import {
  OrchestrationEvent,
  ProjectId,
  ThreadId,
  type OrchestrationEvent as OrchestrationEventType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyOfficialImportStream,
  fingerprintOfficialImportEvent,
  normalizeOfficialImportWorkspaceRoot,
  OfficialImportPlanSchema,
  planOfficialImport,
  remapOfficialImportCommandReceiptIdentity,
  transformOfficialImportEvent,
  validateOfficialImportPlan,
  type AllocateOfficialImportIdentity,
  type OfficialImportDataset,
} from "./plan.ts";

const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const decodePlan = Schema.decodeUnknownSync(OfficialImportPlanSchema);
const timestamp = "2026-08-04T00:00:00.000Z";

const baseEvent = (input: {
  readonly sequence: number;
  readonly eventId: string;
  readonly threadId: string;
  readonly commandId?: string | null;
  readonly causationEventId?: string | null;
  readonly correlationId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}) => ({
  sequence: input.sequence,
  eventId: input.eventId,
  aggregateKind: "thread",
  aggregateId: input.threadId,
  occurredAt: timestamp,
  commandId: input.commandId ?? null,
  causationEventId: input.causationEventId ?? null,
  correlationId: input.correlationId ?? null,
  metadata: input.metadata ?? {},
});

const threadCreated = (input: {
  readonly sequence: number;
  readonly eventId: string;
  readonly threadId?: string;
  readonly projectId?: string;
  readonly title?: string;
}): OrchestrationEventType => {
  const threadId = input.threadId ?? "thread-source";
  return decodeEvent({
    ...baseEvent({ sequence: input.sequence, eventId: input.eventId, threadId }),
    type: "thread.created",
    payload: {
      threadId,
      projectId: input.projectId ?? "project-source",
      title: input.title ?? "Imported thread",
      modelSelection: { instanceId: "codex", model: "gpt-5.6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
};

const project = (projectId: string, workspaceRoot: string) => ({
  projectId: ProjectId.make(projectId),
  workspaceRoot,
  events: [] as ReadonlyArray<OrchestrationEventType>,
});

const thread = (
  threadId: string,
  projectId: string,
  events: ReadonlyArray<OrchestrationEventType>,
) => ({
  threadId: ThreadId.make(threadId),
  projectId: ProjectId.make(projectId),
  events,
});

const dataset = (
  projects: OfficialImportDataset["projects"],
  threads: OfficialImportDataset["threads"],
): OfficialImportDataset => ({ projects, threads });

describe("official import stream planning", () => {
  const first = threadCreated({ sequence: 1, eventId: "event-1" });
  const second = threadCreated({ sequence: 2, eventId: "event-2", title: "Second" });
  const third = threadCreated({ sequence: 3, eventId: "event-3", title: "Third" });

  it("classifies missing, prefix, equal, behind, and divergent streams", () => {
    expect(classifyOfficialImportStream([first], undefined)).toBe("missing");
    expect(classifyOfficialImportStream([first, second], [{ ...first, sequence: 98 }])).toBe(
      "target-prefix",
    );
    expect(classifyOfficialImportStream([first], [{ ...first, sequence: 99 }])).toBe("equal");
    expect(classifyOfficialImportStream([first], [{ ...first, sequence: 99 }, second])).toBe(
      "source-behind",
    );
    expect(classifyOfficialImportStream([first, second], [first, third])).toBe("divergent");
  });

  it("ignores only the destination-global sequence in a canonical event fingerprint", () => {
    expect(fingerprintOfficialImportEvent(first)).toBe(
      fingerprintOfficialImportEvent({ ...first, sequence: 50_000 }),
    );
    expect(fingerprintOfficialImportEvent(first)).not.toBe(
      fingerprintOfficialImportEvent(threadCreated({ sequence: 1, eventId: "event-other" })),
    );
  });

  it("maps projects by normalized workspace root and plans only the verified tail", () => {
    const source = dataset(
      [project("project-source", "C:\\Code\\Example\\")],
      [thread("thread-source", "project-source", [first, second])],
    );
    const target = dataset(
      [project("project-turbo", "c:/code/example")],
      [
        thread("thread-source", "project-turbo", [
          {
            ...threadCreated({
              sequence: 100,
              eventId: "event-1",
              projectId: "project-turbo",
            }),
          },
        ]),
      ],
    );

    const plan = planOfficialImport({ source, target });

    expect(normalizeOfficialImportWorkspaceRoot("C:\\Code\\Example\\")).toBe("c:/code/example");
    expect(plan.projects[0]).toMatchObject({
      action: "reuse",
      sourceProjectId: "project-source",
      targetProjectId: "project-turbo",
    });
    expect(plan.threads[0]).toMatchObject({
      action: "fast-forward",
      classification: "target-prefix",
      appendFrom: 1,
      targetProjectId: "project-turbo",
    });
  });

  it("requires an explicit choice for a divergent thread", () => {
    const source = dataset(
      [project("project-source", "/code/example")],
      [thread("thread-source", "project-source", [first])],
    );
    const target = dataset(
      [project("project-source", "/code/example")],
      [
        thread("thread-source", "project-source", [
          threadCreated({ sequence: 8, eventId: "event-target", title: "Turbo history" }),
        ]),
      ],
    );

    expect(planOfficialImport({ source, target }).threads[0]).toMatchObject({
      classification: "divergent",
      action: "needs-choice",
    });
    expect(
      planOfficialImport({
        source,
        target,
        collisionChoices: { "thread-source": "replace" },
      }).threads[0],
    ).toMatchObject({ action: "replace", targetThreadId: "thread-source" });
  });

  it("reuses a clone id reserved before a failed cutover", () => {
    const source = dataset(
      [project("project-source", "/code/example")],
      [thread("thread-source", "project-source", [first])],
    );
    const target = dataset(
      [project("project-source", "/code/example")],
      [
        thread("thread-source", "project-source", [
          threadCreated({ sequence: 8, eventId: "event-target", title: "Turbo history" }),
        ]),
      ],
    );
    const reserved = planOfficialImport({
      source,
      target,
      collisionChoices: { "thread-source": "clone" },
    });
    const reservedThreadId = reserved.threads[0]?.targetThreadId;

    const retry = planOfficialImport({
      source,
      target,
      collisionChoices: { "thread-source": "clone" },
      existingIdMap: reserved.idMap,
    });

    expect(retry.threads[0]).toMatchObject({
      action: "clone",
      matchedTargetThreadId: "thread-source",
      targetThreadId: reservedThreadId,
    });
  });
});

describe("official import clone identity graph", () => {
  it("rekeys every schema-known T3 identity and preserves provider-owned opaque data", () => {
    const sourceThreadId = "thread-source";
    const sourceEvents = [
      decodeEvent({
        ...baseEvent({
          sequence: 1,
          eventId: "event-created",
          threadId: sourceThreadId,
          commandId: "command-created",
          correlationId: "command-correlation",
          metadata: { providerTurnId: "provider-turn", providerItemId: "provider-item" },
        }),
        type: "thread.created",
        payload: {
          threadId: sourceThreadId,
          projectId: "project-source",
          title: "Official history",
          modelSelection: { instanceId: "codex", model: "gpt-5.6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      }),
      decodeEvent({
        ...baseEvent({ sequence: 2, eventId: "event-meta", threadId: sourceThreadId }),
        type: "thread.meta-updated",
        payload: {
          threadId: sourceThreadId,
          titleRegeneration: { requestId: "command-title", startedAt: timestamp },
          updatedAt: timestamp,
        },
      }),
      decodeEvent({
        ...baseEvent({ sequence: 3, eventId: "event-message", threadId: sourceThreadId }),
        type: "thread.message-sent",
        payload: {
          threadId: sourceThreadId,
          messageId: "message-source",
          role: "user",
          text: "hello",
          attachments: [
            {
              type: "image",
              id: "thread-source-00000000-0000-4000-8000-000000000001",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 10,
            },
          ],
          turnId: "turn-source",
          streaming: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      }),
      decodeEvent({
        ...baseEvent({
          sequence: 4,
          eventId: "event-turn-start",
          threadId: sourceThreadId,
          metadata: { requestId: "approval-source" },
        }),
        type: "thread.turn-start-requested",
        payload: {
          threadId: sourceThreadId,
          messageId: "message-source",
          runtimeMode: "full-access",
          interactionMode: "default",
          sourceProposedPlan: { threadId: sourceThreadId, planId: "plan-source" },
          createdAt: timestamp,
        },
      }),
      decodeEvent({
        ...baseEvent({ sequence: 5, eventId: "event-approval", threadId: sourceThreadId }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: sourceThreadId,
          requestId: "approval-source",
          decision: "accept",
          createdAt: timestamp,
        },
      }),
      decodeEvent({
        ...baseEvent({ sequence: 6, eventId: "event-session", threadId: sourceThreadId }),
        type: "thread.session-set",
        payload: {
          threadId: sourceThreadId,
          session: {
            threadId: sourceThreadId,
            status: "stopped",
            providerName: "opaque-provider-session",
            providerInstanceId: "codex",
            runtimeMode: "full-access",
            activeTurnId: "turn-source",
            lastError: null,
            updatedAt: timestamp,
          },
        },
      }),
      decodeEvent({
        ...baseEvent({ sequence: 7, eventId: "event-plan", threadId: sourceThreadId }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: sourceThreadId,
          proposedPlan: {
            id: "plan-source",
            turnId: "turn-source",
            planMarkdown: "Do the work",
            implementedAt: null,
            implementationThreadId: sourceThreadId,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
      }),
      decodeEvent({
        ...baseEvent({ sequence: 8, eventId: "event-diff", threadId: sourceThreadId }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: sourceThreadId,
          turnId: "turn-source",
          checkpointTurnCount: 1,
          checkpointRef: "refs/t3/checkpoints/source/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "message-source",
          completedAt: timestamp,
        },
      }),
      decodeEvent({
        ...baseEvent({ sequence: 9, eventId: "event-activity", threadId: sourceThreadId }),
        type: "thread.activity-appended",
        payload: {
          threadId: sourceThreadId,
          activity: {
            id: "activity-source",
            tone: "tool",
            kind: "provider.activity",
            summary: "Worked",
            payload: { threadId: sourceThreadId, providerItemId: "provider-item" },
            turnId: "turn-source",
            createdAt: timestamp,
          },
        },
      }),
    ];
    const targetEvents = [
      threadCreated({
        sequence: 50,
        eventId: "event-turbo",
        threadId: sourceThreadId,
        title: "Turbo history",
      }),
    ];
    let allocation = 0;
    const allocateIdentity: AllocateOfficialImportIdentity = ({ kind }) => {
      allocation += 1;
      return `${kind}-clone-${allocation}`;
    };
    const planInputSource = dataset(
      [project("project-source", "/code/example")],
      [thread(sourceThreadId, "project-source", sourceEvents)],
    );
    const planInputTarget = dataset(
      [project("project-source", "/code/example")],
      [thread(sourceThreadId, "project-source", targetEvents)],
    );
    const plan = planOfficialImport({
      source: planInputSource,
      target: planInputTarget,
      collisionChoices: { [sourceThreadId]: "clone" },
      allocateIdentity,
    });
    const clonedThreadId = plan.threads[0]?.targetThreadId;
    expect(clonedThreadId).not.toBe(sourceThreadId);
    expect(validateOfficialImportPlan(plan, planInputSource, planInputTarget)).toEqual([]);
    expect(() => decodePlan(JSON.parse(JSON.stringify(plan)))).not.toThrow();

    const transformed = sourceEvents.map((event) =>
      transformOfficialImportEvent(event, plan.idMap),
    );
    expect(transformed.every((event) => event.aggregateId === clonedThreadId)).toBe(true);
    expect(transformed.map((event) => event.eventId)).not.toContain("event-created");
    expect(
      remapOfficialImportCommandReceiptIdentity(
        {
          commandId: sourceEvents[0]!.commandId!,
          aggregateKind: "thread",
          aggregateId: ThreadId.make(sourceThreadId),
        },
        plan.idMap,
      ),
    ).toMatchObject({ aggregateId: clonedThreadId });

    const created = transformed.find((event) => event.type === "thread.created");
    expect(created?.payload.threadId).toBe(clonedThreadId);
    expect(created?.metadata).toMatchObject({
      providerTurnId: "provider-turn",
      providerItemId: "provider-item",
    });

    const message = transformed.find((event) => event.type === "thread.message-sent");
    expect(message?.payload).toMatchObject({ threadId: clonedThreadId });
    if (message?.type === "thread.message-sent") {
      expect(message.payload.messageId).not.toBe("message-source");
      expect(message.payload.turnId).not.toBe("turn-source");
      expect(message.payload.attachments?.[0]?.id).not.toContain("thread-source-");
    }

    const turnStart = transformed.find((event) => event.type === "thread.turn-start-requested");
    if (turnStart?.type === "thread.turn-start-requested") {
      expect(turnStart.payload.sourceProposedPlan).toMatchObject({ threadId: clonedThreadId });
      expect(turnStart.payload.sourceProposedPlan?.planId).not.toBe("plan-source");
    }
    const approval = transformed.find(
      (event) => event.type === "thread.approval-response-requested",
    );
    if (approval?.type === "thread.approval-response-requested") {
      expect(approval.payload.requestId).not.toBe("approval-source");
    }
    const session = transformed.find((event) => event.type === "thread.session-set");
    if (session?.type === "thread.session-set") {
      expect(session.payload.session).toMatchObject({
        threadId: clonedThreadId,
        providerName: "opaque-provider-session",
      });
      expect(session.payload.session.activeTurnId).not.toBe("turn-source");
    }
    const proposedPlan = transformed.find(
      (event) => event.type === "thread.proposed-plan-upserted",
    );
    if (proposedPlan?.type === "thread.proposed-plan-upserted") {
      expect(proposedPlan.payload.proposedPlan).toMatchObject({
        implementationThreadId: clonedThreadId,
      });
      expect(proposedPlan.payload.proposedPlan.id).not.toBe("plan-source");
    }
    const diff = transformed.find((event) => event.type === "thread.turn-diff-completed");
    if (diff?.type === "thread.turn-diff-completed") {
      expect(diff.payload.checkpointRef).not.toBe("refs/t3/checkpoints/source/turn/1");
      expect(diff.payload.assistantMessageId).not.toBe("message-source");
    }
    const activity = transformed.find((event) => event.type === "thread.activity-appended");
    if (activity?.type === "thread.activity-appended") {
      expect(activity.payload.activity.id).not.toBe("activity-source");
      expect(activity.payload.activity.turnId).not.toBe("turn-source");
      expect(activity.payload.activity.payload).toEqual({
        threadId: sourceThreadId,
        providerItemId: "provider-item",
      });
    }
  });

  it("rejects a saved plan after the source head changes", () => {
    const source = dataset(
      [project("project-source", "/code/example")],
      [
        thread("thread-source", "project-source", [
          threadCreated({ sequence: 1, eventId: "event-1" }),
        ]),
      ],
    );
    const target = dataset([project("project-source", "/code/example")], []);
    const plan = planOfficialImport({ source, target });
    const changedSource = dataset(source.projects, [
      thread("thread-source", "project-source", [
        ...source.threads[0]!.events,
        threadCreated({ sequence: 2, eventId: "event-2" }),
      ]),
    ]);

    expect(validateOfficialImportPlan(plan, changedSource, target)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "source-thread",
          id: "thread-source",
          reason: "fingerprint-changed",
        }),
        expect.objectContaining({
          scope: "source-thread",
          id: "thread-source",
          reason: "head-changed",
        }),
      ]),
    );
  });
});
