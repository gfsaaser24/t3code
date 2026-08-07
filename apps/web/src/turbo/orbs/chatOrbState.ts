/**
 * Shared vocabulary for the thinking orbs rendered in the transcript.
 *
 * Deliberately small. An earlier version derived a single thread-level state
 * from the whole activity stream, but the orbs ended up on the rows describing
 * the work rather than on one indicator — so each row already knows what it is
 * doing, and that resolver had no caller. What remains is the state union and
 * the labels, which every render site shares.
 */

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
