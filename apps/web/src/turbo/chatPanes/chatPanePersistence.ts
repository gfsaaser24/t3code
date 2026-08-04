import type {
  TurboChatPaneLayout as PersistedChatPaneLayout,
  TurboChatPaneTarget as PersistedChatPaneTarget,
} from "@t3tools/contracts/settings";
import { TurboChatPaneDraftId } from "@t3tools/contracts/settings";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { DraftId } from "../../composerDraftStore";
import type { ThreadRouteTarget } from "../../threadRoutes";
import { ChatPaneId, type ChatPane, type ChatPaneLayout } from "./chatPaneLayout";

function targetKey(target: ThreadRouteTarget): string {
  return target.kind === "server"
    ? `server:${scopedThreadKey(target.threadRef)}`
    : `draft:${target.draftId}`;
}

function fromPersistedTarget(target: PersistedChatPaneTarget): ThreadRouteTarget {
  return target.kind === "server"
    ? target
    : { kind: "draft", draftId: DraftId.make(target.draftId) };
}

function toPersistedTarget(target: ThreadRouteTarget): PersistedChatPaneTarget {
  return target.kind === "server"
    ? target
    : { kind: "draft", draftId: TurboChatPaneDraftId.make(target.draftId) };
}

/**
 * Client settings validates field shapes. This boundary additionally repairs
 * cross-field invariants that a schema cannot express: pane ids and targets
 * are unique, and the focused pane is present.
 */
export function restoreChatPaneLayout(
  persisted: PersistedChatPaneLayout | null,
): ChatPaneLayout | null {
  if (!persisted) {
    return null;
  }

  const paneIds = new Set<string>();
  const targetKeys = new Set<string>();
  const panes: ChatPane[] = [];
  for (const persistedPane of persisted.panes) {
    const target = fromPersistedTarget(persistedPane.target);
    const key = targetKey(target);
    if (paneIds.has(persistedPane.id) || targetKeys.has(key)) {
      continue;
    }
    paneIds.add(persistedPane.id);
    targetKeys.add(key);
    panes.push({ id: ChatPaneId.make(persistedPane.id), target });
  }

  const firstPane = panes[0];
  if (!firstPane) {
    return null;
  }
  const focusedPaneId = paneIds.has(persisted.focusedPaneId)
    ? ChatPaneId.make(persisted.focusedPaneId)
    : firstPane.id;

  return {
    version: 1,
    panes: [firstPane, ...panes.slice(1)],
    focusedPaneId,
  };
}

export function persistChatPaneLayout(layout: ChatPaneLayout): PersistedChatPaneLayout {
  return {
    version: 1,
    panes: layout.panes.map((pane) => ({
      id: pane.id,
      target: toPersistedTarget(pane.target),
    })),
    focusedPaneId: layout.focusedPaneId,
  };
}
