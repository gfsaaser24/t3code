/**
 * Maps what a thread is actually doing onto a thinking-orb state.
 *
 * The nine orb states line up with signals T3 already tracks, so this is a
 * projection rather than new bookkeeping: streamed content kinds distinguish
 * thinking from writing from planning, tool lifecycle items are already typed
 * by kind, and subagent activity is already counted.
 */
import type { ToolLifecycleItemType } from "@t3tools/contracts";

/** The nine states `thinking-orbs` ships. */
export type ChatOrbState =
  | "working"
  | "searching"
  | "solving"
  | "listening"
  | "connecting"
  | "weaving"
  | "composing"
  | "breathing"
  | "shaping";

/**
 * The streamed content kinds that tell us what the model is producing right
 * now. Mirrors RuntimeContentStreamKind; only the kinds that change the orb
 * are named.
 */
export type ChatOrbStreamKind =
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output"
  | "unknown";

export interface ChatOrbInput {
  /** A turn is in flight. Nothing below matters when this is false. */
  readonly turnRunning: boolean;
  /** The agent is blocked on the user: an approval, or a question. */
  readonly awaitingUser: boolean;
  /** Background work continues with no turn attached. */
  readonly monitoring: boolean;
  /** Subagents currently pending, running or waiting. */
  readonly activeSubagentCount: number;
  /** The tool lifecycle item in flight, if any. */
  readonly activeToolKind: ToolLifecycleItemType | null;
  /** The content kind currently streaming, if any. */
  readonly streamKind: ChatOrbStreamKind | null;
}

/**
 * Tool kinds that read as something more specific than "working".
 * `command_execution` and `dynamic_tool_call` deliberately fall through: a
 * shell command or an unknown tool is exactly the generic case.
 */
const TOOL_ORB_STATES: Partial<Record<ToolLifecycleItemType, ChatOrbState>> = {
  web_search: "searching",
  mcp_tool_call: "connecting",
  collab_agent_tool_call: "weaving",
  file_change: "shaping",
  image_view: "searching",
};

const STREAM_ORB_STATES: Partial<Record<ChatOrbStreamKind, ChatOrbState>> = {
  reasoning_text: "solving",
  reasoning_summary_text: "solving",
  assistant_text: "composing",
  plan_text: "shaping",
};

/**
 * Resolves the orb for a thread, or null when it is simply idle.
 *
 * Order is the point of this function. Waiting on the user outranks everything
 * because it is the only state the user has to act on; a spinner there reads as
 * "still busy, leave it alone", which is the opposite of the truth. Subagents
 * outrank the parent's own tool call because a fan-out is the more interesting
 * fact on screen. Tool kind outranks the streamed text because the tool is what
 * is actually happening while its output streams back.
 */
export function resolveChatOrbState(input: ChatOrbInput): ChatOrbState | null {
  if (input.awaitingUser) return "listening";

  if (!input.turnRunning) {
    // Monitoring is the one activity that outlives its turn: nothing is being
    // generated, but something is still being watched.
    return input.monitoring ? "breathing" : null;
  }

  if (input.activeSubagentCount > 0) return "weaving";

  if (input.activeToolKind) {
    return TOOL_ORB_STATES[input.activeToolKind] ?? "working";
  }

  if (input.streamKind) {
    return STREAM_ORB_STATES[input.streamKind] ?? "working";
  }

  return "working";
}

/** Screen-reader label for each state; the orb renders as role="img". */
const ORB_LABELS: Readonly<Record<ChatOrbState, string>> = {
  working: "Working",
  searching: "Searching",
  solving: "Thinking",
  listening: "Waiting for you",
  connecting: "Calling an MCP tool",
  weaving: "Subagents working",
  composing: "Writing a response",
  breathing: "Monitoring in the background",
  shaping: "Editing files",
};

export function chatOrbLabel(state: ChatOrbState, activeSubagentCount = 0): string {
  if (state === "weaving" && activeSubagentCount > 0) {
    return `${activeSubagentCount} subagent${activeSubagentCount === 1 ? "" : "s"} working`;
  }
  return ORB_LABELS[state];
}
