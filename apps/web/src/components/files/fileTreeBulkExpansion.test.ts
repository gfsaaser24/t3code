import { describe, expect, it, vi } from "@effect/vitest";
import { FileTree } from "@pierre/trees";
import type { ProjectEntry } from "@t3tools/contracts";

import {
  directoryTreePaths,
  getAltChevronExpansion,
  rootDirectoryTreePaths,
  setAllDirectoriesExpanded,
} from "./fileTreeBulkExpansion.ts";

function element(attributes: Record<string, string>): EventTarget {
  return {
    getAttribute: (name: string) => attributes[name] ?? null,
  } as unknown as EventTarget;
}

function altClickPath(row: EventTarget, target: EventTarget, altKey = true) {
  return {
    altKey,
    button: 0,
    composedPath: () => [target, row],
  };
}

describe("file tree bulk expansion", () => {
  it("collects canonical directory paths", () => {
    const entries: ProjectEntry[] = [
      { kind: "directory", path: "src" },
      { kind: "directory", path: "src/components/" },
      { kind: "file", path: "src/index.ts" },
    ];

    expect(directoryTreePaths(entries)).toEqual(["src/", "src/components/"]);
  });

  it("collects every implicit ancestor from deep repository file paths", () => {
    const entries: ProjectEntry[] = [
      { kind: "file", path: "src/components/Button.tsx" },
      { kind: "file", path: "src/utils/format.ts" },
      { kind: "directory", path: "docs/guides/" },
      { kind: "file", path: "README.md" },
    ];

    expect(directoryTreePaths(entries)).toEqual([
      "src/",
      "src/components/",
      "src/utils/",
      "docs/",
      "docs/guides/",
    ]);
  });

  it("selects only repository-root directories for the normal initial expansion", () => {
    expect(
      rootDirectoryTreePaths(["src/", "src/components/", "docs/", "docs/guides/advanced/"]),
    ).toEqual(["src/", "docs/"]);
  });

  it("uses the clicked chevron state to choose expand-all or collapse-all", () => {
    const chevron = element({ "data-item-section": "icon" });

    expect(
      getAltChevronExpansion(
        altClickPath(
          element({
            "aria-expanded": "false",
            "data-item-type": "folder",
            "data-type": "item",
          }),
          chevron,
        ),
      ),
    ).toBe(true);

    expect(
      getAltChevronExpansion(
        altClickPath(
          element({
            "aria-expanded": "true",
            "data-item-type": "folder",
            "data-type": "item",
          }),
          chevron,
        ),
      ),
    ).toBe(false);
  });

  it("ignores ordinary clicks and clicks outside a directory chevron", () => {
    const row = element({
      "aria-expanded": "false",
      "data-item-type": "folder",
      "data-type": "item",
    });
    const content = element({ "data-item-section": "content" });

    expect(getAltChevronExpansion(altClickPath(row, content))).toBeNull();
    expect(getAltChevronExpansion(altClickPath(row, content, false))).toBeNull();
  });

  it("resets the tree once with all or no directories", () => {
    const resetPaths = vi.fn();
    const model = { resetPaths };
    const treePaths = ["src/", "src/components/", "src/index.ts"];
    const directoryPaths = ["src/", "src/components/"];

    expect(setAllDirectoriesExpanded(model, treePaths, directoryPaths, true)).toBe(true);
    expect(resetPaths).toHaveBeenLastCalledWith(treePaths, {
      initialExpandedPaths: directoryPaths,
    });

    expect(setAllDirectoriesExpanded(model, treePaths, directoryPaths, false)).toBe(true);
    expect(resetPaths).toHaveBeenLastCalledWith(treePaths, { initialExpandedPaths: [] });
    expect(resetPaths).toHaveBeenCalledTimes(2);
  });

  it("opens and closes every explicit or implicit directory in a real tree model", () => {
    const entries: ProjectEntry[] = [
      { kind: "file", path: "src/components/Button.tsx" },
      { kind: "file", path: "src/utils/format.ts" },
      { kind: "file", path: "docs/guides/setup.md" },
    ];
    const treePaths = entries.map((entry) => entry.path);
    const directoryPaths = directoryTreePaths(entries);
    const initialDirectoryPaths = rootDirectoryTreePaths(directoryPaths);
    const model = new FileTree({
      flattenEmptyDirectories: true,
      initialExpansion: "closed",
      paths: treePaths,
    });
    const isExpandedDirectory = (path: string) => {
      const item = model.getItem(path);
      if (item === null || !("isExpanded" in item)) return false;
      return item.isExpanded();
    };

    try {
      model.resetPaths(treePaths, { initialExpandedPaths: initialDirectoryPaths });
      expect(initialDirectoryPaths.every(isExpandedDirectory)).toBe(true);
      expect(
        directoryPaths
          .filter((path) => !initialDirectoryPaths.includes(path))
          .some(isExpandedDirectory),
      ).toBe(false);

      expect(setAllDirectoriesExpanded(model, treePaths, directoryPaths, true)).toBe(true);
      expect(directoryPaths.every(isExpandedDirectory)).toBe(true);

      expect(setAllDirectoriesExpanded(model, treePaths, directoryPaths, false)).toBe(true);
      expect(directoryPaths.some(isExpandedDirectory)).toBe(false);
    } finally {
      model.cleanUp();
    }
  });

  it("does nothing when the repository has no directories", () => {
    const resetPaths = vi.fn();
    const model = { resetPaths };

    expect(setAllDirectoriesExpanded(model, ["README.md"], [], true)).toBe(false);
    expect(resetPaths).not.toHaveBeenCalled();
  });
});
