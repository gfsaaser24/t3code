import type { ProjectEntry } from "@t3tools/contracts";

interface FileTreeBulkExpansionModel {
  resetPaths(paths: readonly string[], options: { initialExpandedPaths: readonly string[] }): void;
}

interface AltChevronClickEvent {
  readonly altKey: boolean;
  readonly button: number;
  composedPath(): EventTarget[];
}

function attributeValue(target: EventTarget, name: string): string | null {
  if (typeof target !== "object" || target === null || !("getAttribute" in target)) return null;
  const getAttribute = target.getAttribute;
  return typeof getAttribute === "function" ? getAttribute.call(target, name) : null;
}

export function directoryTreePaths(entries: readonly ProjectEntry[]): string[] {
  return entries
    .filter((entry) => entry.kind === "directory")
    .map((entry) => `${entry.path.replace(/\/$/, "")}/`);
}

export function getAltChevronExpansion(event: AltChevronClickEvent): boolean | null {
  if (!event.altKey || event.button !== 0) return null;

  const path = event.composedPath();
  const clickedChevron = path.some(
    (target) => attributeValue(target, "data-item-section") === "icon",
  );
  if (!clickedChevron) return null;

  const directoryRow = path.find(
    (target) =>
      attributeValue(target, "data-type") === "item" &&
      attributeValue(target, "data-item-type") === "folder",
  );
  if (!directoryRow) return null;

  const expanded = attributeValue(directoryRow, "aria-expanded");
  if (expanded === "true") return false;
  if (expanded === "false") return true;
  return null;
}

export function setAllDirectoriesExpanded(
  model: FileTreeBulkExpansionModel,
  treePaths: readonly string[],
  directoryPaths: readonly string[],
  expanded: boolean,
): boolean {
  if (directoryPaths.length === 0) return false;
  model.resetPaths(treePaths, {
    initialExpandedPaths: expanded ? directoryPaths : [],
  });
  return true;
}
