import { isMarkdownPreviewFile } from "../files/filePreviewMode";

export type MarkdownFileLinkGesture = "open-file-panel" | "open-system-default";

export function resolveMarkdownFileLinkGesture(input: {
  readonly path: string;
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}): MarkdownFileLinkGesture | null {
  if (
    input.button !== 0 ||
    !isMarkdownPreviewFile(input.path) ||
    !input.ctrlKey ||
    input.altKey ||
    input.metaKey
  ) {
    return null;
  }
  return input.shiftKey ? "open-system-default" : "open-file-panel";
}
