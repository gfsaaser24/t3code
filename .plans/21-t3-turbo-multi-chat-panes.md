# T3 Turbo Multi-Chat Panes

## Goal

Let a user view and operate more than one chat at once in an ordered row of peer panes. A thread
card can open a chat in a new pane to the left or right, and every pane keeps its own chat header,
project breadcrumb, git controls, worktree controls, composer, terminal, and right-panel state.

Keep the feature in a small T3 Turbo web seam around the existing `ChatView`. Do not add a relay
protocol, server-side pane persistence, a recursive layout tree, or another connection runtime.

## Confirmed Architecture

- Desktop, locally served web, and the hosted/relay portal all render `apps/web`, so one client-side
  implementation covers those three surfaces.
- Threads and subscriptions are already scoped by `ScopedThreadRef` (`environmentId + threadId`).
  The shared connection runtime multiplexes multiple thread subscriptions and reconnects them on
  the existing environment connection.
- The relay is not a pane store. It remains the discovery/control plane, and WebSocket thread data
  continues to come from the selected environment.
- Mobile remains single-pane in this phase because it has a separate React Native navigation and
  layout system.

No pane work belongs in `infra/relay`, `packages/contracts/src/relay.ts`, or server persistence.

## Product Decisions

- Use a flat ordered list of equal-width horizontal panes, separated by a border.
- Do not add draggable N-way resizing in the first version.
- Persist the lightweight pane layout through the existing typed client-settings path. Electron
  writes the same `ClientSettings` document through the desktop bridge; local and hosted web use
  the existing browser-storage adapter. Do not create another storage service.
- Persist only the layout version, ordered pane IDs, `ThreadRouteTarget` references, and focused
  pane ID. Messages, subscriptions, terminals, workers, and rendered UI are never serialized into
  the pane layout.
- On reload, restore the saved layout and reconcile the URL into the focused pane. On a new client
  with no saved layout, a deep link creates a single focused pane as it does today.
- The URL represents the focused pane only. Browser history and shareable links therefore keep
  their current meaning.
- A normal sidebar click replaces the focused pane.
- A thread already open elsewhere is focused instead of mounted twice.
- Closing a pane focuses its nearest neighbor. The last pane cannot be closed, so the workspace
  never reaches an invalid empty state.
- The `+` button replaces the focused pane with the existing new-chat draft hero. Its chevron menu
  contains only `Open new chat to the right` and `Open new chat to the left`.
- Each pane header has a separate `Close pane` icon button when more than one pane is open. The
  final pane cannot be closed; its `+` action is the way back to a fresh draft/home.
- Right-clicking a thread card offers `Open in new split pane to the right` and `Open in new split
  pane to the left` in both Sidebar V2 and the V1 fallback.

## Replaceable Seam

Keep the implementation under `apps/web/src/turbo/chatPanes/` with minimal adapters in upstream
hotspots:

- `chatPaneLayout.ts` - pure typed state and transitions.
- `chatPaneStore.ts` - thin Zustand adapter backed by the existing typed `ClientSettings`
  persistence; no server or relay storage.
- `ChatPaneActionsContext.tsx` - pane-local replace, insert, focus, close, and promotion actions.
- `ChatPaneWorkspace.tsx` - ordered renderer, focus ownership, and focused-URL synchronization.
- `ChatPaneTarget.tsx` - reusable server/draft target resolution currently split across route files.
- `ChatPaneControl.tsx` - the header split button and menu.
- `chatPaneContextMenu.ts` - typed menu IDs/items shared by Sidebar V1 and V2.

Use the existing `ThreadRouteTarget` union from `apps/web/src/threadRoutes.ts` rather than creating
another thread identity shape.

```ts
interface ChatPane {
  readonly id: ChatPaneId;
  readonly target: ThreadRouteTarget;
}

interface ChatPaneLayout {
  readonly version: 1;
  readonly panes: readonly [ChatPane, ...ChatPane[]];
  readonly focusedPaneId: ChatPaneId;
}
```

The pure transition API should be limited to:

- `replaceFocused(target)`
- `insertLeft(target)`
- `insertRight(target)`
- `focus(paneId)`
- `close(paneId)`
- `promoteDraft(paneId, threadRef)`
- `reconcileFocusedRoute(target)`

## Integration Points

Keep modifications to these large upstream files shallow:

- `apps/web/src/routes/_chat.tsx` mounts one workspace host and routes global commands to the
  focused pane.
- The server-thread and draft route components translate the URL into the focused pane target.
- `apps/web/src/components/ChatView.tsx` accepts pane focus/layout context; its existing thread
  props remain the source of pane identity.
- `apps/web/src/components/chat/ChatHeader.tsx` mounts `ChatPaneControl` beside, not instead of,
  the existing project/worktree/environment controls.
- `apps/web/src/components/SidebarV2.tsx` and `Sidebar.tsx` consume the shared typed menu builder
  and pane actions.
- `apps/web/src/hooks/useHandleNewThread.ts` is split into a route-free draft creator that returns a
  target and a thin legacy route adapter. Draft creation must accept an explicit source pane rather
  than reading the global route for carry-over state.

