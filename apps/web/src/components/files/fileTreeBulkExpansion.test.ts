import { describe, expect, it, vi } from "@effect/vitest";
import type { ProjectEntry } from "@t3tools/contracts";

import {
  directoryTreePaths,
  getAltChevronExpansion,
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

  it("does nothing when the repository has no directories", () => {
    const resetPaths = vi.fn();
    const model = { resetPaths };

    expect(setAllDirectoriesExpanded(model, ["README.md"], [], true)).toBe(false);
    expect(resetPaths).not.toHaveBeenCalled();
  });
});
