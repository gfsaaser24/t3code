import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  TurboChatPaneDraftId,
  TurboChatPaneId,
  type TurboChatPaneLayout,
} from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import { DraftId } from "../../composerDraftStore";
import { persistChatPaneLayout, restoreChatPaneLayout } from "./chatPanePersistence";

const paneId = (value: string) => TurboChatPaneId.make(value);

describe("chatPanePersistence", () => {
  it("round-trips server and draft targets", () => {
    const serverRef = scopeThreadRef(
      EnvironmentId.make("environment-a"),
      ThreadId.make("thread-a"),
    );
    const restored = restoreChatPaneLayout({
      version: 1,
      panes: [
        { id: paneId("pane-a"), target: { kind: "server", threadRef: serverRef } },
        {
          id: paneId("pane-b"),
          target: { kind: "draft", draftId: TurboChatPaneDraftId.make("draft-a") },
        },
      ],
      focusedPaneId: paneId("pane-b"),
    });

    expect(restored?.panes[1]?.target).toEqual({
      kind: "draft",
      draftId: DraftId.make("draft-a"),
    });
    expect(restored && persistChatPaneLayout(restored)).toEqual({
      version: 1,
      panes: [
        { id: paneId("pane-a"), target: { kind: "server", threadRef: serverRef } },
        {
          id: paneId("pane-b"),
          target: { kind: "draft", draftId: TurboChatPaneDraftId.make("draft-a") },
        },
      ],
      focusedPaneId: paneId("pane-b"),
    });
  });

  it("repairs duplicate panes and a missing focused pane", () => {
    const persisted = {
      version: 1,
      panes: [
        {
          id: paneId("pane-a"),
          target: { kind: "draft", draftId: TurboChatPaneDraftId.make("draft-a") },
        },
        {
          id: paneId("pane-a"),
          target: { kind: "draft", draftId: TurboChatPaneDraftId.make("draft-b") },
        },
        {
          id: paneId("pane-c"),
          target: { kind: "draft", draftId: TurboChatPaneDraftId.make("draft-a") },
        },
      ],
      focusedPaneId: paneId("missing"),
    } satisfies TurboChatPaneLayout;

    expect(restoreChatPaneLayout(persisted)).toEqual({
      version: 1,
      panes: [
        {
          id: paneId("pane-a"),
          target: { kind: "draft", draftId: DraftId.make("draft-a") },
        },
      ],
      focusedPaneId: paneId("pane-a"),
    });
  });
});
