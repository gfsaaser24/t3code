import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { TurboChatPaneId } from "@t3tools/contracts/settings";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadRouteTarget } from "../../threadRoutes";

export const ChatPaneId = TurboChatPaneId;
export type ChatPaneId = typeof ChatPaneId.Type;

export interface ChatPane {
  readonly id: ChatPaneId;
  readonly target: ThreadRouteTarget;
  /**
   * Flex grow weight relative to sibling panes. Absent means "equal share",
   * which is what every pane starts as and what closing back to one pane
   * returns to.
   */
  readonly weight?: number;
}

/** Weights are only meaningful relative to each other, so the row is kept normalized to this. */
const DEFAULT_PANE_WEIGHT = 1;

export interface ChatPaneLayout {
  readonly version: 1;
  readonly panes: readonly [ChatPane, ...ChatPane[]];
  readonly focusedPaneId: ChatPaneId;
}

export function createChatPaneLayout(pane: ChatPane): ChatPaneLayout {
  return {
    version: 1,
    panes: [pane],
    focusedPaneId: pane.id,
  };
}

function targetKey(target: ThreadRouteTarget): string {
  return target.kind === "server"
    ? `server:${scopedThreadKey(target.threadRef)}`
    : `draft:${target.draftId}`;
}

function findTargetIndex(layout: ChatPaneLayout, target: ThreadRouteTarget): number {
  const key = targetKey(target);
  return layout.panes.findIndex((pane) => targetKey(pane.target) === key);
}

function findPaneIndex(layout: ChatPaneLayout, paneId: ChatPaneId): number {
  return layout.panes.findIndex((pane) => pane.id === paneId);
}

function withFocusedIndex(layout: ChatPaneLayout, paneIndex: number): ChatPaneLayout {
  const pane = layout.panes[paneIndex];
  if (!pane || pane.id === layout.focusedPaneId) {
    return layout;
  }
  return { ...layout, focusedPaneId: pane.id };
}

export function replaceFocused(layout: ChatPaneLayout, target: ThreadRouteTarget): ChatPaneLayout {
  const existingIndex = findTargetIndex(layout, target);
  if (existingIndex !== -1) {
    return withFocusedIndex(layout, existingIndex);
  }

  const focusedIndex = findPaneIndex(layout, layout.focusedPaneId);
  if (focusedIndex === -1) {
    return layout;
  }

  const panes = layout.panes.map((pane, index) =>
    index === focusedIndex ? { ...pane, target } : pane,
  ) as [ChatPane, ...ChatPane[]];
  return { ...layout, panes };
}

function insertBeside(
  layout: ChatPaneLayout,
  pane: ChatPane,
  offsetFromFocused: 0 | 1,
): ChatPaneLayout {
  const existingTargetIndex = findTargetIndex(layout, pane.target);
  if (existingTargetIndex !== -1) {
    return withFocusedIndex(layout, existingTargetIndex);
  }

  const existingIdIndex = findPaneIndex(layout, pane.id);
  if (existingIdIndex !== -1) {
    return withFocusedIndex(layout, existingIdIndex);
  }

  const focusedIndex = findPaneIndex(layout, layout.focusedPaneId);
  if (focusedIndex === -1) {
    return layout;
  }

  const panes = [...layout.panes];
  panes.splice(focusedIndex + offsetFromFocused, 0, pane);
  return {
    ...layout,
    panes: panes as [ChatPane, ...ChatPane[]],
    focusedPaneId: pane.id,
  };
}

export function insertLeft(layout: ChatPaneLayout, pane: ChatPane): ChatPaneLayout {
  return insertBeside(layout, pane, 0);
}

export function insertRight(layout: ChatPaneLayout, pane: ChatPane): ChatPaneLayout {
  return insertBeside(layout, pane, 1);
}

export function focus(layout: ChatPaneLayout, paneId: ChatPaneId): ChatPaneLayout {
  return withFocusedIndex(layout, findPaneIndex(layout, paneId));
}

