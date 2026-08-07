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
