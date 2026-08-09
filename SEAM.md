# Upstream seam

`git show --name-status 774c53df b4904491` identifies 16 of these upstream-owned paths; the agent
docs (`AGENTS.md`, `CLAUDE.md`) were added to the seam later. The label is the nature of this
fork's change.

- **Prepended** `AGENTS.md` — the "T3 Turbo — how this branch operates" section above the upstream
  agent guide. On conflict, take the new upstream body and reapply the Turbo header verbatim.
- **Replaced** `CLAUDE.md` — Turbo preamble plus an explicit `@AGENTS.md` import (upstream ships a
  bare pointer). On conflict, keep the fork file.
- **Gated** `.github/workflows/deploy-relay.yml` — fork-safe credential detection, manual dispatch,
  and external-database/optional-service inputs.
- **Gated** `.github/workflows/release.yml` — release artifacts remain buildable when Connect is not
  configured.
- **Gated** `docs/operations/release.md` — documents the optional Connect release path.
- **Additive** `docs/operations/self-host-relay.md` — self-hosting runbook.
- **Optional** `infra/relay/.env.example` — external PostgreSQL settings and optional Axiom/APNs
  groups.
- **Optional** `infra/relay/alchemy.run.ts` — provider layers and tracing outputs exist only when
  configured.
- **Optional** `infra/relay/scripts/deploy.test.ts` — covers deployments without tracing outputs.
- **Optional** `infra/relay/scripts/deploy.ts` — accepts absent tracing outputs while retaining the
  relay URL requirement.
- **Optional** `infra/relay/src/Config.ts` — APNs is a complete optional group.
- **Additive** `infra/relay/src/agentActivity/AgentActivityPublisherApnsDisabled.ts` — an APNs-off
  `AgentActivityPublisher` layer that keeps upstream's row write verbatim and skips the delivery
  prep whose results the disabled delivery layer discards. On conflict, keep the fork file and
  re-copy upstream's `publish` row-write branch into it if that branch changed.
- **Additive** `infra/relay/src/agentActivity/AgentActivityPublisherApnsDisabled.test.ts` — proves
  the APNs-off publisher stores the same row and returns the same response as upstream's. On
  conflict, keep the fork file.
- **Optional** `infra/relay/src/agentActivity/ApnsDeliveries.test.ts` — adapts delivery tests to the
  optional APNs type.
- **Optional** `infra/relay/src/agentActivity/ApnsDeliveries.ts` — supplies the disabled APNs layer.
- **Additive** `infra/relay/src/agentActivity/ApnsDisabled.test.ts` — proves disabled delivery is a
  no-op.
- **Gated** `infra/relay/src/db.ts` — a complete `DATABASE_*` group selects external PostgreSQL;
  otherwise the upstream PlanetScale path remains.
- **Additive** `infra/relay/src/deploymentConfiguration.test.ts` — covers complete and absent
  provider groups.
- **Optional** `infra/relay/src/observability.ts` — Axiom resources require the complete pair.
- **Optional** `infra/relay/src/worker.ts` — APNs queues and tracing layers are conditional, and the
  same `apnsDeliveryQueueSender === null` test that picks `ApnsDeliveries.layerDisabled` also picks
  `AgentActivityPublisherApnsDisabled.layer` over `AgentActivityPublisher.layer`. On conflict, take
  upstream's `runtimeLayer` and re-swap only that one `Layer.provideMerge` argument for
  `agentActivityPublisherLayer`.
- **Tuned** `infra/relay/src/environments/EnvironmentConnector.ts` —
  `ENVIRONMENT_MINT_REQUEST_TIMEOUT_MS` is 7s so the mint budget can actually expire inside the
  relay's 9s `RELAY_REQUEST_DEADLINE_MS`; upstream's 10s never fires. On conflict, keep the
  upstream timeout machinery and re-set only that constant; never raise it to or above the
  request deadline.
- **Tuned** `infra/relay/src/http/Api.ts` — the Clerk OAuth fallback reuses one
  `createClerkClient` instance per relay configuration (`clerkOAuthClient`, a `WeakMap` keyed on
  the config service) instead of building one per request. On conflict, take the upstream
  `verifyClerkOAuthBearerToken` body and re-swap only the inline `createClerkClient({...})` call
  for `clerkOAuthClient(config)`; the session-JWT path, the fallback order, the client options,
  and the `ClerkTokenVerificationFailed` mapping stay as upstream ships them.
