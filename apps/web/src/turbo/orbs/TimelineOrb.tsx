/**
 * A single in-progress indicator inside the transcript.
 *
 * Rows only render this while their work is live, so it carries no condition of
 * its own — the caller's `inProgress` check is the condition. Finished rows go
 * back to their normal icon, which keeps motion meaning "this is happening" in
 * a long transcript rather than becoming ambient noise.
 *
 * It also removes a font dependency: several of these indicators were text
 * glyphs (● ○ ✓) that changed size, weight and baseline with the interface
 * font, or fell back to another face when the chosen font lacked them. The orb
 * is canvas-drawn, so it is identical under every font.
 */
import { ThinkingOrb } from "thinking-orbs";

import type { ToolLifecycleItemType } from "@t3tools/contracts";

import type { ChatOrbState } from "./chatOrbState";

/** Matches the 14px line-height of the rows these sit in. */
const TIMELINE_ORB_SIZE = 20;

export function TimelineOrb({
  state,
  label,
}: {
  readonly state: ChatOrbState;
  readonly label: string;
}) {
  return (
    <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
      <ThinkingOrb state={state} size={TIMELINE_ORB_SIZE} aria-label={label} />
    </span>
  );
}

/**
 * Tool kinds that read as something more specific than "working".
 * `command_execution` and `dynamic_tool_call` fall through deliberately: a
 * shell command or an unknown tool is exactly the generic case.
 */
export function toolOrbState(itemType: ToolLifecycleItemType | undefined): ChatOrbState {
  switch (itemType) {
    case "web_search":
    case "image_view":
      return "searching";
    case "mcp_tool_call":
      return "connecting";
    case "collab_agent_tool_call":
      return "weaving";
    case "file_change":
      return "shaping";
    default:
      return "working";
  }
}
