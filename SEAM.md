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
  the config service) instead of building one per request, and `verifyRelayClientBearerToken`
  wraps upstream's fallback chain (kept verbatim as
  `verifyRelayClientBearerTokenUncached`) in a per-isolate memo of **successful** verifications.
  On conflict, take the upstream `verifyClerkOAuthBearerToken` body and re-swap only the inline
  `createClerkClient({...})` call for `clerkOAuthClient(config)`, then re-wrap the upstream
  chain in the memo; the session-JWT path, the fallback order, the client options, and the
  `ClerkTokenVerificationFailed` mapping stay as upstream ships them. Four memo invariants are
  non-negotiable: 30s cap, never past the token's own expiry, keys are the SHA-256 digest of the
  token (never the token), and failures are never remembered.
- **Tuned** `infra/relay/src/environments/EnvironmentLinks.ts` — `getForUser` and `listForUser`
  answer from a 5s per-isolate memo of positive results; writes in this service drop their own
  entries as a best effort. On conflict, keep the upstream query pipelines verbatim and re-add
  only the memo read before them and the memo write after them. Never extend this memo to
  `ManagedEndpointAllocations.get` (its record carries the compare-and-swap token that detects a
  racing provision during unlink) or to `EnvironmentCredentials.authenticate` (the
  instant-revocation enforcement point), and never remember a missing link.
- **Additive** `infra/relay/src/turbo/clientTokenVerificationMemo.test.ts` — pins the memo's
  expiry cap, hash keying, failure handling, and the preserved OAuth fallback. On conflict, keep
  the fork file.
- **Additive** `infra/relay/src/turbo/environmentLinkLookupMemo.test.ts` — pins the 5s link
  window and proves the allocation and credential lookups still reach the database every time.
  On conflict, keep the fork file.
- **Tuned** `infra/relay/src/http/Api.test.ts` — comment only: records that the shared
  `relaySettings` object is the WeakMap key, so a second OAuth-path test needs its own settings
  object or it silently reuses the first test's mocked client. On conflict, re-add the comment.
- **Additive** `infra/relay/src/turbo/relayRequestBudget.test.ts` — asserts the relation the tuning
  exists for: `ENVIRONMENT_MINT_REQUEST_TIMEOUT_MS < RELAY_REQUEST_DEADLINE_MS`. On conflict, keep
  the fork file.
- **Tuned** `apps/server/src/persistence/Layers/Sqlite.ts` — the shared `setup` layer adds
  `PRAGMA synchronous = NORMAL;` (the standard WAL companion) after the existing `foreign_keys`
  and `journal_mode` pragmas. On conflict, take the upstream `setup` body and re-add only the
  `synchronous` line, still after `journal_mode`; never change the other two pragmas.
- **Additive** `apps/server/src/persistence/Layers/SqlitePragmas.test.ts` — asserts the pragma is
  live on fresh in-memory and file-backed connections. On conflict, keep the fork file.
- **Tuned** `apps/server/src/terminal/Manager.ts` — a terminal session's scrollback is a
  `TerminalHistoryBuffer` (line list, incremental cap, ~16 ms output batch) instead of
  `history: string` + `pendingHistoryControlSequence`, so a burst no longer chops and re-glues the
  whole ~5,000-line buffer per chunk. On conflict, take the upstream Manager and re-apply five
  things: `historyBuffer` replaces both fields; every scrollback read goes through
  `readTerminalHistoryBuffer` (it flushes the batch first, which is what keeps snapshots and
  `persistHistory` byte-identical); the drain loop's output branch only calls
  `queueTerminalHistoryChunk` + `queueHistoryBatch`; exit and `stopProcess` call
  `endTerminalHistoryStream` and persist whatever `takeTerminalHistoryToPersist` returns; and
  `flushPersist` drains `historyBatchWorker` **before** `persistWorker`. Upstream's
  `sanitizeTerminalHistoryChunk` is also exported so the fork-owned byte-identity test can drive the
  real sanitizer — keep the export. Three invariants are non-negotiable: output events must stay
  one-per-PTY-chunk with their own `data` and sequence (batching is history-side only — clients and
  the ordering tests depend on the per-chunk wire shape); the batch must be a
  `makeKeyedCoalescingWorker` so `drainKey` keeps the repo's "wait on drains, never sleep" test
  discipline working; and the persist decision must read the buffer's `dirtySincePersist` flag via
  `takeTerminalHistoryToPersist`, never "did this flush append" — any scrollback read flushes the
  batch, so a racing snapshot would otherwise leave the batch tick with nothing pending and the tail
  would never reach disk.
