import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "../../composerDraftStore";
import type { ThreadRouteTarget } from "../../threadRoutes";
import {
  applyNewChatPaneTarget,
  isServerPaneEnvironmentUnavailable,
  resolveHomeNavigationSuppression,
  resolveNewChatPaneSource,
} from "./chatPaneActions.logic";
import { ChatPaneId, type ChatPane, type ChatPaneLayout } from "./chatPaneLayout";

const environmentId = EnvironmentId.make("environment-a");
const paneId = (value: string) => ChatPaneId.make(value);
const draftTarget = (value: string): ThreadRouteTarget => ({
  kind: "draft",
  draftId: DraftId.make(value),
});
const serverTarget = (value: string, environment = environmentId): ThreadRouteTarget => ({
  kind: "server",
  threadRef: scopeThreadRef(environment, ThreadId.make(value)),
});
const pane = (id: string, target: ThreadRouteTarget): ChatPane => ({ id: paneId(id), target });

describe("chat pane actions", () => {
  it("uses the explicit source pane for project context and split placement", () => {
    const first = pane("pane-a", serverTarget("thread-a"));
    const second = pane("pane-b", serverTarget("thread-b"));
    const layout: ChatPaneLayout = {
      version: 1,
      panes: [first, second],
      focusedPaneId: first.id,
    };
    const sourceProjectRef = scopeProjectRef(environmentId, ProjectId.make("project-b"));

    const source = resolveNewChatPaneSource(
      layout,
      second.id,
      (target) => (target === second.target ? sourceProjectRef : null),
      null,
    );
    const nextPane = pane("pane-c", draftTarget("draft-c"));
    const next = applyNewChatPaneTarget(layout, second.id, nextPane, "right");

    expect(source).toEqual({ target: second.target, projectRef: sourceProjectRef });
    expect(next.panes).toEqual([first, second, nextPane]);
    expect(next.focusedPaneId).toBe(nextPane.id);
  });

  it("replaces the requested pane even when the route-focused pane is different", () => {
    const first = pane("pane-a", serverTarget("thread-a"));
    const second = pane("pane-b", serverTarget("thread-b"));
    const layout: ChatPaneLayout = {
      version: 1,
      panes: [first, second],
      focusedPaneId: first.id,
    };
    const target = draftTarget("draft-c");

    const next = applyNewChatPaneTarget(layout, second.id, pane("unused-id", target), "replace");

    expect(next.panes).toEqual([first, { ...second, target }]);
    expect(next.focusedPaneId).toBe(second.id);
  });

  it("holds route reconciliation until an intentional home navigation lands", () => {
    const oldRoute = serverTarget("thread-a");

    expect(resolveHomeNavigationSuppression(true, oldRoute)).toEqual({
      pending: true,
      skipReconciliation: true,
    });
    expect(resolveHomeNavigationSuppression(true, null)).toEqual({
      pending: false,
      skipReconciliation: true,
    });
    expect(resolveHomeNavigationSuppression(false, oldRoute)).toEqual({
      pending: false,
      skipReconciliation: false,
    });
  });

  it("marks only removed server environments unavailable after catalog hydration", () => {
    const removedEnvironment = EnvironmentId.make("removed");
    const serverPane = pane("pane-a", serverTarget("thread-a", removedEnvironment));
    const draftPane = pane("pane-b", draftTarget("draft-b"));
    const knownEnvironmentIds = new Set<string>([environmentId]);

    expect(isServerPaneEnvironmentUnavailable(serverPane, false, knownEnvironmentIds)).toBe(false);
    expect(isServerPaneEnvironmentUnavailable(serverPane, true, knownEnvironmentIds)).toBe(true);
    expect(isServerPaneEnvironmentUnavailable(draftPane, true, knownEnvironmentIds)).toBe(false);
  });
});
