import { describe, expect, it } from "vite-plus/test";

import { chatOrbLabel, type ChatOrbState } from "./chatOrbState";
import { TIMELINE_ORB_SIZE, toolOrbState } from "./TimelineOrb";

describe("toolOrbState", () => {
  const cases = [
    ["web_search", "searching"],
    ["image_view", "searching"],
    ["mcp_tool_call", "connecting"],
    ["collab_agent_tool_call", "weaving"],
    ["file_change", "shaping"],
    // A shell command or an unknown tool is exactly the generic case.
    ["command_execution", "working"],
    ["dynamic_tool_call", "working"],
  ] as const;

  for (const [kind, expected] of cases) {
    it(`maps ${kind} to ${expected}`, () => {
      expect(toolOrbState(kind)).toBe(expected);
    });
  }

  it("falls back to working when the kind is absent", () => {
    // Older activities can reach the row without an itemType.
    expect(toolOrbState(undefined)).toBe("working");
  });
});

describe("TIMELINE_ORB_SIZE", () => {
  it("is one of the two sizes the library ships", () => {
    // The presets are separate designs, not a scale factor: any other value is
    // silently ignored by the canvas and overflows its slot.
    expect([20, 64]).toContain(TIMELINE_ORB_SIZE);
  });
});

describe("chatOrbLabel", () => {
  it("counts subagents so the label carries the fan-out", () => {
    expect(chatOrbLabel("weaving", 1)).toBe("1 subagent working");
    expect(chatOrbLabel("weaving", 5)).toBe("5 subagents working");
  });

  it("never renders a zero or mismatched plural", () => {
    // The spawn row passes its own count straight through, so a settled or
    // empty fan-out must not read "0 subagents working".
    expect(chatOrbLabel("weaving", 0)).toBe("Subagents working");
  });

  it("labels every state", () => {
    const states: ReadonlyArray<ChatOrbState> = [
      "working",
      "searching",
      "solving",
      "listening",
      "connecting",
      "weaving",
      "composing",
      "breathing",
      "shaping",
    ];
    for (const state of states) {
      expect(chatOrbLabel(state), state).toMatch(/\S/);
    }
  });
});