- **Additive** `apps/server/src/turbo/terminalHistoryBuffer.ts` — the incremental scrollback buffer
  itself: raw `split("\n")` lines, a memoized join, and the queued-chunk batch. On conflict, keep
  the fork file.
- **Additive** `apps/server/src/turbo/terminalHistoryBuffer.test.ts` — replays recorded PTY bursts
  through upstream's `capHistory` shape and the buffer and asserts byte equality, cap-trim
  boundaries and split control sequences included. On conflict, keep the fork file; if upstream
  changes `capHistory`, update the verbatim copy in this test to match.
- **Tuned** `apps/web/src/session-logic.ts` — `compareIsoTimestamps` replaces
  `String.prototype.localeCompare` at the timestamp comparison sites (pending approvals, pending
  user inputs, both proposed-plan picks, timeline order, checkpoint turn counts); it now lives in
  `packages/client-runtime/src/state/threadActivityOrder.ts` and is imported. The local
  `compareActivitiesByOrder`/`compareActivityLifecycleRank` pair and the five
  `toSorted(compareActivitiesByOrder)` re-sorts inside the activity derivations are gone — the
  derivations take canonical order as a precondition and `ChatView` sorts once at the boundary.
  `findLatestProposedPlan` takes a single-pass max (`latestProposedPlanBy`) instead of two
  copy-filter-sort-`at(-1)` pipelines; keep the `<= 0` in the max loop, which is what reproduces
  `.at(-1)`'s "last of an equal run".
  On conflict, take the upstream comparator bodies and re-swap only the timestamp operands, then
  re-delete the activity re-sorts; never touch the `id.localeCompare` tiebreaks — ids are not
  fixed-width and the collation decides real ordering there.
- **Additive** `packages/client-runtime/src/state/threadActivityOrder.ts` — the ONE canonical
  activity comparator for the four **client-visible** orderings (`sequence`, with un-sequenced
  rows LAST via `MAX_SAFE_INTEGER`, then `createdAt`, then lifecycle phase, then id compared by
  code unit) plus `compareIsoTimestamps`. Shared by the store, the older-page merge, web, and
  mobile; it is loaded by mobile, so it must stay Hermes-safe — never reintroduce `localeCompare`
  here, on the ids or anywhere else. The missing-sequence convention is load-bearing and easy to
  get backwards: un-sequenced is NOT a legacy-only population, because `CheckpointReactor`
  ("Checkpoint captured", every turn), `ws.ts`'s setup-script rows and `ProviderCommandReactor`'s
  error rows all append with no sequence on live threads. Sinking them is what the store reducer
  and mobile always did and therefore what the rendered timeline has always shown; hoisting them
  puts every turn's checkpoint row above the thread's first activity. On conflict, keep the fork
  file.
- **Additive** `packages/client-runtime/src/state/threadActivityOrder.test.ts` — pins the
  missing-sequence convention (including a mixed thread whose live checkpoint row must land at the
  END) and the phantom-pending-approval tie (resolved stays after requested). On conflict, keep
  the fork file.
