import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { DraftId } from "../../composerDraftStore";
import type { ThreadRouteTarget } from "../../threadRoutes";
import {
  ChatPaneId,
  close,
  createChatPaneLayout,
  focus,
  insertLeft,
  insertRight,
  promoteDraft,
  reconcileFocusedRoute,
  replaceFocused,
  type ChatPane,
  type ChatPaneLayout,
} from "./chatPaneLayout";

const paneId = (value: string) => ChatPaneId.make(value);
const draftTarget = (value: string): ThreadRouteTarget => ({
  kind: "draft",
  draftId: DraftId.make(value),
});
const serverRef = (value: string) =>
  scopeThreadRef(EnvironmentId.make("environment-a"), ThreadId.make(value));
const serverTarget = (value: string): ThreadRouteTarget => ({
  kind: "server",
  threadRef: serverRef(value),
});
const pane = (id: string, target: ThreadRouteTarget): ChatPane => ({ id: paneId(id), target });
const layout = (...panes: readonly [ChatPane, ...ChatPane[]]): ChatPaneLayout => ({
  version: 1,
  panes,
  focusedPaneId: panes[0].id,
});

describe("chatPaneLayout", () => {
  it("creates a one-pane focused layout", () => {
    const initialPane = pane("pane-a", draftTarget("draft-a"));

    expect(createChatPaneLayout(initialPane)).toEqual({
      version: 1,
      panes: [initialPane],
      focusedPaneId: initialPane.id,
    });
  });

  it("replaces only the focused pane", () => {
    const first = pane("pane-a", draftTarget("draft-a"));
    const second = pane("pane-b", draftTarget("draft-b"));
    const current = focus(layout(first, second), second.id);
    const target = serverTarget("thread-c");

    const next = replaceFocused(current, target);

    expect(next.panes).toEqual([first, { ...second, target }]);
    expect(next.focusedPaneId).toBe(second.id);
  });

  it("focuses an existing target instead of duplicating it", () => {
    const first = pane("pane-a", serverTarget("thread-a"));
    const second = pane("pane-b", draftTarget("draft-b"));
    const current = focus(layout(first, second), second.id);

    const next = replaceFocused(current, serverTarget("thread-a"));

    expect(next.panes).toEqual([first, second]);
    expect(next.focusedPaneId).toBe(first.id);
  });

  it("inserts panes immediately left and right of the focused pane", () => {
    const first = pane("pane-a", draftTarget("draft-a"));
    const second = pane("pane-b", draftTarget("draft-b"));
    const left = pane("pane-left", serverTarget("thread-left"));
    const right = pane("pane-right", serverTarget("thread-right"));
    const current = focus(layout(first, second), second.id);

    const withLeft = insertLeft(current, left);
    expect(withLeft.panes).toEqual([first, left, second]);
    expect(withLeft.focusedPaneId).toBe(left.id);

    const withRight = insertRight(focus(withLeft, second.id), right);
    expect(withRight.panes).toEqual([first, left, second, right]);
    expect(withRight.focusedPaneId).toBe(right.id);
  });

  it("deduplicates inserts by canonical target and pane ID", () => {
    const first = pane("pane-a", serverTarget("thread-a"));
    const second = pane("pane-b", draftTarget("draft-b"));
    const current = focus(layout(first, second), second.id);

    const byTarget = insertRight(current, pane("pane-c", serverTarget("thread-a")));
    expect(byTarget.panes).toEqual([first, second]);
    expect(byTarget.focusedPaneId).toBe(first.id);

    const byId = insertRight(current, pane("pane-a", draftTarget("draft-c")));
    expect(byId.panes).toEqual([first, second]);
    expect(byId.focusedPaneId).toBe(first.id);
  });

  it("focuses only panes that exist", () => {
    const first = pane("pane-a", draftTarget("draft-a"));
    const second = pane("pane-b", draftTarget("draft-b"));
    const current = layout(first, second);

    expect(focus(current, second.id).focusedPaneId).toBe(second.id);
    expect(focus(current, paneId("missing"))).toBe(current);
  });

  it("closes the focused pane toward the right, then toward the left", () => {
    const first = pane("pane-a", draftTarget("draft-a"));
    const second = pane("pane-b", draftTarget("draft-b"));
    const third = pane("pane-c", draftTarget("draft-c"));

    const closedMiddle = close(focus(layout(first, second, third), second.id), second.id);
    expect(closedMiddle.panes).toEqual([first, third]);
    expect(closedMiddle.focusedPaneId).toBe(third.id);

    const closedRight = close(closedMiddle, third.id);
    expect(closedRight.panes).toEqual([first]);
    expect(closedRight.focusedPaneId).toBe(first.id);
  });

  it("preserves focus when closing another pane and protects the last pane", () => {
    const first = pane("pane-a", draftTarget("draft-a"));
    const second = pane("pane-b", draftTarget("draft-b"));
    const current = layout(first, second);

    const closed = close(current, second.id);
    expect(closed.panes).toEqual([first]);
    expect(closed.focusedPaneId).toBe(first.id);
    expect(close(closed, first.id)).toBe(closed);
    expect(close(current, paneId("missing"))).toBe(current);
  });

  it("promotes a draft target in place", () => {
    const first = pane("pane-a", draftTarget("draft-a"));
    const second = pane("pane-b", draftTarget("draft-b"));
    const current = layout(first, second);
    const threadRef = serverRef("thread-a");

    const next = promoteDraft(current, first.id, threadRef);

    expect(next.panes).toEqual([{ ...first, target: { kind: "server", threadRef } }, second]);
    expect(next.focusedPaneId).toBe(first.id);
  });

  it("removes a promoted draft when its server target is already open", () => {
    const server = pane("pane-server", serverTarget("thread-a"));
    const draft = pane("pane-draft", draftTarget("draft-a"));
    const current = focus(layout(server, draft), draft.id);
    const threadRef = serverRef("thread-a");

    const next = promoteDraft(current, draft.id, threadRef);

    expect(next.panes).toEqual([server]);
    expect(next.focusedPaneId).toBe(server.id);
  });

  it("ignores promotion for a missing or non-draft pane", () => {
    const server = pane("pane-server", serverTarget("thread-a"));
    const current = createChatPaneLayout(server);
    const threadRef = server.target.kind === "server" ? server.target.threadRef : null;
    if (!threadRef) {
      throw new Error("expected a server target");
    }

    expect(promoteDraft(current, server.id, threadRef)).toBe(current);
    expect(promoteDraft(current, paneId("missing"), threadRef)).toBe(current);
  });

  it("reconciles the route into only the focused pane and focuses a duplicate target", () => {
    const first = pane("pane-a", serverTarget("thread-a"));
    const second = pane("pane-b", draftTarget("draft-b"));
    const current = focus(layout(first, second), second.id);

    const replaced = reconcileFocusedRoute(current, serverTarget("thread-c"));
    expect(replaced.panes).toEqual([first, { ...second, target: serverTarget("thread-c") }]);

    const deduplicated = reconcileFocusedRoute(current, serverTarget("thread-a"));
    expect(deduplicated.panes).toEqual([first, second]);
    expect(deduplicated.focusedPaneId).toBe(first.id);
  });
});
