import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useCreateDraftThreadHandler, useDefaultProjectRef } from "../../hooks/useHandleNewThread";
import {
  getClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import type { ThreadRouteTarget } from "../../threadRoutes";
import { randomUUID } from "../../lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import { readThreadShell } from "../../state/entities";
import {
  ChatPaneId,
  close,
  createChatPaneLayout,
  focus,
  insertLeft,
  insertRight,
  promoteDraft,
  reconcileFocusedRoute,
  resetChatPaneWeights,
  resizeChatPaneBoundary,
  type ChatPane,
  type ChatPaneLayout,
} from "./chatPaneLayout";
import { persistChatPaneLayout, restoreChatPaneLayout } from "./chatPanePersistence";
import {
  applyNewChatPaneTarget,
  resolveNewChatPaneSource,
  resolveHomeNavigationSuppression,
  type NewChatPanePlacement,
} from "./chatPaneActions.logic";

export type ChatPaneSide = "left" | "right";

export interface ChatPaneActions {
  readonly layout: ChatPaneLayout | null;
  readonly focusedPaneId: ChatPaneId | null;
  readonly openTarget: (target: ThreadRouteTarget, side: ChatPaneSide) => void;
  readonly openNewChat: (
    sourcePaneId: ChatPaneId | null,
    side: ChatPaneSide,
    projectRef?: ScopedProjectRef,
  ) => Promise<void>;
  readonly replaceWithNewChat: (
    sourcePaneId: ChatPaneId | null,
    projectRef?: ScopedProjectRef,
  ) => Promise<void>;
  readonly resetToHome: () => void;
  readonly focusPane: (paneId: ChatPaneId) => void;
  readonly closePane: (paneId: ChatPaneId) => void;
  readonly promoteDraft: (paneId: ChatPaneId, threadRef: ScopedThreadRef) => void;
  readonly discardPane: (paneId: ChatPaneId) => void;
  /**
   * Commits a divider drag. Called once when the pointer is released, not on
   * every move: this writes through to client settings, and a settings write
   * per pointer event would flood the wire for the whole drag.
   */
  readonly resizeBoundary: (boundaryIndex: number, leftWidth: number, rightWidth: number) => void;
  readonly resetPaneSizes: () => void;
}

const ChatPaneActionsContext = createContext<ChatPaneActions | null>(null);
const CurrentChatPaneIdContext = createContext<ChatPaneId | null>(null);

type OpenTargetListener = (target: ThreadRouteTarget, side: ChatPaneSide) => void;
const openTargetListeners = new Set<OpenTargetListener>();

/** Opens a split from UI that lives above the chat route provider, such as the app sidebar. */
export function openChatPaneTarget(target: ThreadRouteTarget, side: ChatPaneSide): void {
  for (const listener of openTargetListeners) {
    listener(target, side);
  }
}

function newPane(target: ThreadRouteTarget): ChatPane {
  return { id: ChatPaneId.make(randomUUID()), target };
}

function focusedPane(layout: ChatPaneLayout | null): ChatPane | null {
  return layout?.panes.find((pane) => pane.id === layout.focusedPaneId) ?? null;
}

function projectRefForTarget(target: ThreadRouteTarget): ScopedProjectRef | null {
  if (target.kind === "server") {
    const thread = readThreadShell(target.threadRef);
    return thread ? scopeProjectRef(target.threadRef.environmentId, thread.projectId) : null;
  }

  const draft = useComposerDraftStore.getState().getDraftSession(target.draftId);
  return draft ? scopeProjectRef(draft.environmentId, draft.projectId) : null;
}

export function ChatPaneActionsProvider({
  children,
  routeTarget,
}: {
  readonly children: ReactNode;
  readonly routeTarget: ThreadRouteTarget | null;
}) {
  const navigate = useNavigate();
  const settingsHydrated = useClientSettingsHydrated();
  const persistedLayout = useClientSettings((settings) => settings.turboChatPaneLayout);
  const updateClientSettings = useUpdateClientSettings();
  const defaultProjectRef = useDefaultProjectRef();
  const createDraftThread = useCreateDraftThreadHandler();
  const layout = useMemo(() => restoreChatPaneLayout(persistedLayout), [persistedLayout]);
  const layoutRef = useRef(layout);
  const pendingHomeNavigationRef = useRef(false);
  layoutRef.current = layout;

  const navigateToTarget = useCallback(
    (target: ThreadRouteTarget, replace = true) => {
      if (target.kind === "server") {
        void navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: target.threadRef.environmentId,
            threadId: target.threadRef.threadId,
          },
          replace,
        });
        return;
      }
      void navigate({
        to: "/draft/$draftId",
        params: { draftId: target.draftId },
        replace,
      });
    },
    [navigate],
  );

  const commitLayout = useCallback(
    (nextLayout: ChatPaneLayout | null) => {
      layoutRef.current = nextLayout;
      updateClientSettings({
        turboChatPaneLayout: nextLayout ? persistChatPaneLayout(nextLayout) : null,
      });
    },
    [updateClientSettings],
  );

  const currentLayout = useCallback(() => {
    const latestPersisted = restoreChatPaneLayout(getClientSettings().turboChatPaneLayout);
    return latestPersisted ?? layoutRef.current;
  }, []);

  const openTarget = useCallback(
    (target: ThreadRouteTarget, side: ChatPaneSide) => {
      const current = currentLayout();
      const next = current
        ? side === "left"
          ? insertLeft(current, newPane(target))
          : insertRight(current, newPane(target))
        : createChatPaneLayout(newPane(target));
      commitLayout(next);
      navigateToTarget(target);
    },
    [commitLayout, currentLayout, navigateToTarget],
  );

  const focusPane = useCallback(
    (paneId: ChatPaneId) => {
      const current = currentLayout();
      if (!current || current.focusedPaneId === paneId) {
        return;
      }
      const next = focus(current, paneId);
      if (next === current) {
        return;
      }
      commitLayout(next);
      const pane = focusedPane(next);
      if (pane) {
        navigateToTarget(pane.target);
      }
    },
    [commitLayout, currentLayout, navigateToTarget],
  );

  const closePane = useCallback(
    (paneId: ChatPaneId) => {
      const current = currentLayout();
      if (!current || current.panes.length === 1) {
        return;
      }
      const wasFocused = current.focusedPaneId === paneId;
      const next = close(current, paneId);
      if (next === current) {
        return;
      }
      commitLayout(next);
      if (wasFocused) {
        const pane = focusedPane(next);
        if (pane) {
          navigateToTarget(pane.target);
        }
      }
    },
    [commitLayout, currentLayout, navigateToTarget],
  );

  const discardPane = useCallback(
    (paneId: ChatPaneId) => {
      const current = currentLayout();
      if (!current) {
        return;
      }
      if (current.panes.length > 1) {
        closePane(paneId);
        return;
      }
      if (current.panes[0].id !== paneId) {
        return;
      }
      pendingHomeNavigationRef.current = true;
      commitLayout(null);
      void navigate({ to: "/", replace: true });
    },
    [closePane, commitLayout, currentLayout, navigate],
  );

  const promotePaneDraft = useCallback(
    (paneId: ChatPaneId, threadRef: ScopedThreadRef) => {
      const current = currentLayout();
      if (!current) {
        return;
      }
      const promoted = promoteDraft(current, paneId, threadRef);
      if (promoted === current) {
        return;
      }
      const wasFocused = current.focusedPaneId === paneId;
      // A background draft can converge on a server thread already open in a
      // different pane. Deduplicate it without stealing focus from the pane
      // the user is currently working in.
      const next = wasFocused ? promoted : focus(promoted, current.focusedPaneId);
      commitLayout(next);
      if (wasFocused) {
        navigateToTarget({ kind: "server", threadRef });
      }
    },
    [commitLayout, currentLayout, navigateToTarget],
  );

  const createNewChatPane = useCallback(
    async (
      sourcePaneId: ChatPaneId | null,
      placement: NewChatPanePlacement,
      requestedProjectRef?: ScopedProjectRef,
    ) => {
      const source = resolveNewChatPaneSource(
        currentLayout(),
        sourcePaneId,
        projectRefForTarget,
        defaultProjectRef,
      );
      const projectRef = requestedProjectRef ?? source.projectRef;
      if (!projectRef) {
        return;
      }
      const created = await createDraftThread(projectRef, {
        navigation: "none",
        sourceTarget: source.target,
      });
      // null: a concurrent creation won the race and its navigation is
      // landing — opening a pane on top of it would fight that navigation.
      if (!created) {
        return;
      }
      const current = currentLayout();
      const next = applyNewChatPaneTarget(
        current,
        sourcePaneId,
        newPane({ kind: "draft", draftId: created.draftId }),
        placement,
      );
      if (next !== current) {
        commitLayout(next);
      }
      const pane = focusedPane(next);
      if (pane) {
        navigateToTarget(pane.target);
      }
    },
    [commitLayout, createDraftThread, currentLayout, defaultProjectRef, navigateToTarget],
  );

  const openNewChat = useCallback(
    (sourcePaneId: ChatPaneId | null, side: ChatPaneSide, projectRef?: ScopedProjectRef) =>
      createNewChatPane(sourcePaneId, side, projectRef),
    [createNewChatPane],
  );

  const replaceWithNewChat = useCallback(
    (sourcePaneId: ChatPaneId | null, projectRef?: ScopedProjectRef) =>
      createNewChatPane(sourcePaneId, "replace", projectRef),
    [createNewChatPane],
  );

  const resetToHome = useCallback(() => {
    pendingHomeNavigationRef.current = true;
    commitLayout(null);
    void navigate({ to: "/", replace: true });
  }, [commitLayout, navigate]);

  useEffect(() => {
    if (!settingsHydrated) {
      return;
    }
    openTargetListeners.add(openTarget);
    return () => {
      openTargetListeners.delete(openTarget);
    };
  }, [openTarget, settingsHydrated]);

  useEffect(() => {
    if (!settingsHydrated) {
      return;
    }
    const current = currentLayout();
    const homeNavigation = resolveHomeNavigationSuppression(
      pendingHomeNavigationRef.current,
      routeTarget,
    );
    pendingHomeNavigationRef.current = homeNavigation.pending;
    if (homeNavigation.skipReconciliation) {
      return;
    }
    if (routeTarget) {
      const next = current
        ? reconcileFocusedRoute(current, routeTarget)
        : createChatPaneLayout(newPane(routeTarget));
      if (next !== current) {
        commitLayout(next);
      }
      return;
    }
    const pane = focusedPane(current);
    if (pane) {
      navigateToTarget(pane.target);
    }
  }, [commitLayout, currentLayout, navigateToTarget, routeTarget, settingsHydrated]);

  const resizeBoundary = useCallback(
    (boundaryIndex: number, leftWidth: number, rightWidth: number) => {
      const current = currentLayout();
      if (!current) return;
      const next = resizeChatPaneBoundary(current, boundaryIndex, leftWidth, rightWidth);
      if (next === current) return;
      commitLayout(next);
    },
    [commitLayout, currentLayout],
  );

  const resetPaneSizes = useCallback(() => {
    const current = currentLayout();
    if (!current) return;
    const next = resetChatPaneWeights(current);
    if (next === current) return;
    commitLayout(next);
  }, [commitLayout, currentLayout]);

  const value = useMemo<ChatPaneActions>(
    () => ({
      layout: settingsHydrated ? layout : null,
      focusedPaneId: settingsHydrated ? (layout?.focusedPaneId ?? null) : null,
      openTarget,
      openNewChat,
      replaceWithNewChat,
      resetToHome,
      focusPane,
      closePane,
      promoteDraft: promotePaneDraft,
      discardPane,
      resizeBoundary,
      resetPaneSizes,
    }),
    [
      closePane,
      discardPane,
      focusPane,
      layout,
      openNewChat,
      openTarget,
      promotePaneDraft,
      replaceWithNewChat,
      resetPaneSizes,
      resetToHome,
      resizeBoundary,
      settingsHydrated,
    ],
  );

  return (
    <ChatPaneActionsContext.Provider value={value}>{children}</ChatPaneActionsContext.Provider>
  );
}

export function useChatPaneActions(): ChatPaneActions {
  const actions = useContext(ChatPaneActionsContext);
  if (!actions) {
    throw new Error("useChatPaneActions must be used inside ChatPaneActionsProvider");
  }
  return actions;
}

/** For UI that lives above the chat route provider, such as the app sidebar. */
export function useChatPaneActionsOptional(): ChatPaneActions | null {
  return useContext(ChatPaneActionsContext);
}

export function ChatPaneScope({
  children,
  paneId,
}: {
  readonly children: ReactNode;
  readonly paneId: ChatPaneId;
}) {
  return (
    <CurrentChatPaneIdContext.Provider value={paneId}>{children}</CurrentChatPaneIdContext.Provider>
  );
}

export function useCurrentChatPaneId(): ChatPaneId | null {
  return useContext(CurrentChatPaneIdContext);
}
