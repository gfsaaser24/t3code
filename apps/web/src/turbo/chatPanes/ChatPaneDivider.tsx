/**
 * Draggable divider between two chat panes.
 *
 * The drag writes `flex-grow` straight onto the two neighbouring pane elements
 * and only commits the result to client settings on release. Pane sizes live in
 * persisted settings, so committing per pointer event would put a settings
 * write on the wire for every frame of the drag.
 */
import { useCallback, useRef } from "react";

import { cn } from "../../lib/utils";
import { useChatPaneActions } from "./ChatPaneActionsContext";

/**
 * Below this a pane cannot show its header controls or composer without the
 * chrome colliding, so the drag stops here rather than letting a pane be
 * squeezed into an unusable sliver.
 */
export const MIN_CHAT_PANE_WIDTH = 360;

/** Keyboard nudge per arrow press. */
const KEYBOARD_STEP = 24;

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly leftStart: number;
  readonly rightStart: number;
  readonly left: HTMLElement;
  readonly right: HTMLElement;
  readonly pairWeight: number;
  leftWidth: number;
  rightWidth: number;
  rafId: number | null;
}

function paneElements(handle: HTMLElement): { left: HTMLElement; right: HTMLElement } | null {
  const left = handle.previousElementSibling;
  const right = handle.nextElementSibling;
  if (!(left instanceof HTMLElement) || !(right instanceof HTMLElement)) return null;
  return { left, right };
}

/** Splits `total` between the pair while honouring the minimum on both sides. */
export function clampPaneWidths(
  desiredLeft: number,
  total: number,
  minWidth: number = MIN_CHAT_PANE_WIDTH,
): { left: number; right: number } {
  // A row too narrow to give both panes the minimum splits evenly instead of
  // pinning one pane open and collapsing the other to nothing.
  if (total < minWidth * 2) {
    const half = total / 2;
    return { left: half, right: half };
  }
  const left = Math.min(Math.max(desiredLeft, minWidth), total - minWidth);
  return { left, right: total - left };
}

export function ChatPaneDivider({
  boundaryIndex,
  leftPaneLabel,
  rightPaneLabel,
}: {
  readonly boundaryIndex: number;
  readonly leftPaneLabel: string;
  readonly rightPaneLabel: string;
}) {
  const { resizeBoundary, resetPaneSizes } = useChatPaneActions();
  const dragRef = useRef<DragState | null>(null);

  const applyWidths = useCallback((state: DragState) => {
    const total = state.leftWidth + state.rightWidth;
    if (total <= 0) return;
    // Grow factors, not pixel widths: the row still has to survive the window
    // being resized mid-drag.
    state.left.style.flexGrow = `${(state.pairWeight * state.leftWidth) / total}`;
    state.right.style.flexGrow = `${(state.pairWeight * state.rightWidth) / total}`;
  }, []);

  const stopDrag = useCallback(
    (handle: HTMLElement, commit: boolean) => {
      const state = dragRef.current;
      if (!state) return;
      dragRef.current = null;

      if (state.rafId !== null) window.cancelAnimationFrame(state.rafId);
      if (handle.hasPointerCapture(state.pointerId)) {
        handle.releasePointerCapture(state.pointerId);
      }
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");

      // The inline grow factors were a live preview. Hand the widths to the
      // layout and let the committed weights re-render them, so the DOM never
      // disagrees with persisted state.
      state.left.style.removeProperty("flex-grow");
      state.right.style.removeProperty("flex-grow");

      if (commit) resizeBoundary(boundaryIndex, state.leftWidth, state.rightWidth);
    },
    [boundaryIndex, resizeBoundary],
  );

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const handle = event.currentTarget;
    const panes = paneElements(handle);
    if (!panes) return;

    const leftStart = panes.left.getBoundingClientRect().width;
    const rightStart = panes.right.getBoundingClientRect().width;
    const pairWeight =
      (Number.parseFloat(window.getComputedStyle(panes.left).flexGrow) || 1) +
      (Number.parseFloat(window.getComputedStyle(panes.right).flexGrow) || 1);

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      leftStart,
      rightStart,
      left: panes.left,
      right: panes.right,
      pairWeight,
      leftWidth: leftStart,
      rightWidth: rightStart,
      rafId: null,
    };

    handle.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    // Without this a drag past the handle selects the transcript underneath.
    document.body.style.userSelect = "none";
    event.preventDefault();
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = dragRef.current;
      if (!state || state.pointerId !== event.pointerId) return;

      const total = state.leftStart + state.rightStart;
      const next = clampPaneWidths(state.leftStart + (event.clientX - state.startX), total);
      state.leftWidth = next.left;
      state.rightWidth = next.right;

      // Coalesce to one style write per frame; pointermove outruns paint.
      if (state.rafId === null) {
        state.rafId = window.requestAnimationFrame(() => {
          state.rafId = null;
          if (dragRef.current === state) applyWidths(state);
        });
      }
    },
    [applyWidths],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      stopDrag(event.currentTarget, true);
    },
    [stopDrag],
  );

  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      stopDrag(event.currentTarget, false);
    },
    [stopDrag],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === "Home") {
        event.preventDefault();
        resetPaneSizes();
        return;
      }
      const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (direction === 0) return;

      const panes = paneElements(event.currentTarget);
      if (!panes) return;
      event.preventDefault();

      const leftStart = panes.left.getBoundingClientRect().width;
      const rightStart = panes.right.getBoundingClientRect().width;
      const next = clampPaneWidths(leftStart + direction * KEYBOARD_STEP, leftStart + rightStart);
      resizeBoundary(boundaryIndex, next.left, next.right);
    },
    [boundaryIndex, resetPaneSizes, resizeBoundary],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${leftPaneLabel} and ${rightPaneLabel}`}
      tabIndex={0}
      data-chat-pane-divider=""
      // The hit area is wider than the visible hairline so the divider is
      // grabbable without making the seam itself look heavy.
      className={cn(
        "group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none select-none",
        "focus-visible:outline-none",
      )}
      onDoubleClick={resetPaneSizes}
      onKeyDown={onKeyDown}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/70",
          "transition-colors duration-150 motion-reduce:transition-none",
          "group-hover:bg-accent group-focus-visible:bg-accent",
        )}
      />
    </div>
  );
}