- **Tuned** `apps/server/src/persistence/Layers/Sqlite.ts` — the shared `setup` layer adds
  `PRAGMA synchronous = NORMAL;` (the standard WAL companion) after the existing `foreign_keys`
  and `journal_mode` pragmas. On conflict, take the upstream `setup` body and re-add only the
  `synchronous` line, still after `journal_mode`; never change the other two pragmas.
- **Additive** `apps/server/src/persistence/Layers/SqlitePragmas.test.ts` — asserts the pragma is
  live on fresh in-memory and file-backed connections. On conflict, keep the fork file.
- **Tuned** `apps/web/src/session-logic.ts` — `compareIsoTimestamps` replaces
  `String.prototype.localeCompare` at the timestamp comparison sites (pending approvals, pending
  user inputs, both proposed-plan picks, timeline order, checkpoint turn counts); it now lives in
  `packages/client-runtime/src/state/threadActivityOrder.ts` and is imported. The local
  `compareActivitiesByOrder`/`compareActivityLifecycleRank` pair and the five
  `toSorted(compareActivitiesByOrder)` re-sorts inside the activity derivations are gone — the
  derivations take canonical order as a precondition and `ChatView` sorts once at the boundary.
  On conflict, take the upstream comparator bodies and re-swap only the timestamp operands, then
  re-delete the activity re-sorts; never touch the `id.localeCompare` tiebreaks — ids are not
  fixed-width and the collation decides real ordering there.
- **Additive** `packages/client-runtime/src/state/threadActivityOrder.ts` — the ONE canonical
  activity comparator (`sequence`, with un-numbered legacy rows first, then `createdAt`, then
  lifecycle phase, then id) plus `compareIsoTimestamps`. Shared by the store, the older-page
  merge, web, and mobile; it is loaded by mobile, so it must stay Hermes-safe. On conflict, keep
  the fork file.
- **Additive** `packages/client-runtime/src/state/threadActivityOrder.test.ts` — pins the
  missing-sequence convention and the phantom-pending-approval tie (resolved stays after
  requested). On conflict, keep the fork file.
- **Tuned** `packages/client-runtime/src/state/threadReducer.ts` — the local `activityOrder`
  combinator is replaced by the shared `threadActivityOrder` (it now also carries the lifecycle
  tiebreak, and un-numbered rows sort first instead of last). On conflict, keep the upstream
  reducer body and re-point only the `Arr.sort` argument.
- **Tuned** `packages/client-runtime/src/state/threads.ts` — `mergeOlderPage` runs its merged
  `activities` through `sortThreadActivities`, because consumers no longer re-sort defensively.
  On conflict, keep the upstream merge and re-wrap only that one field.
- **Tuned** `apps/web/src/components/ChatView.tsx` — one memoized `sortThreadActivities` call
  feeds all five activity derivations (the way mobile's `use-selected-thread-requests` already
  does) instead of each derivation sorting the full history itself. On conflict, keep the
  upstream `useMemo` set and re-point the arguments at the sorted array.
- **Tuned** `apps/mobile/src/lib/threadActivity.ts` — the local `activityOrder` /
  `compareActivityLifecycleRank` pair is replaced by a re-export of the shared
  `sortThreadActivities`. On conflict, delete the upstream local comparator again rather than
  keeping two.
