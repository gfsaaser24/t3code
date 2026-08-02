import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { RotateCw } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { type FileTreeContextMenuAction, fileTreeContextMenuItems } from "./fileTreeContextMenu";
import {
  directoryTreePaths,
  getAltChevronExpansion,
  setAllDirectoriesExpanded,
} from "./fileTreeBulkExpansion";
import { useProjectEntriesQuery } from "./projectFilesQueryState";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  /** File currently open in the preview pane; revealed and selected in the tree. */
  selectedPath: string | null;
  /** Bumped when the same path should be revealed again (e.g. re-opened from search). */
  selectedPathRevealId: number;
  /** Directory path requested by navigation outside the tree, or null when idle. */
  requestedRevealPath: string | null;
  /** Bumped when the same external reveal path should be handled again. */
  requestedRevealId: number;
  onOpenFile: (relativePath: string) => void;
  onFileRenamed: (oldRelativePath: string, newRelativePath: string) => void;
  onFileDeleted: (relativePath: string) => void;
  isFileMutationPending: (relativePath: string) => boolean;
}

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RotateCw className={cn(props.isPending && "animate-spin")} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1 rounded-md">
      <InputGroupInput
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
  requestedRevealPath,
  requestedRevealId,
  onOpenFile,
  onFileRenamed,
  onFileDeleted,
  isFileMutationPending,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd);
  const renameFile = useAtomCommand(projectEnvironment.renameFile);
  const duplicateFile = useAtomCommand(projectEnvironment.duplicateFile);
  const deleteFile = useAtomCommand(projectEnvironment.deleteFile);
  const entries = entriesQuery.data?.entries ?? [];
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(entryKinds);
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const directoryPaths = useMemo(() => directoryTreePaths(entries), [entries]);
  const previousTreePathsRef = useRef<readonly string[]>([]);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);
  const treeModelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);

  const showMutationFailure = (
    title: string,
    result: Parameters<typeof isAtomCommandInterrupted>[0],
  ) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  };

  const renameFileFromTree = async (sourcePath: string, destinationPath: string) => {
    const result = await renameFile({
      environmentId,
      input: { cwd, relativePath: sourcePath, destinationRelativePath: destinationPath },
    });
    if (result._tag === "Failure") {
      showMutationFailure("Unable to rename file", result);
      entriesQuery.refresh();
      return;
    }
    onFileRenamed(sourcePath, result.value.relativePath);
    entriesQuery.refresh();
    toastManager.add({
      type: "success",
      title: "File renamed",
      description: result.value.relativePath,
    });
  };
  const renameFileFromTreeRef = useRef(renameFileFromTree);
  useEffect(() => {
    renameFileFromTreeRef.current = renameFileFromTree;
  });

  // The tree renders rows in shadow DOM and its anchor rect is unreliable, so
  // capture the right-click position ourselves; contextmenu is a composed
  // event, so a capture-phase listener sees it with viewport coordinates.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    const capturePointer = (event: MouseEvent) => {
      contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    };
    document.addEventListener("contextmenu", capturePointer, true);
    return () => document.removeEventListener("contextmenu", capturePointer, true);
  }, []);

  const showEntryContextMenu = async (
    item: TreeContextMenuItem,
    context: TreeContextMenuOpenContext,
  ) => {
    const api = readLocalApi();
    if (!api) {
      context.close();
      return;
    }
    const relativePath = item.path.replace(/\/$/, "");
    const mention = serializeComposerFileLink(relativePath);
    const pointer = contextMenuPointerRef.current;
    const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
    const anchorRect = context.anchorElement.getBoundingClientRect();
    const position = pointerIsFresh
      ? { x: pointer.x, y: pointer.y }
      : { x: anchorRect.left, y: anchorRect.bottom };
    const mutationPending = item.kind === "file" && isFileMutationPending(relativePath);
    let clicked: FileTreeContextMenuAction | null = null;
    try {
      clicked = await api.contextMenu.show(
        fileTreeContextMenuItems(item.kind, mutationPending),
        position,
      );
    } finally {
      context.close();
    }

    if (clicked === "open-new-tab") {
      onOpenFile(relativePath);
      return;
    }
    if (clicked === "rename") {
      queueMicrotask(() => treeModelRef.current?.startRenaming(relativePath));
      return;
    }
    if (clicked === "duplicate") {
      const result = await duplicateFile({ environmentId, input: { cwd, relativePath } });
      if (result._tag === "Failure") {
        showMutationFailure("Unable to duplicate file", result);
        return;
      }
      entriesQuery.refresh();
      onOpenFile(result.value.relativePath);
      toastManager.add({
        type: "success",
        title: "File duplicated",
        description: result.value.relativePath,
      });
      return;
    }
    if (clicked === "delete") {
      const confirmed = await api.dialogs.confirm(
        `Delete '${relativePath}'? This cannot be undone.`,
      );
      if (!confirmed) return;
      const result = await deleteFile({ environmentId, input: { cwd, relativePath } });
      if (result._tag === "Failure") {
        showMutationFailure("Unable to delete file", result);
        return;
      }
      onFileDeleted(result.value.relativePath);
      entriesQuery.refresh();
      toastManager.add({ type: "success", title: "File deleted", description: relativePath });
      return;
    }
    if (clicked === "copy-mention") {
      try {
        await writeTextToClipboard(mention);
        toastManager.add({ type: "success", title: "Mention copied", description: relativePath });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to copy mention",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      return;
    }
    if (clicked === "add-to-chat") {
      const composer = composerRef?.current;
      if (!composer) {
        toastManager.add({
          type: "error",
          title: "Unable to add to chat",
          description: "Open a chat for this project and try again.",
        });
        return;
      }
      const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
      if (!inserted) {
        toastManager.add({
          type: "error",
          title: "Unable to add to chat",
          description: "The chat isn't ready to accept input right now.",
        });
      }
    }
  };
  const showEntryContextMenuRef = useRef(showEntryContextMenu);
  useEffect(() => {
    showEntryContextMenuRef.current = showEntryContextMenu;
  });

  const dragMention = useMemo(
    () =>
      createFileTreeDragMentionController({
        deselect: (path) => treeModelRef.current?.getItem(path)?.deselect(),
      }),
    [],
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          void showEntryContextMenuRef.current(item, context);
        },
      },
    },
    // Rows only need to be draggable so entries can be dropped into the chat
    // composer; rearranging files inside the tree stays off.
    dragAndDrop: { canDrop: () => false },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // The drag controller's selection cache must track every change,
      // including reveal-driven ones, or drags act on a stale selection.
      dragMention.handleSelectionChange(selectedPaths);
      // Selection changes driven by the reveal sync below are echoes of an
      // already-open file, not a request to open it again.
      if (syncingSelectionRef.current) return;
      // Starting a drag selects the dragged row; that selection is a side
      // effect of the gesture, not a request to open the file.
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(selectedPath);
      }
    },
    paths: [],
    renaming: {
      canRename: (item) => !item.isFolder,
      onError: (error) =>
        toastManager.add({ type: "error", title: "Unable to rename file", description: error }),
      onRename: ({ sourcePath, destinationPath }) => {
        void renameFileFromTreeRef.current(sourcePath, destinationPath);
      },
    },
    search: false,
    unsafeCSS: TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);
  const handleSearchValueChange = (value: string) => {
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };

  useEffect(() => {
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    previousTreePathsRef.current = treePaths;
    model.resetPaths(treePaths);
  }, [entryKinds, model, treePaths]);

  useEffect(() => {
    const path = requestedRevealPath ?? selectedPath;
    const revealId = requestedRevealPath !== null ? requestedRevealId : selectedPathRevealId;
    if (path === null) {
      handledRevealRef.current = null;
      return;
    }
    const revealRequest = { path, revealId };
    const handledReveal = handledRevealRef.current;
    // Entry refreshes rebuild treePaths while the same preview stays open.
    // Replaying a handled reveal would close an active tree search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    const kind = entryKinds.get(path);
    if (path !== "" && kind === undefined) return;
    const itemPath = kind === "directory" ? `${path.replace(/\/$/, "")}/` : path;
    const selectedItem = path === "" ? null : model.getItem(itemPath);
    if (path !== "" && !selectedItem) return;

    // A selection that originated inside the tree (clicking a row, possibly
    // in an active tree search) is already visible; re-revealing it would
    // close the search and clobber the user's context. Only sync external
    // opens (file picker, content search, chat links).
    const selectedInTree = model
      .getSelectedPaths()
      .some((selected) => selected.replace(/\/$/, "") === path);
    if (
      requestedRevealPath === null &&
      kind === "file" &&
      selectedInTree &&
      treeSelectionPathRef.current === path
    ) {
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;
      return;
    }
    treeSelectionPathRef.current = null;
    handledRevealRef.current = revealRequest;

    syncingSelectionRef.current = true;
    model.closeSearch();
    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect();
    }

    // Directory rows are registered with a trailing slash (see treePath), so
    // ancestor lookups must use the same form to expand them.
    const segments = path.split("/").filter(Boolean);
    let ancestorPath = "";
    const ancestorSegments = kind === "directory" ? segments : segments.slice(0, -1);
    for (const segment of ancestorSegments) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
      if (item && "expand" in item) item.expand();
    }

    if (selectedItem) {
      selectedItem.select();
      model.scrollToPath(itemPath, { focus: true, offset: "center" });
    } else {
      const firstPath = treePaths[0];
      if (firstPath) model.scrollToPath(firstPath, { focus: false, offset: "top" });
    }
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [
    entryKinds,
    model,
    requestedRevealId,
    requestedRevealPath,
    selectedPath,
    selectedPathRevealId,
    treePaths,
  ]);

  // Tag tree drags with the composer mention payload. The row is read from
  // the composed event path (the tree's shadow root is open), so this does
  // not depend on running after the tree's own dragstart handler; the drag
  // data store is writable for every dragstart listener in the dispatch.
  // The capture phase runs before the tree's own dragstart handler selects
  // the dragged row, so the drag flag is up before that selection emits.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    treeModelRef.current = model;
  }, [model]);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const handleDragStart = (event: DragEvent) => dragMention.handleDragStart(event);
    const handleDragEnd = () => dragMention.handleDragEnd();
    panel.addEventListener("dragstart", handleDragStart, true);
    panel.addEventListener("dragend", handleDragEnd);
    return () => {
      panel.removeEventListener("dragstart", handleDragStart, true);
      panel.removeEventListener("dragend", handleDragEnd);
    };
  }, [dragMention]);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;

    const handleAltChevronClick = (event: MouseEvent) => {
      const expanded = getAltChevronExpansion(event);
      if (expanded === null) return;
      if (model.isSearchOpen()) search.close();
      if (!setAllDirectoriesExpanded(model, treePaths, directoryPaths, expanded)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    panel.addEventListener("click", handleAltChevronClick, true);
    return () => panel.removeEventListener("click", handleAltChevronClick, true);
  }, [directoryPaths, model, search, treePaths]);

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div className="surface-subheader gap-1 px-2" data-surface-subheader>
        <RefreshFilesButton isPending={entriesQuery.isPending} onRefresh={entriesQuery.refresh} />
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={search.value}
          onValueChange={handleSearchValueChange}
          onClose={search.close}
        />
      </div>
      {entriesQuery.error && entriesQuery.data === null ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">{entriesQuery.error}</div>
      ) : (
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={{
            colorScheme: resolvedTheme,
            ["--trees-fg-override" as string]: "var(--foreground)",
          }}
        />
      )}
    </div>
  );
}
