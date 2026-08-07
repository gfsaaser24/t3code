import {
  ChevronDownIcon,
  PanelLeftOpenIcon,
  PanelRightOpenIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";

import { Button } from "~/components/ui/button";
import { Group, GroupSeparator } from "~/components/ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  type ChatPaneSide,
  useChatPaneActions,
  useCurrentChatPaneId,
} from "./ChatPaneActionsContext";

export function ChatPaneControl() {
  const { closePane, focusedPaneId, layout, openNewChat, replaceWithNewChat } =
    useChatPaneActions();
  const currentPaneId = useCurrentChatPaneId() ?? focusedPaneId;
  const canClose = currentPaneId !== null && (layout?.panes.length ?? 0) > 1;
  const open = (side: ChatPaneSide) => void openNewChat(currentPaneId, side);

  return (
    <Group aria-label="Chat panes" data-chat-pane-control>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="w-7 px-0 sm:w-6 @3xl/header-actions:w-auto! @3xl/header-actions:px-[calc(--spacing(2)-1px)]"
              aria-label="Start a new chat"
              // The tooltip wrapper replaces data-slot="button", so themed
              // toolbar styling needs its own hook.
              data-toolbar-control=""
              onClick={() => void replaceWithNewChat(currentPaneId)}
            />
          }
        >
          <PlusIcon aria-hidden className="size-3.5" />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            New chat
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">Start a new chat</TooltipPopup>
      </Tooltip>
      <GroupSeparator />
      <Menu>
        <MenuTrigger
          render={
            <Button type="button" size="icon-xs" variant="outline" aria-label="Chat pane actions" />
          }
        >
          <ChevronDownIcon aria-hidden className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => open("right")}>
            <PanelRightOpenIcon aria-hidden />
            Open new chat to the right
          </MenuItem>
          <MenuItem onClick={() => open("left")}>
            <PanelLeftOpenIcon aria-hidden />
            Open new chat to the left
          </MenuItem>
        </MenuPopup>
      </Menu>
      {canClose ? (
        <>
          <GroupSeparator />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="outline"
                  aria-label="Close this chat pane"
                  // The tooltip wrapper replaces data-slot="button", so themed
                  // toolbar styling needs its own hook.
                  data-toolbar-control=""
                  onClick={() => currentPaneId && closePane(currentPaneId)}
                />
              }
            >
              <XIcon aria-hidden className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">Close this chat pane</TooltipPopup>
          </Tooltip>
        </>
      ) : null}
    </Group>
  );
}
