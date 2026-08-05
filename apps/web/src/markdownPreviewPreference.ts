import * as Schema from "effect/Schema";
import { useCallback } from "react";

import { useLocalStorage } from "./hooks/useLocalStorage";

export const MARKDOWN_PREVIEW_STORAGE_KEY = "t3code.renderMarkdown";
export const DEFAULT_MARKDOWN_PREVIEW_MODE = "code" as const;

export type MarkdownPreviewMode = "pretty" | "code";

export function markdownPreviewModeFromStoredValue(rendered: boolean): MarkdownPreviewMode {
  return rendered ? "pretty" : "code";
}

export function markdownPreviewModeToStoredValue(mode: MarkdownPreviewMode): boolean {
  return mode === "pretty";
}

/** Shared by the file panel and Settings so either surface updates the other immediately. */
export function useMarkdownPreviewMode(): readonly [
  MarkdownPreviewMode,
  (mode: MarkdownPreviewMode) => void,
] {
  const [rendered, setRendered] = useLocalStorage(
    MARKDOWN_PREVIEW_STORAGE_KEY,
    markdownPreviewModeToStoredValue(DEFAULT_MARKDOWN_PREVIEW_MODE),
    Schema.Boolean,
  );
  const setMode = useCallback(
    (mode: MarkdownPreviewMode) => setRendered(markdownPreviewModeToStoredValue(mode)),
    [setRendered],
  );

  return [markdownPreviewModeFromStoredValue(rendered), setMode];
}
