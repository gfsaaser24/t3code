import type { ScopedThreadRef } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useEffect, useMemo, type ReactNode } from "react";
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
import type { ChatPane } from "./chatPaneLayout";
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
  const knownEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );

  if (!layout) {
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
            return (
              <section
                key={pane.id}
                aria-label={`Chat pane ${index + 1}`}
                className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden border-border/70 border-l first:border-l-0"
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
            );
          })}
        </div>
      </SidebarInset>
    </DiffWorkerPoolProvider>
  );
}
