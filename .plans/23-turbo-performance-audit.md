# Turbo performance audit — 2026-08-09

Four parallel read-only audits (server, web client, relay Worker, shared client runtime) of the
T3 Turbo stack at turbo tip `4b2bd877`. Ranked by user-noticeable impact. Nothing here has been
implemented yet. Ownership column matters: **fork** = change freely; **upstream** = needs a
`SEAM.md` + manifest entry to survive the nightly rebase, *or* is a candidate to PR upstream
(small focused perf fixes are what upstream accepts, and gfsaaser24 is now vouched).

## The four systemic problems

1. **Streaming does O(whole-thread) work per delta, on both sides of the wire.** The server
   re-reads entire thread history per projected event; the client re-sorts the entire activity
   array up to six times per event and re-tokenizes entire code fences per delta. This is why
   long sessions get progressively slower.
2. **Terminal output is quadratic on both sides.** Server rebuilds a ~400 KB scrollback string
   per PTY chunk; client re-encodes a 512 KB buffer per output frame. This is why noisy builds
   freeze things.
3. **The relay pays cross-continent Postgres round trips for work that is disabled or
   cacheable.** Hyperdrive caching is off (correctly), but no in-Worker caching replaced it,
   and the APNs fan-out still runs its queries with delivery stubbed to no-op.
4. **No coalescing between the socket and React.** Every delta is one lock acquisition, one
   atom write, one render. Batching to animation-frame granularity divides most client costs
   by 3–5×.

## Server (apps/server) — ownership: upstream unless noted

| # | Finding | Where | Impact |
|---|---------|-------|--------|
| S1 | Every projected event re-reads ALL messages+activities+plans+approvals of the thread to compute 4 scalars; the coalescing/deferral path is dead code in live processing (context never passed) | `orchestration/Layers/ProjectionPipeline.ts:562-616,886-957,1666-1676` | P0 — the "long thread gets slow" bug; ~5k row decodes per event on big threads |
| S2 | Terminal scrollback rebuilt per PTY chunk: full split/join of ~5,000-line string, plus full-history persist enqueue per chunk | `terminal/Manager.ts:855-865,1717-1720,1768-1770,1930` | P0 — ~80 MB/s string churn during builds; stalls event loop |
| S3 | 9 SQL savepoints + 9 `projection_state` writes per event, even when 7–8 projectors no-op | `orchestration/Layers/ProjectionPipeline.ts:1626-1685,1770-1781` | P0 — 2,700 bookkeeping writes per 300-event turn on the single command worker |
| S4 | SQLite has WAL but default `synchronous=FULL`, no busy_timeout/cache_size/temp_store | `persistence/Layers/Sqlite.ts:33-40` | P1 — every commit fsyncs; **best impact-to-risk in the whole audit (one line)** |
| S5 | `getThreadDetailById` loads the entire unwindowed thread several times per turn for small predicates | `ProviderRuntimeIngestion.ts:931-935,1697-1826`, `ProjectionSnapshotQuery.ts:2370-2523` | P1 — O(thread) per assistant message |
| S6 | Shell subscription refetches projections per aggregate × per client every 50 ms window (no shared fan-out) | `ws.ts:604-718,1183-1289` | P1 — 3 clients × 3 threads ≈ 180 identical queries/sec |
| S7 | Unbounded snapshots: `listActiveThreadRows` has no LIMIT; pre-pagination clients get full thread | `ProjectionSnapshotQuery.ts:443-470,1813-1954`, `ws.ts:1391-1399` | P1 — multi-hundred-KB frames on connect |
| S8 | ~9 git subprocesses per checkpoint capture; full unified diff computed eagerly just for a filename summary | `vcs/GitVcsDriver.ts:655-741`, `CheckpointReactor.ts:262-272` | P2 — per-turn latency tail |
| S9 | Turn diffs re-shelled to git on every request; `checkpoint_diff_blobs` cache table exists but only the Turbo import uses it | `checkpointing/CheckpointDiffQuery.ts:167-265`, `Migrations/003` | P2 — diffs are immutable, trivially memoizable |
| S10 | Positives: buffered assistant delivery already avoids per-token DB writes; projection indexes are good | — | — |

## Web client (apps/web) — ownership: upstream unless noted

React Compiler is on — the levers are store granularity, per-event algorithmic cost, and
continuous paint, not manual memo.