Audit chat descendants that still read `useActiveEnvironmentId` or `usePrimaryEnvironmentId`.
Breadcrumbs, git/worktree commands, markdown assets, file previews, and plans must use the pane's
explicit environment. The primary environment remains only an app-wide default.

## Runtime Resource Model

Persistence restores the layout; it is not the RAM optimization. Every visible pane necessarily
has a React surface, but it must reference shared runtime state rather than duplicate it:

- Keep one connection supervisor/socket per environment and reuse the existing multiplexed thread
  subscriptions and client cache.
- Deduplicate identical targets so a thread cannot be mounted or subscribed twice.
- Keep one diff worker pool above the workspace and one terminal host for the relevant thread,
  rather than constructing either for every `ChatView`.
- Preserve the existing virtualized message timeline and avoid copying message arrays into pane
  state.
- Keep pane-local transient UI state small and release subscriptions and terminal ownership as
  soon as a pane closes.

Do not add an arbitrary pane limit before profiling. Record heap, worker, subscription, and render
behavior with 1, 2, 4, and 8 panes; add a documented limit only if those measurements show the
shared-resource model cannot keep the client stable.

## Task Breakdown

- [ ] Add branded `ChatPaneId`, the non-empty flat layout model, pure transitions, and exhaustive
      unit tests.
- [ ] Extend `ClientSettingsSchema` with a versioned, defaulted Turbo pane layout and add the thin
      persisted store and focused-route adapter; keep secondary panes out of the URL.
- [ ] Decode defensively and fall back to a single URL-derived pane when persisted targets are
      malformed, stale, unavailable, or from an older layout version.
- [ ] Extract route-free draft creation and reusable draft promotion/missing-target resolution.
- [ ] Add `ChatPaneWorkspace` and render existing `ChatView` instances as equal-width peers.
- [ ] Gate global shortcuts, type-to-focus, automatic composer focus, and command-palette composer
      ownership to the focused pane.
- [ ] Lift `DiffWorkerPoolProvider` to the workspace so additional panes do not create additional
      2-6 worker pools.
- [ ] Prevent duplicate hidden terminal drawers; share terminal ownership and mount persistence
      once per relevant thread, not once per `ChatView` instance.
- [ ] Make title-bar ownership pane-aware: only the leftmost pane receives the collapsed-sidebar
      inset and only the rightmost pane reserves Electron window-control space.
- [ ] Make right-panel layout depend on pane width, or use its sheet/overlay form in multi-pane
      mode, so narrow panes do not each claim a 360-540px inline panel.
- [ ] Add the `+`/chevron pane control and a separate close-pane button to every chat header.
- [ ] Add the left/right open actions to both Sidebar V2 and V1 thread-card context menus.
- [ ] Reconcile ordinary sidebar clicks, command palette creation, deletion, missing threads,
      draft promotion, deep links, and browser back/forward against the focused pane.
- [ ] Add user documentation and an internal seam note for nightly upstream recovery.

## Acceptance Criteria

- Two or more distinct chats can stream and remain interactive at the same time.
- Insert-left and insert-right produce the requested order from both a thread card and the header
  menu.
- Every pane displays controls and data for its own scoped environment/thread.
- Commands, typing, focus, git actions, and new-thread carry-over affect only the focused pane.
- Reopening an already visible target focuses it and does not duplicate a composer or subscription.
- Closing panes is deterministic and the workspace never reaches an invalid empty state.
- A disconnect in one environment does not stop another pane, and reconnect resumes both through
  the existing connection supervisor.
- Desktop, local web, and hosted/relay web share the same behavior without a new wire contract.
- Multiple panes do not multiply diff worker pools or hidden terminal hosts.
- Reload restores the last valid ordered layout and focused pane on the same client, while a stale
  or corrupt saved layout safely falls back to the URL target.
- The pane store contains references only; opening panes does not duplicate message histories,
  environment sockets, or per-workspace worker pools.

## Focused Verification

- Pure layout tests: ordering, replace, focus, close-neighbor choice, last-pane close protection,
  deduplication, draft promotion, and focused-route reconciliation.
- Component tests: header split button, both sidebar context menus, focused-only shortcuts and
  autofocus, per-pane title-bar insets, and narrow-pane right panels.
- Integration tests: two simultaneous thread streams, two environment IDs, independent reconnect
  cursors, deletion/missing-target fallback, and draft-to-server promotion in one pane.
- Persistence/navigation tests: back/forward replaces only the focused pane while secondary panes
  remain; refresh restores the saved layout and reconciles the URL; a new client deep link creates
  one pane; invalid saved state falls back safely; and the draft hero's project picker replaces
  only the pane that owns that draft.
- Performance pass: compare 1, 2, 4, and 8 panes and assert one connection supervisor per
  environment, one diff worker pool per workspace, no duplicate target subscriptions, and prompt
  resource cleanup after close.
- One primary-agent browser pass in the real web/desktop client, with before/after images for the
  PR after explicit browser permission is given.

## Delivery

Keep the pane implementation and official-data cutover in separate modules and commits so either
seam can be recovered after an upstream sync. They may ship in one coordinated T3 Turbo PR after
both tracks pass their focused tests and integrated verification.
