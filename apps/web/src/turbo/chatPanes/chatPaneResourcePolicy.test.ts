import { describe, expect, it } from "@effect/vitest";

import { ChatPaneId } from "./chatPaneLayout";
import {
  chatPaneChromeOwnership,
  isChatPaneFocused,
  selectPaneTerminalMountKeys,
  shouldUseChatPaneRightPanelSheet,
} from "./chatPaneResourcePolicy";

describe("chat pane resource policy", () => {
  it("grants global resource ownership only to the focused pane", () => {
    const first = ChatPaneId.make("first");
    const second = ChatPaneId.make("second");

    expect(isChatPaneFocused(first, second)).toBe(false);
    expect(isChatPaneFocused(second, second)).toBe(true);
    expect(isChatPaneFocused(null, second)).toBe(false);
  });

  it("assigns sidebar and native titlebar insets to opposite outside edges", () => {
    expect(chatPaneChromeOwnership(0, 3)).toEqual({
      reserveSidebarControlInset: true,
      reserveTitleBarControlInset: false,
    });
    expect(chatPaneChromeOwnership(2, 3)).toEqual({
      reserveSidebarControlInset: false,
      reserveTitleBarControlInset: true,
    });
    expect(shouldUseChatPaneRightPanelSheet(1)).toBe(false);
    expect(shouldUseChatPaneRightPanelSheet(3)).toBe(true);
  });

  it("keeps one terminal host per pane target in multi-pane mode", () => {
    expect(
      selectPaneTerminalMountKeys({
        multiPane: true,
        activeThreadKey: "environment:thread-b",
        existingOpenThreadKeys: ["environment:thread-a", "environment:thread-b"],
      }),
    ).toEqual(["environment:thread-b"]);
    expect(
      selectPaneTerminalMountKeys({
        multiPane: false,
        activeThreadKey: "environment:thread-b",
        existingOpenThreadKeys: ["environment:thread-a", "environment:thread-b"],
      }),
    ).toEqual(["environment:thread-a", "environment:thread-b"]);
  });
});
