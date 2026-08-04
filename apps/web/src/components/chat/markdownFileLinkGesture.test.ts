import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownFileLinkGesture } from "./markdownFileLinkGesture";

const gesture = (
  path: string,
  modifiers: Partial<{
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
  }> = {},
) =>
  resolveMarkdownFileLinkGesture({
    path,
    button: 0,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...modifiers,
  });

describe("resolveMarkdownFileLinkGesture", () => {
  it("opens Markdown files in the file panel on Ctrl+click", () => {
    expect(gesture("docs/guide.md", { ctrlKey: true })).toBe("open-file-panel");
    expect(gesture("docs/guide.MDX", { ctrlKey: true })).toBe("open-file-panel");
  });

  it("opens Markdown files with the system default app on Ctrl+Shift+click", () => {
    expect(gesture("C:/project/README.MD", { ctrlKey: true, shiftKey: true })).toBe(
      "open-system-default",
    );
  });

  it("does not override plain clicks or non-Markdown file gestures", () => {
    expect(gesture("README.md")).toBeNull();
    expect(gesture("index.html", { ctrlKey: true })).toBeNull();
    expect(gesture("report.pdf", { ctrlKey: true, shiftKey: true })).toBeNull();
  });

  it("does not override gestures with Alt or Meta modifiers", () => {
    expect(gesture("README.md", { ctrlKey: true, altKey: true })).toBeNull();
    expect(gesture("README.md", { ctrlKey: true, metaKey: true })).toBeNull();
  });

  it("does not turn Ctrl+right-click into an open gesture", () => {
    expect(
      resolveMarkdownFileLinkGesture({
        path: "README.md",
        button: 2,
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      }),
    ).toBeNull();
  });
});
