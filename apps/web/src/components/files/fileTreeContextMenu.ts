import type { ContextMenuItem } from "@t3tools/contracts";

export type FileTreeContextMenuAction =
  | "open-new-tab"
  | "rename"
  | "duplicate"
  | "delete"
  | "copy-mention"
  | "add-to-chat";

export function fileTreeContextMenuItems(
  kind: "directory" | "file",
  mutationPending: boolean,
): readonly ContextMenuItem<FileTreeContextMenuAction>[] {
  return [
    ...(kind === "file"
      ? [
          { id: "open-new-tab" as const, label: "Open in new tab" },
          { id: "rename" as const, label: "Rename", disabled: mutationPending },
          { id: "duplicate" as const, label: "Duplicate", disabled: mutationPending },
          {
            id: "delete" as const,
            label: "Delete...",
            destructive: true,
            disabled: mutationPending,
          },
        ]
      : []),
    { id: "copy-mention", label: "Copy mention" },
    { id: "add-to-chat", label: "Add to chat" },
  ];
}
