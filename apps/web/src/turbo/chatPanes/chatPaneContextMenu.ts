import type { ContextMenuItem } from "@t3tools/contracts";
import type { ChatPaneSide } from "./ChatPaneActionsContext";

export type ChatPaneContextMenuAction = `open-chat-pane-${ChatPaneSide}`;

const CHAT_PANE_CONTEXT_MENU_ITEMS = [
  { id: "open-chat-pane-right", label: "Open in new split pane to the right" },
  { id: "open-chat-pane-left", label: "Open in new split pane to the left" },
] as const satisfies readonly ContextMenuItem<ChatPaneContextMenuAction>[];

export function buildChatPaneContextMenuItems(): readonly ContextMenuItem<ChatPaneContextMenuAction>[] {
  return CHAT_PANE_CONTEXT_MENU_ITEMS;
}

export function resolveChatPaneSide(action: string | null | undefined): ChatPaneSide | null {
  if (action === "open-chat-pane-left") return "left";
  if (action === "open-chat-pane-right") return "right";
  return null;
}
