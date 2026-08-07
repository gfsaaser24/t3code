import type { ScopedProjectRef } from "@t3tools/contracts";

import type { ThreadRouteTarget } from "../../threadRoutes";
import {
  createChatPaneLayout,
  focus,
  insertLeft,
  insertRight,
  replaceFocused,
  type ChatPane,
  type ChatPaneId,
  type ChatPaneLayout,
} from "./chatPaneLayout";

export type NewChatPanePlacement = "replace" | "left" | "right";

export interface NewChatPaneSource {
  readonly target: ThreadRouteTarget | null;
  readonly projectRef: ScopedProjectRef | null;
}

export interface HomeNavigationSuppression {
  readonly pending: boolean;
  readonly skipReconciliation: boolean;
}

export function resolveHomeNavigationSuppression(
  pending: boolean,
  routeTarget: ThreadRouteTarget | null,
): HomeNavigationSuppression {
  return pending
    ? { pending: routeTarget !== null, skipReconciliation: true }
    : { pending: false, skipReconciliation: false };
}

export function resolveNewChatPaneSource(
  layout: ChatPaneLayout | null,
  sourcePaneId: ChatPaneId | null,
  resolveProjectRef: (target: ThreadRouteTarget) => ScopedProjectRef | null,
  fallbackProjectRef: ScopedProjectRef | null,
): NewChatPaneSource {
  const sourcePane =
    layout?.panes.find((pane) => pane.id === sourcePaneId) ??
    layout?.panes.find((pane) => pane.id === layout.focusedPaneId) ??
    null;
  const target = sourcePane?.target ?? null;
  return {
    target,
    projectRef: (target ? resolveProjectRef(target) : null) ?? fallbackProjectRef,
  };
}

export function applyNewChatPaneTarget(
  layout: ChatPaneLayout | null,
  sourcePaneId: ChatPaneId | null,
  pane: ChatPane,
  placement: NewChatPanePlacement,
): ChatPaneLayout {
  if (!layout) {
    return createChatPaneLayout(pane);
  }

  const sourceFocused = sourcePaneId ? focus(layout, sourcePaneId) : layout;
  switch (placement) {
    case "replace":
      return replaceFocused(sourceFocused, pane.target);
    case "left":
      return insertLeft(sourceFocused, pane);
    case "right":
      return insertRight(sourceFocused, pane);
  }
}

export function isServerPaneEnvironmentUnavailable(
  pane: ChatPane,
  catalogReady: boolean,
  knownEnvironmentIds: ReadonlySet<string>,
): boolean {
  return (
    catalogReady &&
    pane.target.kind === "server" &&
    !knownEnvironmentIds.has(pane.target.threadRef.environmentId)
  );
}
