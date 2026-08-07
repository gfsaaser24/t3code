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

/**
 * The library ships exactly two sizes, 20 and 64, and documents them as
 * separate designs rather than a scale factor — each carries its own dot count
 * and speed tuning. 20 is therefore a floor, not a hint: the slot has to be
 * built around it. Sizing the box any smaller does not shrink the canvas, it
 * just lets it overflow.
 */
export const TIMELINE_ORB_SIZE = 20;

export function TimelineOrb({
  state,
  label,
}: {
  readonly state: ChatOrbState;
  readonly label: string;
}) {
  return (
    <span className="inline-flex size-5 shrink-0 items-center justify-center leading-none">
      <ThinkingOrb state={state} size={TIMELINE_ORB_SIZE} aria-label={label} />
    </span>
  );
}

/**
 * The resting counterpart, sized to the same 20px slot.
 *
 * Rows swap between the two as work starts and finishes, so they must occupy
 * identical space — otherwise a fan-out completing shifts its whole row
 * sideways at the moment attention is on it.
 */
export function TimelineOrbSlot({ className }: { readonly className?: string }) {
  return (
    <span className="inline-flex size-5 shrink-0 items-center justify-center leading-none">
      <span aria-hidden className={className} />
    </span>
  );
}

/**
 * The composer's orb, above the stop button.
 *
 * Fixed to `solving` rather than tracking the live state: this slot answers
 * "the model has the floor", and the per-state detail belongs on the rows where
 * the thing it describes is visible. Rendered only inside the stop button's
 * branch, so it appears exactly while a turn can be stopped and cannot outlive
 * one.
 */
export function ComposerThinkingOrb() {
  return <ThinkingOrb state="solving" size={TIMELINE_ORB_SIZE} aria-label="Thinking" />;
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
