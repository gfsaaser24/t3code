import type { ScopedThreadRef } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, type ReactNode } from "react";
import { ChatViewContent } from "../../components/ChatView";
import { threadHasStarted } from "../../components/ChatView.logic";
import { DiffWorkerPoolProvider } from "../../components/DiffWorkerPoolProvider";
import { waitForDraftHeroTransition } from "../../components/chat/draftHeroTransition";
import { SidebarInset } from "../../components/ui/sidebar";
import { Button } from "../../components/ui/button";
import {
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  useThread,
  useThreadDetail,
  useThreadRefs,
  useThreadShell,
  useThreadStatus,
} from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { useEnvironments } from "../../state/environments";
import { resolveThreadRouteRenderState } from "../../threadRoutes";
import { resolveThreadSyncPhase } from "../../threadSync";
import { useMatches } from "@tanstack/react-router";
import { chatPaneWeight, isChatPaneTargetRouteId, type ChatPane } from "./chatPaneLayout";
import { ChatPaneDivider, MIN_CHAT_PANE_WIDTH } from "./ChatPaneDivider";
import { ChatPaneScope, useChatPaneActions } from "./ChatPaneActionsContext";
import { isServerPaneEnvironmentUnavailable } from "./chatPaneActions.logic";
import { chatPaneChromeOwnership } from "./chatPaneResourcePolicy";

function ChatPanePlaceholder({
  message,
  paneId,
}: {
  readonly message: string;
  readonly paneId: ChatPane["id"];
}) {
  const { discardPane } = useChatPaneActions();

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center p-6 text-center">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="absolute top-3 right-3"
        aria-label="Close this chat pane"
        onClick={() => discardPane(paneId)}
      >
        <XIcon aria-hidden className="size-4" />
      </Button>
      <p className="max-w-xs text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function ServerChatPane({
  paneId,
  reserveTitleBarControlInset,
  reserveSidebarControlInset,
  threadRef,
}: {
  readonly paneId: ChatPane["id"];
  readonly reserveTitleBarControlInset: boolean;
  readonly reserveSidebarControlInset: boolean;
  readonly threadRef: ScopedThreadRef;
}) {
  const { discardPane } = useChatPaneActions();
  const shell = useEnvironmentQuery(environmentShell.stateAtom(threadRef.environmentId));
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  const draftThreadExists = useComposerDraftStore(
    (store) => store.getDraftThreadByRef(threadRef) !== null,
  );
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadShellExists: serverThreadShell !== null,
    serverThreadDetailExists: serverThreadDetail !== null,
    serverThreadDetailDeleted: serverThreadStatus === "deleted",
    draftThreadExists,
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverThreadDetail !== null,
    shellExists: serverThreadShell !== null,
    status: serverThreadStatus,
  });
  const serverThreadStarted = threadHasStarted(serverThreadDetail);

  useEffect(() => {
    if (bootstrapComplete && renderState === "missing") {
      discardPane(paneId);
    }
  }, [bootstrapComplete, discardPane, paneId, renderState]);

  useEffect(() => {
    if (serverThreadStarted && draftThread) {
      finalizePromotedDraftThreadByRef(threadRef);
    }
  }, [draftThread, serverThreadStarted, threadRef]);

  if (renderState !== "ready" && !(renderState === "loading" && serverThreadShell !== null)) {
    return (
      <ChatPanePlaceholder
        paneId={paneId}
        message={renderState === "missing" ? "This chat is no longer available." : "Connecting…"}
      />
    );
  }

  return (
    <ChatViewContent
      environmentId={threadRef.environmentId}
      reserveTitleBarControlInset={reserveTitleBarControlInset}
      reserveSidebarControlInset={reserveSidebarControlInset}
      threadId={threadRef.threadId}
      routeKind="server"
      threadSyncPhase={threadSyncPhase}
    />
  );
}

