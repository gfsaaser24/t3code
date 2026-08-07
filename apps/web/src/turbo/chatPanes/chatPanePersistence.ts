import type {
  TurboChatPaneLayout as PersistedChatPaneLayout,
  TurboChatPaneTarget as PersistedChatPaneTarget,
} from "@t3tools/contracts/settings";
import { TurboChatPaneDraftId, TurboChatPaneLayout } from "@t3tools/contracts/settings";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DraftId } from "../../composerDraftStore";
import type { ThreadRouteTarget } from "../../threadRoutes";
import { chatPaneWeight, ChatPaneId, type ChatPane, type ChatPaneLayout } from "./chatPaneLayout";

const decodePersistedChatPaneLayout = Schema.decodeUnknownOption(TurboChatPaneLayout);

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
 * Invalid or future persisted shapes fall back to the route-derived pane.
 * Valid layouts additionally repair cross-field invariants that a schema
 * cannot express: pane ids and targets are unique, and the focused pane is
 * present.
 */
export function restoreChatPaneLayout(persisted: unknown): ChatPaneLayout | null {
  const decoded = decodePersistedChatPaneLayout(persisted);
  if (Option.isNone(decoded)) {
    return null;
  }
  const layout = decoded.value;

  const paneIds = new Set<string>();
  const targetKeys = new Set<string>();
  const panes: ChatPane[] = [];
  for (const persistedPane of layout.panes) {
    const target = fromPersistedTarget(persistedPane.target);
    const key = targetKey(target);
    if (paneIds.has(persistedPane.id) || targetKeys.has(key)) {
      continue;
    }
    paneIds.add(persistedPane.id);
    targetKeys.add(key);
    panes.push({
      id: ChatPaneId.make(persistedPane.id),
      target,
      ...(persistedPane.weight === undefined ? {} : { weight: persistedPane.weight }),
    });
  }

  // Dropping duplicate panes can leave the surviving weights summing to
  // anything, so rescale them to average 1. Widths are relative either way;
  // this just keeps stored values in the band the schema accepts, so a
  // later partial write cannot compound into an extreme split.
  const normalized = normalizePaneWeights(panes);

  const firstPane = normalized[0];
  if (!firstPane) {
    return null;
  }
  const focusedPaneId = paneIds.has(layout.focusedPaneId)
    ? ChatPaneId.make(layout.focusedPaneId)
    : firstPane.id;

  return {
    version: 1,
    panes: [firstPane, ...normalized.slice(1)],
    focusedPaneId,
  };
}

function normalizePaneWeights(panes: ReadonlyArray<ChatPane>): ReadonlyArray<ChatPane> {
  if (panes.length === 0 || panes.every((pane) => pane.weight === undefined)) {
    return panes;
  }
  const total = panes.reduce((sum, pane) => sum + chatPaneWeight(pane), 0);
  if (total <= 0) {
    return panes.map(({ weight: _dropped, ...pane }) => pane);
  }
  const scale = panes.length / total;
  return panes.map((pane) => ({ ...pane, weight: chatPaneWeight(pane) * scale }));
}

export function persistChatPaneLayout(layout: ChatPaneLayout): PersistedChatPaneLayout {
  return {
    version: 1,
    panes: layout.panes.map((pane) => ({
      id: pane.id,
      target: toPersistedTarget(pane.target),
      // Equal shares stay unwritten so a single-pane layout round-trips to the
      // same shape it had before resizing existed.
      ...(pane.weight === undefined ? {} : { weight: pane.weight }),
    })),
    focusedPaneId: layout.focusedPaneId,
  };
}
