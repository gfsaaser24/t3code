import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { OfficialImportDatasetError, buildOfficialImportDataset } from "./execute.ts";

const NOW = "2026-08-04T23:00:00.000Z";

const projectCreated = {
  sequence: 1,
  eventId: EventId.make("event-project-created"),
  aggregateKind: "project",
  aggregateId: ProjectId.make("project-1"),
  type: "project.created",
  occurredAt: NOW,
  commandId: CommandId.make("command-project-created"),
  causationEventId: null,
  correlationId: CommandId.make("command-project-created"),
  metadata: {},
  payload: {
    projectId: ProjectId.make("project-1"),
    title: "Project",
    workspaceRoot: "C:/old",
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  },
} satisfies OrchestrationEvent;

const projectMoved = {
  sequence: 2,
  eventId: EventId.make("event-project-moved"),
  aggregateKind: "project",
  aggregateId: ProjectId.make("project-1"),
  type: "project.meta-updated",
  occurredAt: NOW,
  commandId: CommandId.make("command-project-moved"),
  causationEventId: null,
  correlationId: CommandId.make("command-project-moved"),
  metadata: {},
  payload: {
    projectId: ProjectId.make("project-1"),
    workspaceRoot: "C:/current",
    updatedAt: NOW,
  },
} satisfies OrchestrationEvent;

const threadCreated = {
  sequence: 3,
  eventId: EventId.make("event-thread-created"),
  aggregateKind: "thread",
  aggregateId: ThreadId.make("thread-1"),
  type: "thread.created",
  occurredAt: NOW,
  commandId: CommandId.make("command-thread-created"),
  causationEventId: null,
  correlationId: CommandId.make("command-thread-created"),
  metadata: {},
  payload: {
    threadId: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
} satisfies OrchestrationEvent;

it("derives projects and threads from canonical events instead of copied projections", () => {
  const dataset = buildOfficialImportDataset([projectCreated, projectMoved, threadCreated]);

  assert.equal(dataset.projects.length, 1);
  assert.equal(dataset.projects[0]?.workspaceRoot, "C:/current");
  assert.equal(dataset.threads.length, 1);
  assert.equal(dataset.threads[0]?.projectId, "project-1");
  assert.deepEqual(dataset.threads[0]?.events, [threadCreated]);
});

it("rejects an incomplete canonical stream instead of guessing from projections", () => {
  assert.throws(
    () =>
      buildOfficialImportDataset([
        {
          ...threadCreated,
          type: "thread.deleted",
          payload: { threadId: ThreadId.make("thread-1"), deletedAt: NOW },
        },
      ]),
    OfficialImportDatasetError,
  );
});