function DraftChatPane({
  draftId,
  paneId,
  reserveTitleBarControlInset,
  reserveSidebarControlInset,
}: {
  readonly draftId: Extract<ChatPane["target"], { kind: "draft" }>["draftId"];
  readonly paneId: ChatPane["id"];
  readonly reserveTitleBarControlInset: boolean;
  readonly reserveSidebarControlInset: boolean;
}) {
  const { discardPane, promoteDraft } = useChatPaneActions();
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const threadRefs = useThreadRefs();
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef = draftSession?.promotedTo ?? inferredThreadRef;
  const serverThread = useThread(serverThreadRef);
  const canonicalThreadRef = threadHasStarted(serverThread) ? serverThreadRef : null;

  useEffect(() => {
    if (inferredThreadRef && !draftSession?.promotedTo) {
      markPromotedDraftThreadByRef(inferredThreadRef);
    }
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (!cancelled) {
        promoteDraft(paneId, canonicalThreadRef);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, paneId, promoteDraft]);

  useEffect(() => {
    if (!draftSession && !canonicalThreadRef) {
      discardPane(paneId);
    }
  }, [canonicalThreadRef, discardPane, draftSession, paneId]);

  if (!draftSession) {
    return <ChatPanePlaceholder paneId={paneId} message="Opening chat…" />;
  }

  return (
    <ChatViewContent
      draftId={draftId}
      environmentId={draftSession.environmentId}
      reserveTitleBarControlInset={reserveTitleBarControlInset}
      reserveSidebarControlInset={reserveSidebarControlInset}
      threadId={draftSession.threadId}
      routeKind="draft"
      forceExpandedMobileComposer
    />
  );
}

function ChatPaneTarget({
  pane,
  reserveTitleBarControlInset,
  reserveSidebarControlInset,
  environmentUnavailable,
}: {
  readonly pane: ChatPane;
  readonly reserveTitleBarControlInset: boolean;
  readonly reserveSidebarControlInset: boolean;
  readonly environmentUnavailable: boolean;
}) {
  if (pane.target.kind === "server" && environmentUnavailable) {
    return <ChatPanePlaceholder paneId={pane.id} message="This chat environment is unavailable." />;
  }

  return pane.target.kind === "server" ? (
    <ServerChatPane
      paneId={pane.id}
      reserveTitleBarControlInset={reserveTitleBarControlInset}
      reserveSidebarControlInset={reserveSidebarControlInset}
      threadRef={pane.target.threadRef}
    />
  ) : (
    <DraftChatPane
      draftId={pane.target.draftId}
      paneId={pane.id}
      reserveTitleBarControlInset={reserveTitleBarControlInset}
      reserveSidebarControlInset={reserveSidebarControlInset}
    />
  );
}

export function ChatPaneWorkspace({ fallback }: { readonly fallback: ReactNode }) {
  const { focusPane, layout } = useChatPaneActions();
  const { environments, isReady: environmentCatalogReady } = useEnvironments();
  // Full-page children of the _chat layout (the pull-requests page today)
  // render through the outlet; the pane workspace only owns pane targets.
  // Without this, navigating there changes the URL while the panes keep
  // painting — the click appears to do nothing.
  const isPaneTargetRoute = useMatches({
    select: (matches) => isChatPaneTargetRouteId(matches[matches.length - 1]?.routeId),
  });
  const knownEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );

  if (!layout || !isPaneTargetRoute) {
    return <DiffWorkerPoolProvider>{fallback}</DiffWorkerPoolProvider>;
  }

  return (
    <DiffWorkerPoolProvider>
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" data-chat-pane-workspace="">
          {layout.panes.map((pane, index) => {
            const isFocused = pane.id === layout.focusedPaneId;
            const chrome = chatPaneChromeOwnership(index, layout.panes.length);
            const environmentUnavailable = isServerPaneEnvironmentUnavailable(
              pane,
              environmentCatalogReady,
              knownEnvironmentIds,
            );
            const previousPane = index > 0 ? layout.panes[index - 1] : null;
            return (
              <Fragment key={pane.id}>
                {previousPane ? (
                  <ChatPaneDivider
                    boundaryIndex={index - 1}
                    leftPaneLabel={`chat pane ${index}`}
                    rightPaneLabel={`chat pane ${index + 1}`}
                  />
                ) : null}
                <section
                  aria-label={`Chat pane ${index + 1}`}
                  className="relative flex min-h-0 min-w-0 overflow-hidden"
                  // The divider owns the seam now, so the panes no longer draw
                  // their own border. Width comes from the stored weight, and
                  // the basis stays 0 so the weights alone decide the split.
                  //
                  // The floor is capped at an equal share so the minimums can
                  // never sum past the row: a hard 360px would overflow a
                  // narrow window as soon as a second pane opened.
                  style={{
                    flexGrow: chatPaneWeight(pane),
                    flexShrink: 1,
                    flexBasis: 0,
                    minWidth: `min(${MIN_CHAT_PANE_WIDTH}px, ${100 / layout.panes.length}%)`,
                  }}
                  data-chat-pane=""
                  data-chat-pane-focused={isFocused ? "true" : "false"}
                  data-chat-pane-id={pane.id}
                  onFocusCapture={() => focusPane(pane.id)}
                  onPointerDownCapture={() => focusPane(pane.id)}
                >
                  <ChatPaneScope paneId={pane.id}>
                    <ChatPaneTarget
                      pane={pane}
                      reserveTitleBarControlInset={chrome.reserveTitleBarControlInset}
                      reserveSidebarControlInset={chrome.reserveSidebarControlInset}
                      environmentUnavailable={environmentUnavailable}
                    />
                  </ChatPaneScope>
                </section>
              </Fragment>
            );
          })}
        </div>
      </SidebarInset>
    </DiffWorkerPoolProvider>
  );
}