| # | Finding | Where | Impact |
|---|---------|-------|--------|
| W1 | Shiki re-tokenizes the entire growing code fence on every streaming delta (cache bypassed while streaming), synchronously in render | `ChatMarkdown.tsx:670,705-730` | P0 — quadratic; the most expensive thing during streaming |
| W2 | Activity array fully filtered+copied+re-sorted per activity event in the reducer... | `client-runtime/state/threadReducer.ts:563-592` | P0 — O(n log n) per event, n grows all session |
| W3 | ...then re-sorted 5 MORE times in view-layer derives keyed on array identity (6 sorts of same data per event) | `session-logic.ts:390,496,586,619,748`, `ChatView.tsx:2178-2193` | P0 — pure deletion available: reducer output is already sorted |
| W4 | Timeline rebuild per delta uses `localeCompare` (ICU) on ISO timestamps — plain `<`/`>` is equivalent and 10-30× cheaper | `session-logic.ts:1573-1606` | P1 — ~22k ICU calls per delta at 2k entries |
| W5 | Streaming concat: linear find + full array map per delta | `threadReducer.ts:298-317` | P1 — multiplied away by rAF coalescing |
| W6 | `ultrathink` composer animations: 4 infinite animations on non-composited props (`background-position`, `hue-rotate`, masked gradients, `background-clip:text`) — no steps() duty cycle, no reduced-motion, run while idle | `index.css:2091-2176`, `composerProviderState.tsx:75-77` | P0 for GPU — 165 repaints/sec at rest on high-refresh; the exact failure the maintainers duty-cycled elsewhere (`index.css:145-148`) |
| W7 | Each thinking orb installs a document-wide subtree MutationObserver because `theme` prop is never passed (explicit theme returns early before observing) | `turbo/orbs/TimelineOrb.tsx:38,68` — **fork-owned seam** | P1 — ~3-line fix; kills N whole-document observers |
| W8 | Concurrent orbs: independent rAF loops × ~306 canvas arcs each, uncapped fps (lib already gates offscreen/hidden correctly) | `TimelineOrb.tsx`, thinking-orbs lib | P2 — cap to 30 fps |
| W9 | Any thread shell update rebuilds whole array → invalidates the sidebar's 28-memo chain during other threads' streaming | `client-runtime/state/shellReducer.ts:31-36`, `Sidebar.tsx:1578-1949` | P1 |
| W10 | Sidebar comparator calls Date.parse inside sort → ~40k parses per sort, re-runs per shell upsert | `Sidebar.logic.ts:552-585,886,921` | P1 — decorate-sort-undecorate |
| W11 | 5.27 MB eager entry chunk; zero route-level splitting (23 route files, no createLazyFileRoute); Clerk/Ghostty/Lexical all eager; 975 KB "textarea" chunk unexplained | `vite.config.ts:259-263`, `routes/*` | P0 for cold start — settings/usage routes are mechanical splits |
| W12 | Positives: timeline virtualized, elapsed-time labels bypass React, status pulses duty-cycled, Shiki grammars split 384 ways, terminal renderer coalesces to one rAF | — | — |

## Relay (infra/relay) — control plane only; WS data traffic already bypasses it

| # | Finding | Where | Impact |
|---|---------|-------|--------|
| R1 | `publishAgentActivity` (busiest endpoint) does 4+2N sequential WAN round trips of which 1+2N only feed the DISABLED APNs layer | `agentActivity/AgentActivityPublisher.ts:56-172` (upstream) — fix wires from fork-owned `worker.ts` | P0 — ~2× latency + 3× DB load on hottest call; fits existing `apns===null` fork pattern |
| R2 | Every DPoP request does a synchronous WAN Postgres INSERT (replay nonce) before any work — even pure reads | `auth/DpopProofs.ts:53-81`, `http/Api.ts:1240-1280` (upstream) | P1 — Durable Object keyed by thumbprint is the correct fix; highest ceiling, most effort |
| R3 | CLI bearer auth: try-Clerk-JWT-then-fallback wastes a verify, then UNCACHED `api.clerk.com` introspection per request; `createClerkClient` constructed per request | `http/Api.ts:1167-1227` (upstream) | P1 — biggest win for `t3 connect` CLI feel |
| R4 | Hyperdrive caching off + no in-Worker caching: link/allocation/credential lookups (change only on link/revoke) re-read cross-continent per request | `db.ts` (fork), `environments/*` (upstream) — do as decorating layers from `worker.ts` | P1 |
| R5 | BUG: inner mint timeout 10s > outer request deadline 9s → typed "environment offline/timed-out" errors unreachable; users get generic 504 at 9s | `http/Api.ts:167`, `EnvironmentConnector.ts:129` (upstream) | P1 — one-line constant change |
| R6 | Footgun documented: never pass raw drizzle lazy-proxy chains to `Effect.all` — pegs the isolate at 100% CPU (`agentActivity/Devices.ts:84-88`) | — | note for all relay work |
| R7 | Cold start: full `@clerk/backend` REST client (~272 KB) parsed for routes that never touch Clerk; measure bundle before/after any fix | `http/Api.ts:1` | P2 — measure first |
| R8 | Verified clean: indexes correct, no N+1, no queues created in this fork, no top-level await, per-isolate connection reuse correct | — | — |

