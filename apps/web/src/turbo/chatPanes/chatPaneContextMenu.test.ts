import { describe, expect, it } from "vite-plus/test";

import { buildChatPaneContextMenuItems, resolveChatPaneSide } from "./chatPaneContextMenu";

describe("chat pane context menu", () => {
  it("offers the right and left split actions", () => {
    expect(buildChatPaneContextMenuItems()).toEqual([
      { id: "open-chat-pane-right", label: "Open in new split pane to the right" },
      { id: "open-chat-pane-left", label: "Open in new split pane to the left" },
    ]);
  });

  it.each([
    ["open-chat-pane-left", "left"],
    ["open-chat-pane-right", "right"],
    ["rename", null],
    [null, null],
  ] as const)("resolves %s to %s", (action, expected) => {
    expect(resolveChatPaneSide(action)).toBe(expected);
  });
});
