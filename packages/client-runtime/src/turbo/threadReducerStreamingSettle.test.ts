/**
 * T3 Turbo (fork-owned): the reducer must clear `streaming` when it settles a turn.
 *
 * `OrchestrationMessage.streaming` is only ever lowered by the final
 * `thread.message-sent` for that message. When a turn ends any other way — the
 * session leaves "running" (a provider `runtime.error`, a `session.exited`, an
 * explicit stop, a socket drop the supervisor notices) or the user interrupts —
 * that final event never arrives, and the flag used to stay raised forever. It
 * is persisted that way too, which is why `isStreaming` could not be trusted.
 *
 * Several symptoms shared that one root cause: the streaming code-fence
 * placeholder pulsing forever, the "empty response" label, a hidden message
 * footer, a copy button stuck in its streaming state, and mis-grouped turns.
 * None of those consumers were changed — the flag being honest heals them all,
 * which is exactly why this file pins the flag rather than any one symptom.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { OrchestrationThread } from "@t3tools/contracts";

import { applyThreadDetailEvent } from "../state/threadReducer.ts";

const baseEventFields = {
  eventId: EventId.make("event-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

const TURN = TurnId.make("turn-1");
const OTHER_TURN = TurnId.make("turn-2");

function threadWithStreamingMessage(): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Test Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: TURN,
      state: "running",
      requestedAt: "2026-04-01T07:00:00.000Z",
      startedAt: "2026-04-01T07:00:00.000Z",
      completedAt: null,
      assistantMessageId: MessageId.make("msg-streaming"),
    },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make("msg-done"),
        role: "user",
        text: "write me a function",
        turnId: TURN,
        streaming: false,
        createdAt: "2026-04-01T07:00:00.000Z",
        updatedAt: "2026-04-01T07:00:00.000Z",
      },
      {
        id: MessageId.make("msg-streaming"),
        role: "assistant",
        text: "```ts\nconst a = 1;",
        turnId: TURN,
        streaming: true,
        createdAt: "2026-04-01T07:00:01.000Z",
        updatedAt: "2026-04-01T07:00:01.000Z",
      },
      {
        id: MessageId.make("msg-other-turn"),
        role: "assistant",
        text: "still going on a different turn",
        turnId: OTHER_TURN,
        streaming: true,
        createdAt: "2026-04-01T07:00:02.000Z",
        updatedAt: "2026-04-01T07:00:02.000Z",
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId: ThreadId.make("thread-1"),
      status: "running",
      providerName: "claude",
      runtimeMode: "full-access",
      activeTurnId: TURN,
      lastError: null,
      updatedAt: "2026-04-01T07:00:00.000Z",
    },
  } as unknown as OrchestrationThread;
}

function sessionSet(status: "ready" | "error" | "stopped" | "running") {
  return {
    ...baseEventFields,
    sequence: 9,
    occurredAt: "2026-04-01T08:00:00.000Z",
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    type: "thread.session-set",
    payload: {
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status,
        providerName: "claude",
        runtimeMode: "full-access",
        activeTurnId: status === "running" ? TURN : null,
        lastError: status === "error" ? "provider died" : null,
        updatedAt: "2026-04-01T08:00:00.000Z",
      },
    },
  } as never;
}

function streamingIds(thread: OrchestrationThread): ReadonlyArray<string> {
  return thread.messages.filter((message) => message.streaming).map((message) => message.id);
}

describe("thread.session-set clears streaming on the settled turn", () => {
  for (const status of ["ready", "error", "stopped"] as const) {
    it(`clears it when the session settles to "${status}"`, () => {
      const result = applyThreadDetailEvent(threadWithStreamingMessage(), sessionSet(status));

      expect(result.kind).toBe("updated");
      if (result.kind !== "updated") return;
      // The settled turn's message stops streaming; a message on a DIFFERENT
      // turn is untouched — a background subagent's turn is not settled by this
      // session transition.
      expect(streamingIds(result.thread)).toEqual(["msg-other-turn"]);
      expect(result.thread.latestTurn?.state).not.toBe("running");
    });
  }

  it("leaves the flag alone while the session is still running", () => {
    const result = applyThreadDetailEvent(threadWithStreamingMessage(), sessionSet("running"));

    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") return;
    expect(streamingIds(result.thread)).toEqual(["msg-streaming", "msg-other-turn"]);
  });

  it("returns the same messages array when nothing was streaming", () => {
    const thread = threadWithStreamingMessage();
    const settled: OrchestrationThread = {
      ...thread,
      messages: thread.messages.map((message) => ({ ...message, streaming: false })),
    };

    const result = applyThreadDetailEvent(settled, sessionSet("ready"));

    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") return;
    // Allocation-free on the overwhelmingly common path: a turn whose messages
    // already finished cleanly must not re-create the array on every settle.
    expect(result.thread.messages).toBe(settled.messages);
  });
});

describe("thread.turn-interrupt-requested clears streaming on the interrupted turn", () => {
  const interrupt = {
    ...baseEventFields,
    sequence: 9,
    occurredAt: "2026-04-01T08:00:00.000Z",
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    type: "thread.turn-interrupt-requested",
    payload: {
      threadId: ThreadId.make("thread-1"),
      turnId: TURN,
      createdAt: "2026-04-01T08:00:00.000Z",
    },
  } as never;

  it("stops the interrupted turn's messages from claiming to stream", () => {
    const result = applyThreadDetailEvent(threadWithStreamingMessage(), interrupt);

    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") return;
    expect(streamingIds(result.thread)).toEqual(["msg-other-turn"]);
    expect(result.thread.latestTurn?.state).toBe("interrupted");
  });
});
