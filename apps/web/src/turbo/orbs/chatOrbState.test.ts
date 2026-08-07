import { describe, expect, it } from "vite-plus/test";

import {
  chatOrbLabel,
  resolveChatOrbState,
  selectChatOrbActivity,
  type ChatOrbInput,
  type ChatOrbWorkLogEntry,
} from "./chatOrbState";

const idle: ChatOrbInput = {
  turnRunning: false,
  awaitingUser: false,
  monitoring: false,
  activeSubagentCount: 0,
  activeToolKind: null,
  streamKind: null,
};

const running: ChatOrbInput = { ...idle, turnRunning: true };

describe("resolveChatOrbState", () => {
  it("shows nothing when the thread is idle", () => {
    expect(resolveChatOrbState(idle)).toBeNull();
  });

  it("keeps breathing while background work outlives its turn", () => {
    expect(resolveChatOrbState({ ...idle, monitoring: true })).toBe("breathing");
  });

  it("puts waiting on the user above everything else", () => {
    // A spinner here would read as "still busy, leave it alone", which is the
    // opposite of the truth: this is the only state the user must act on.
    const busiest: ChatOrbInput = {
      turnRunning: true,
      awaitingUser: true,
      monitoring: true,
      activeSubagentCount: 4,
      activeToolKind: "web_search",
      streamKind: "assistant_text",
    };
    expect(resolveChatOrbState(busiest)).toBe("listening");
  });

  it("prefers a fan-out over the parent's own tool call", () => {
    expect(
      resolveChatOrbState({ ...running, activeSubagentCount: 3, activeToolKind: "web_search" }),
    ).toBe("weaving");
  });

  it("prefers the running tool over the text streaming back from it", () => {
    expect(
      resolveChatOrbState({
        ...running,
        activeToolKind: "mcp_tool_call",
        streamKind: "assistant_text",
      }),
    ).toBe("connecting");
  });

  describe("tool kinds", () => {
    const cases = [
      ["web_search", "searching"],
      ["mcp_tool_call", "connecting"],
      ["collab_agent_tool_call", "weaving"],
      ["file_change", "shaping"],
      ["image_view", "searching"],
      // A shell command or an unknown tool is exactly the generic case.
      ["command_execution", "working"],
      ["dynamic_tool_call", "working"],
    ] as const;

    for (const [kind, expected] of cases) {
      it(`maps ${kind} to ${expected}`, () => {
        expect(resolveChatOrbState({ ...running, activeToolKind: kind })).toBe(expected);
      });
    }
  });

  describe("streamed content", () => {
    const cases = [
      ["reasoning_text", "solving"],
      ["reasoning_summary_text", "solving"],
      ["assistant_text", "composing"],
      ["plan_text", "shaping"],
      ["command_output", "working"],
      ["unknown", "working"],
    ] as const;

    for (const [kind, expected] of cases) {
      it(`maps ${kind} to ${expected}`, () => {
        expect(resolveChatOrbState({ ...running, streamKind: kind })).toBe(expected);
      });
    }
  });

  it("falls back to working for a turn with nothing else to say", () => {
    expect(resolveChatOrbState(running)).toBe("working");
  });

  it("ignores stale activity once the turn ends", () => {
    // Tool and stream fields can lag a turn ending; they must not keep the orb
    // alive after the work is done.
    expect(
      resolveChatOrbState({ ...idle, activeToolKind: "web_search", streamKind: "assistant_text" }),
    ).toBeNull();
  });

  it("still reports subagents only while the turn runs", () => {
    expect(resolveChatOrbState({ ...idle, activeSubagentCount: 2 })).toBeNull();
    expect(resolveChatOrbState({ ...running, activeSubagentCount: 2 })).toBe("weaving");
  });
});

describe("selectChatOrbActivity", () => {
  const tool = (
    itemType: NonNullable<ChatOrbWorkLogEntry["itemType"]>,
    toolLifecycleStatus: NonNullable<ChatOrbWorkLogEntry["toolLifecycleStatus"]>,
  ): ChatOrbWorkLogEntry => ({ tone: "tool", itemType, toolLifecycleStatus });

  it("reports nothing for an empty log", () => {
    expect(selectChatOrbActivity([])).toEqual({ activeToolKind: null, streamKind: null });
  });

  it("picks up a tool that is still in progress", () => {
    expect(selectChatOrbActivity([tool("web_search", "inProgress")])).toEqual({
      activeToolKind: "web_search",
      streamKind: null,
    });
  });

  it("ignores a tool that already finished", () => {
    // A completed row must not keep its orb alive.
    for (const status of ["completed", "failed", "declined", "stopped"] as const) {
      expect(selectChatOrbActivity([tool("mcp_tool_call", status)]).activeToolKind).toBeNull();
    }
  });

  it("takes the newest in-progress tool when several are logged", () => {
    expect(
      selectChatOrbActivity([tool("web_search", "inProgress"), tool("mcp_tool_call", "inProgress")])
        .activeToolKind,
    ).toBe("mcp_tool_call");
  });

  it("reads thinking from the entry tone", () => {
    expect(selectChatOrbActivity([{ tone: "thinking" }])).toEqual({
      activeToolKind: null,
      streamKind: "reasoning_text",
    });
  });

  it("prefers a live tool over earlier thinking", () => {
    expect(
      selectChatOrbActivity([{ tone: "thinking" }, tool("file_change", "inProgress")]),
    ).toEqual({ activeToolKind: "file_change", streamKind: null });
  });

  it("stops at a finished tool instead of reviving older thinking", () => {
    // Scanning past a completed tool would resurrect reasoning the model has
    // already moved on from.
    expect(selectChatOrbActivity([{ tone: "thinking" }, tool("web_search", "completed")])).toEqual({
      activeToolKind: null,
      streamKind: null,
    });
  });

  it("skips non-tool chatter to find the current state", () => {
    expect(
      selectChatOrbActivity([{ tone: "info" }, { tone: "thinking" }, { tone: "info" }]).streamKind,
    ).toBe("reasoning_text");
  });
});

describe("chatOrbLabel", () => {
  it("counts subagents so the label carries the fan-out", () => {
    expect(chatOrbLabel("weaving", 1)).toBe("1 subagent working");
    expect(chatOrbLabel("weaving", 5)).toBe("5 subagents working");
  });

  it("falls back to the plain label without a count", () => {
    expect(chatOrbLabel("weaving", 0)).toBe("Subagents working");
  });

  it("labels every other state without a count", () => {
    expect(chatOrbLabel("solving")).toBe("Thinking");
    expect(chatOrbLabel("listening")).toBe("Waiting for you");
    expect(chatOrbLabel("breathing")).toBe("Monitoring in the background");
  });
});
