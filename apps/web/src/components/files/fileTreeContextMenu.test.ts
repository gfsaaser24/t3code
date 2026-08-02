import { describe, expect, it } from "@effect/vitest";

import { fileTreeContextMenuItems } from "./fileTreeContextMenu.ts";

describe("file tree context menu", () => {
  it("adds file navigation and mutation actions before mention actions", () => {
    expect(fileTreeContextMenuItems("file", false)).toEqual([
      { id: "open-new-tab", label: "Open in new tab" },
      { id: "rename", label: "Rename", disabled: false },
      { id: "duplicate", label: "Duplicate", disabled: false },
      { id: "delete", label: "Delete...", destructive: true, disabled: false },
      { id: "copy-mention", label: "Copy mention" },
      { id: "add-to-chat", label: "Add to chat" },
    ]);
  });

  it("disables disk mutations while an editor save is pending", () => {
    const items = fileTreeContextMenuItems("file", true);

    expect(items.find((item) => item.id === "open-new-tab")?.disabled).toBeUndefined();
    expect(items.find((item) => item.id === "rename")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "duplicate")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "delete")?.disabled).toBe(true);
  });

  it("keeps directory menus limited to the existing mention actions", () => {
    expect(fileTreeContextMenuItems("directory", false).map((item) => item.id)).toEqual([
      "copy-mention",
      "add-to-chat",
    ]);
  });
});
