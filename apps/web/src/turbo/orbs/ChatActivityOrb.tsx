/**
 * The thread's current activity, as an orb.
 *
 * Rendering is left entirely to `thinking-orbs`: it paints on a 2D canvas with
 * arcs only, pauses itself offscreen and on a hidden tab, shares one clock
 * across instances so they stay in phase, and draws a single static frame under
 * prefers-reduced-motion. It also resolves light/dark from the `dark` class the
 * theme system already sets, so it follows a custom palette without wiring.
 */
import { ThinkingOrb } from "thinking-orbs";

import { cn } from "../../lib/utils";
import {
  chatOrbLabel,
  resolveChatOrbState,
  type ChatOrbInput,
  type ChatOrbState,
} from "./chatOrbState";

export interface ChatActivityOrbProps extends ChatOrbInput {
  /** 20 for inline use beside a control, 64 for a standalone slot. */
  readonly size?: 20 | 64;
  readonly className?: string;
}

/**
 * The composer's orb, above the stop button.
 *
 * Fixed to `solving` rather than tracking the live state: this slot answers
 * "the model has the floor", and the per-state detail belongs on the timeline
 * rows where the thing it describes is actually visible. Rendered only inside
 * the stop button's branch, so it appears exactly while a turn can be stopped.
 */
export function ComposerThinkingOrb() {
  return <ThinkingOrb state="solving" size={20} aria-label="Thinking" />;
}

export function ChatActivityOrb({ size = 20, className, ...activity }: ChatActivityOrbProps) {
  const state: ChatOrbState | null = resolveChatOrbState(activity);
  // An idle thread renders nothing rather than a paused orb: a frozen
  // indicator still reads as "something is happening".
  if (!state) return null;

  return (
    <ThinkingOrb
      state={state}
      size={size}
      aria-label={chatOrbLabel(state, activity.activeSubagentCount)}
      className={cn("shrink-0", className)}
    />
  );
}