- **Additive** `apps/server/src/turbo/threadActivityOrderEquivalence.test.ts` — the drift guard
  for the four shipped `ORDER BY` copies: each clause must appear verbatim in its source file AND
  must return exactly `sortThreadActivities(corpus)` when run over a generated corpus in an
  in-memory SQLite. It reaches the comparator by relative path because `apps/server` does not
  depend on `@t3tools/client-runtime`. On conflict, keep the fork file; if upstream rewrites an
  `ORDER BY`, update the matching entry in `SHIPPED_CLAUSES` rather than deleting the test.
- **Tuned** `packages/client-runtime/src/state/threadReducer.ts` — the local `activityOrder`
  combinator is replaced by the shared `threadActivityOrder` (it now also carries the lifecycle
  tiebreak; the `?? Number.MAX_SAFE_INTEGER` missing-sequence convention is unchanged from
  upstream). On conflict, keep the upstream reducer body and re-point only the `Arr.sort`
  argument.
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
  `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — **all four** activity
  `ORDER BY` clauses (`listProjectionThreadActivityRows`, and `listThreadActivityRows`,
  `listThreadActivityRowsByThread`, `listThreadActivityRowsByThreadWindow`) carry the identical
  pair of `CASE`s so the SQL emits the same total order as the shared comparator:
  `CASE WHEN sequence IS NULL THEN 1 ELSE 0 END ASC` (un-sequenced rows LAST — mandatory, because
  SQLite defaults to NULLs-FIRST and a bare `sequence ASC` disagrees with the comparator), then
  `sequence`, then `created_at`, then the lifecycle-rank `CASE` (started → 0, completed/resolved
  → 2, else 1), then `activity_id ASC` under the BINARY collation — which is why the shared
  comparator's id tiebreak is code-unit and not `localeCompare`. The last two of those four feed
  `getThreadDetailById`, the primary thread-detail snapshot, so a copy missing a `CASE` shows up
  as a mis-ordered thread rather than a test failure. On conflict, take the upstream `ORDER BY`
  and re-insert both `CASE`s into every copy;
  `apps/server/src/turbo/threadActivityOrderEquivalence.test.ts` is the mechanical guard and will
  name whichever copy drifted.
  Scope note for a future rebaser: the unification covers the **four client-visible** orderings
  (store, web view layer, mobile, and these projection queries). A **fifth** activity comparator
  lives in upstream `apps/server/src/orchestration/projector.ts:171-186` — deliberately left
  alone. It only decides which rows survive the `.slice(-500)` truncation window at
  `projector.ts:790` and never reaches a client. It orders un-sequenced rows FIRST, which is the
  opposite of the shared comparator; that is tolerable precisely because it only picks a
  truncation window, but it does mean a very long thread's un-sequenced rows are the first to be
  dropped. Do not "fix" it during a rebase, and do not read this seam as a claim that every
  activity sort in the repo runs the shared comparator.
- **Tuned** `apps/web/src/components/Sidebar.logic.ts` — `sortThreadsForSidebar`,
  `sortSettledThreadsForSidebar`, and the fork-added `sortSnoozedThreadsForSidebar` are
  decorate-sorts: the sort key is resolved once per row instead of inside the comparator, and the
  settled key goes through the file's own NaN-sinking `parseTimestampMs`. On conflict, take the
  upstream comparator verbatim and re-wrap it in the decoration; the comparator body, the
  `id.localeCompare` tiebreak, and the pinned-thread ordering path must stay as upstream ships
  them.
- **Tuned** `apps/web/src/components/Sidebar.tsx` (timestamp seam) — the snoozed shelf calls
  `sortSnoozedThreadsForSidebar` instead of resolving `firstValidTimestampMs` inside an inline
  comparator. On conflict, keep upstream's bucket partition and swap only that one `toSorted` call;
  the ordering rule (soonest wake first, no id tiebreak) must not change.
- **Tuned** `packages/client-runtime/src/state/threadSort.ts` — the keyless half of
  `sortPinnedThreadsByOrderKey` orders by plain `createdAt` string comparison when
  `isCanonicalIsoTimestamp` accepts BOTH operands, and otherwise falls back to the upstream
  `Date.parse` pair with its NaN-sinks-to-epoch behavior; this file is shared with mobile, so keep
  it Hermes-safe. On conflict, keep the upstream keyed sort and `identityTiebreak` untouched and
  re-apply only the keyless comparator — never drop the fallback branch, `IsoDateTime` is
  `Schema.String` and a malformed stamp must keep sinking to the bottom of the block.
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
  The encode path must also keep wrapping a failing element's issue in a
  `SchemaIssue.Pointer([index], …)` — the `Schema.Array` target it replaced put the index in the
  path for free, and losing it makes a bad element in a large config unlocatable from logs.
- **Additive** `packages/contracts/src/turbo/baseSchemas.test.ts` — pins both-directions trimming
  (including the encode-without-decode path), per-element drop-on-failure, the failing element's
  index in the encode error path, and the single-decode count. On conflict, keep the fork file.
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
- **Tuned** `packages/client-runtime/src/rpc/client.ts` — `subscribeToSession` wraps the session's
  RPC stream in `poolWithinFrame`, a 16 ms pool that releases a window's arrivals as one chunk, so
  a burst costs the screen one blip per frame instead of one per item. On conflict, take the
  upstream `subscribeToSession` body and re-wrap only its `method(input)` call. Three things are
  non-negotiable: the pool must stay **inside** `subscribeToSession` so it is created and shut down
  with the session — a pool downstream of the `Stream.switchMap` lets a dead session's leftovers
  flush over the reconnect snapshot, which is not sequence-guarded; the `flushesImmediately`
  bypass must keep releasing the `synchronized` marker without waiting out the window; and the
  window stays 16 ms — approval prompts ride these same subscriptions. A fourth rule is about the
  collector loop rather than the placement: the window sleep ends that loop by interrupting it, so
  the take-and-append pair stays inside `Effect.uninterruptibleMask` with only the parked
  `Queue.take` restored. Never drop the mask — a take that has already removed an item must not be
  preemptible before the append, or a window boundary silently drops one item per boundary.
- **Additive** `packages/client-runtime/src/turbo/streamPoolTestClock.ts` — `awaitPooled` steps the
  virtual clock one pool window at a time while a test waits, stops as soon as the wait resolves,
  and dies with a diagnostic after 12 windows rather than hanging. It imports the window from
  `rpc/client.ts` instead of restating it. On conflict, keep the fork file; if the retry backoff in
  the suites it serves ever drops below 250 ms, lower `MAX_POOL_WINDOWS` to stay under it.
- **Additive** `packages/client-runtime/src/turbo/streamPool.test.ts` — pins the placement (a dead
  session's pooled items never apply after the replacement session's snapshot), the immediate
  `synchronized` release, the one-chunk-per-window shape, and zero drops at a hammered window
  boundary. On conflict, keep the fork file.
- **Tuned** `packages/client-runtime/src/state/threads-sync.test.ts`,
  `packages/client-runtime/src/state/threads-pagination.test.ts`,
  `packages/client-runtime/src/state/shell-sync.test.ts`, and
  `packages/client-runtime/src/state/server.test.ts` — the virtual-clock waits that expect a
  subscription item to reach state go through `awaitPooled`. On conflict, take the upstream wait
  verbatim and re-wrap it; never swap the wrap for a fixed `TestClock.adjust`, because
  `awaitPooled` stops stepping the moment the wait resolves and that is what keeps the 250 ms
  retry and 500 ms persistence assertions in these files honest.

## Nightly sync conflicts

Resolve against the new upstream file first, then reapply only the behavior above; never take the
fork's whole file over a newer upstream implementation. Drop a fork hunk when upstream now provides
equivalent gating or optionality. Preserve the PlanetScale fallback, the Cloudflare credential
gates, and the all-or-nothing `DATABASE_*`, Axiom, and APNs groups. Re-run the focused relay tests
and compare workflow variable/secret names after every conflict. Never use a credential, generated
state, or production output to resolve a conflict.