export function close(layout: ChatPaneLayout, paneId: ChatPaneId): ChatPaneLayout {
  if (layout.panes.length === 1) {
    return layout;
  }

  const paneIndex = findPaneIndex(layout, paneId);
  if (paneIndex === -1) {
    return layout;
  }

  const nextFocusedPaneId =
    paneId === layout.focusedPaneId
      ? (layout.panes[paneIndex + 1] ?? layout.panes[paneIndex - 1])?.id
      : layout.focusedPaneId;
  if (!nextFocusedPaneId) {
    return layout;
  }

  const panes = layout.panes.filter((pane) => pane.id !== paneId) as [ChatPane, ...ChatPane[]];
  return { ...layout, panes, focusedPaneId: nextFocusedPaneId };
}

export function promoteDraft(
  layout: ChatPaneLayout,
  paneId: ChatPaneId,
  threadRef: ScopedThreadRef,
): ChatPaneLayout {
  const paneIndex = findPaneIndex(layout, paneId);
  const pane = layout.panes[paneIndex];
  if (!pane || pane.target.kind !== "draft") {
    return layout;
  }

  const target = { kind: "server", threadRef } as const satisfies ThreadRouteTarget;
  const existingTargetIndex = findTargetIndex(layout, target);
  if (existingTargetIndex !== -1) {
    const existingPane = layout.panes[existingTargetIndex];
    if (!existingPane) {
      return layout;
    }
    const panes = layout.panes.filter((candidate) => candidate.id !== paneId) as [
      ChatPane,
      ...ChatPane[],
    ];
    return { ...layout, panes, focusedPaneId: existingPane.id };
  }

  const panes = layout.panes.map((candidate, index) =>
    index === paneIndex ? { ...candidate, target } : candidate,
  ) as [ChatPane, ...ChatPane[]];
  return { ...layout, panes };
}

export function reconcileFocusedRoute(
  layout: ChatPaneLayout,
  target: ThreadRouteTarget,
): ChatPaneLayout {
  return replaceFocused(layout, target);
}

/** A stored weight is only trusted when it is a usable positive number. */
export function chatPaneWeight(pane: ChatPane): number {
  const { weight } = pane;
  return typeof weight === "number" && Number.isFinite(weight) && weight > 0
    ? weight
    : DEFAULT_PANE_WEIGHT;
}

/**
 * Re-weights the two panes on either side of a divider to the requested pixel
 * widths.
 *
 * Their combined weight is preserved, so dragging one divider cannot move the
 * panes beyond it — otherwise a drag in a three-pane row would visibly shove
 * the far pane around. Callers clamp the widths to a minimum first; this is
 * only the conversion from pixels back to relative weights.
 */
export function resizeChatPaneBoundary(
  layout: ChatPaneLayout,
  boundaryIndex: number,
  leftWidth: number,
  rightWidth: number,
): ChatPaneLayout {
  const left = layout.panes[boundaryIndex];
  const right = layout.panes[boundaryIndex + 1];
  if (!left || !right) return layout;

  const total = leftWidth + rightWidth;
  if (!Number.isFinite(total) || total <= 0 || leftWidth <= 0 || rightWidth <= 0) {
    return layout;
  }

  const pairWeight = chatPaneWeight(left) + chatPaneWeight(right);
  const nextLeftWeight = (pairWeight * leftWidth) / total;
  const nextRightWeight = pairWeight - nextLeftWeight;

  const panes = layout.panes.map((pane, index) => {
    if (index === boundaryIndex) return { ...pane, weight: nextLeftWeight };
    if (index === boundaryIndex + 1) return { ...pane, weight: nextRightWeight };
    return pane;
  }) as [ChatPane, ...ChatPane[]];

  return { ...layout, panes };
}

/** Drops every stored weight, returning the row to equal shares. */
export function resetChatPaneWeights(layout: ChatPaneLayout): ChatPaneLayout {
  if (layout.panes.every((pane) => pane.weight === undefined)) return layout;
  const panes = layout.panes.map(({ weight: _dropped, ...pane }) => pane) as [
    ChatPane,
    ...ChatPane[],
  ];
  return { ...layout, panes };
}
