import type { ChatPaneId } from "./chatPaneLayout";

export function isChatPaneFocused(
  paneId: ChatPaneId | null,
  focusedPaneId: ChatPaneId | null,
): boolean {
  return paneId !== null && paneId === focusedPaneId;
}

export function chatPaneChromeOwnership(index: number, paneCount: number) {
  return {
    reserveSidebarControlInset: index === 0,
    reserveTitleBarControlInset: index === paneCount - 1,
  } as const;
}

export function shouldUseChatPaneRightPanelSheet(paneCount: number): boolean {
  return paneCount > 1;
}

export function selectPaneTerminalMountKeys(input: {
  readonly multiPane: boolean;
  readonly activeThreadKey: string | null;
  readonly existingOpenThreadKeys: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  if (!input.multiPane) return input.existingOpenThreadKeys;
  return input.activeThreadKey && input.existingOpenThreadKeys.includes(input.activeThreadKey)
    ? [input.activeThreadKey]
    : [];
}