- **Tuned** `apps/server/src/persistence/Layers/ProjectionThreadActivities.ts` and
  `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — both activity `ORDER BY`
  clauses carry the lifecycle-rank `CASE` (started → 0, completed/resolved → 2, else 1) between
  `created_at` and the id, so the SQL emits the same total order as the shared comparator. On
  conflict, take the upstream `ORDER BY` and re-insert only that `CASE`; leave the NULL-sequence
  handling alone (SQLite's NULLs-first under ASC is the convention).
- **Tuned** `apps/web/src/components/Sidebar.logic.ts` — `sortThreadsForSidebar` and
  `sortSettledThreadsForSidebar` are decorate-sorts: the sort key is resolved once per row instead
  of inside the comparator. On conflict, take the upstream comparator verbatim and re-wrap it in
  the decoration; the comparator body, the `id.localeCompare` tiebreak, and the pinned-thread
  ordering path must stay as upstream ships them.
- **Tuned** `packages/client-runtime/src/state/threadSort.ts` — the keyless half of
  `sortPinnedThreadsByOrderKey` orders by plain `createdAt` string comparison instead of a
  `Date.parse` pair per comparison; this file is shared with mobile, so keep it Hermes-safe. On
  conflict, keep the upstream keyed sort and `identityTiebreak` untouched and re-apply only the
  keyless comparator.
- **Additive** `packages/client-runtime/src/state/threadSortPinnedKeyless.test.ts` — pins the
  keyless pinned order against the pre-swap implementation, ties included. On conflict, keep the
  fork file.
- **Tuned** `packages/contracts/src/baseSchemas.ts` — `TrimmedString` uses the pure
  `SchemaTransformation.transform` instead of `transformOrFail`, and `ForwardCompatibleArray`
  decodes each element once (keeping the decoded value and targeting `Schema.toType(...)`) instead
  of decoding once to test and again in the target. On conflict, take the upstream bodies and
  re-apply both swaps. Two invariants are non-negotiable: the trim must run on **both** `decode`
  and `encode` — never substitute `SchemaTransformation.trim()`, which trims on decode only — and
  `ForwardCompatibleArray` must keep per-element drop-on-failure plus its `Effect.logDebug` line.
- **Additive** `packages/contracts/src/turbo/baseSchemas.test.ts` — pins both-directions trimming
  (including the encode-without-decode path), per-element drop-on-failure, and the single-decode
  count. On conflict, keep the fork file.
- **Tuned** `packages/client-runtime/src/state/terminalSession.ts` — `TerminalBufferState` carries
  a running `bufferBytes` count, and `applyTerminalAttachStreamEvent` only re-encodes the buffer
  once the total passes `cap + TERMINAL_BUFFER_TRIM_SLACK_RATIO * cap`, then trims back down **to**
  the cap. On conflict, take the upstream reducer and re-apply three things: `bufferBytes` must stay
  a field on the state object (the reducer is handed to `Stream.scan` by reference, so a parameter
  would silently unbind), the over-threshold branch must trim to the cap rather than dropping a
  chunk, and `trimBufferToBytes` must keep its continuation-byte safety loop. This file is shared
  with mobile, so keep it Hermes-safe — the byte count uses a `charCodeAt` loop, not `TextEncoder`.
- **Tuned** `apps/web/src/components/ChatMarkdown.tsx` — the `pre` renderer wraps its Shiki subtree
  in `StreamingCodeBlockFrame` (`apps/web/src/turbo/streamingCodeBlock.tsx`), so a streaming fence
  shows a line-counted placeholder inside the block frame and is highlighted exactly once, when the
  message completes. On conflict, take the upstream `pre` body verbatim and re-wrap it: the
  `RenderErrorBoundary`/`Suspense`/`SuspenseShikiCodeBlock` subtree becomes the `highlighted` prop
  and upstream's own `<pre {...props}>{children}</pre>` fallback becomes `partialText`. The wrapper
  must stay _inside_ `MarkdownCodeBlock` — the copy button and wrap toggle live on that frame and
  must keep working on the partial text.
- **Additive** `apps/web/src/turbo/streamingCodeBlock.tsx` — the placeholder, the cheap line count,
  and the stall fallback. On conflict, keep the fork file.
- **Additive** `apps/web/src/turbo/streamingCodeBlock.test.tsx` — pins the three guards. On
  conflict, keep the fork file.

## Nightly sync conflicts

Resolve against the new upstream file first, then reapply only the behavior above; never take the
fork's whole file over a newer upstream implementation. Drop a fork hunk when upstream now provides
equivalent gating or optionality. Preserve the PlanetScale fallback, the Cloudflare credential
gates, and the all-or-nothing `DATABASE_*`, Axiom, and APNs groups. Re-run the focused relay tests
and compare workflow variable/secret names after every conflict. Never use a credential, generated
state, or production output to resolve a conflict.
