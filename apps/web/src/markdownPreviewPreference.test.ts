import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_MARKDOWN_PREVIEW_MODE,
  MARKDOWN_PREVIEW_STORAGE_KEY,
  markdownPreviewModeFromStoredValue,
  markdownPreviewModeToStoredValue,
} from "./markdownPreviewPreference";

describe("markdown preview preference", () => {
  it("keeps source code as the default", () => {
    expect(DEFAULT_MARKDOWN_PREVIEW_MODE).toBe("code");
  });

  it("keeps the existing storage key and Boolean encoding", () => {
    expect(MARKDOWN_PREVIEW_STORAGE_KEY).toBe("t3code.renderMarkdown");
    expect(markdownPreviewModeFromStoredValue(true)).toBe("pretty");
    expect(markdownPreviewModeFromStoredValue(false)).toBe("code");
    expect(markdownPreviewModeToStoredValue("pretty")).toBe(true);
    expect(markdownPreviewModeToStoredValue("code")).toBe(false);
  });
});
