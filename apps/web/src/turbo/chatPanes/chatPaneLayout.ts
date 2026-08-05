import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { TurboChatPaneId } from "@t3tools/contracts/settings";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadRouteTarget } from "../../threadRoutes";

export const ChatPaneId = TurboChatPaneId;
export type ChatPaneId = typeof ChatPaneId.Type;

export interface ChatPane {
  readonly id: ChatPaneId;
  readonly target: ThreadRouteTarget;
}

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