## Client runtime / wire (packages/client-runtime, packages/contracts)

| # | Finding | Where | Impact |
|---|---------|-------|--------|
| C1 | Terminal buffer: full 512 KB TextEncoder.encode per output frame to measure length + per-frame atom write | `state/terminalSession.ts:65-141`, `state/terminal.ts:40-46` | P0 — worst client-runtime hot path; track byte length incrementally |
| C2 | No batching socket→React: per-delta semaphore + ~6 ref ops + 1 render; `Stream.groupedWithin(64,"16 millis")` collapses ~30 renders/sec to ~1/frame | `state/threads.ts:255-292,402-406` | P0 — multiplies most other client findings |
| C3 | Shell containers rebuilt O(all threads) per `thread-upserted` (which fires constantly during turns via planProgress/backgroundLiveness); leaf memoization is correct, containers aren't | `state/shellReducer.ts:31-36`, `state/threadShell.ts:45-173` | P1 |
| C4a | `TrimmedString` uses effectful transform → an Effect allocation per decoded string; thousands per snapshot; sync form exists in same file | `contracts/src/baseSchemas.ts:6-15` | P1 — wire-identical, benchmark then ship |
| C4b | `ForwardCompatibleArray` decodes every element twice (filter decodes + discards, outer decodes again) — full provider catalogue ×2 per config event | `contracts/src/baseSchemas.ts:31-46` | P1 — wire-identical |
| C5 | Shell + server-config snapshots re-serialized to cache every 500 ms during activity (thread path already guards while hot; these don't) | `state/shell.ts:94-178`, `state/server.ts:372-387` | P1 |
| C6 | Delta framing ~50× payload (500-700 B envelope for a 5-char token); own integration budget shows 68 KB decoded vs 8 KB wire per turn; **verify React Native negotiates permessage-deflate — if not, mobile pays 68 KB where web pays 8 KB (5-min check, biggest mobile win)** | `contracts/src/orchestration.ts:1221-1326`, `TransferBudgetReport.integration.ts:33-38` | P1 — compact delta event behind capability flag (pattern exists: `threadSnapshotPagination`) |
| C7 | `providerStatuses` re-sends entire provider catalogue (models+commands+skills) for a one-field status change, up to 5/s during probing | `contracts/src/server.ts:485-533` | P2 — delta payload behind capability flag |
| C8 | Every app foreground resubscribes ALL 15-25 subscriptions even when the socket probe succeeded | `connection/wakeups.ts:19-21`, `rpc/client.ts:191-201` | P1 — mobile battery/latency |
| C9 | Reconnect backoff caps at 16 s forever, no jitter — lockstep radio wakes across devices/environments when a server is off | `connection/supervisor.ts:32,104-106` | P2 |
| C10 | Sort comparators call Date.parse per comparison | `state/threadSort.ts:16-104` | P2 |
| C11 | Verified good: delta-based subscriptions with cursors used everywhere, HTTP-gzip snapshots, 10-turn first paint window, list subscriptions carry no bodies | — | — |

## Recommended attack plan

**Wave 1 — trivial, high yield, no behavior change:**
S4 (SQLite pragmas) · W3 (delete 5 redundant sorts) · W4 (drop localeCompare) · W7 (orb theme
prop — fork seam) · W6 (steps() on ultrathink keyframes) · R5 (timeout constant) · C6-check
(mobile deflate negotiation).

**Wave 2 — contained, addresses the two quadratic monsters + relay hot path:**
W1 (skip Shiki while streaming) · S2+C1 (terminal ring buffer server-side, incremental byte
count client-side) · C2 (rAF batching at stream boundary) · R1 (no-delivery publisher layer
wired from fork-owned worker.ts) · R3 (hoist Clerk client, short-TTL introspection memo).

**Wave 3 — bigger refactors, measure first:**
S1 (aggregate SQL + wire the deferral context) · S3 (event-type→projector map) · W11 (route
splitting) · C3/W9 (map-backed shell store) · C4 (schema decode) · S6 (shared shell fan-out) ·
R4 (decorating cache layers) · C6/C7 (compact delta contracts behind capability flags) · R2
(DPoP Durable Object).

**Strategy:** fork-owned surfaces (relay worker.ts layers, orbs, Turbo seams) we change
directly. For upstream-owned pure wins (S4, W3, W4, R5, C4), consider PRing upstream — small
focused perf fixes are exactly what they accept, it erases our seam-maintenance cost, and the
fork inherits the fix back through the nightly sync.
