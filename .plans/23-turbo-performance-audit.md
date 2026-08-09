# Turbo speed plan — 2026-08-09 (verified edition)

Four read-only audits (server, web app, relay, shared client code) found the items below. On
2026-08-09 a second, adversarial pass — four Opus 5 reviewers, one per surface — fact-checked
every claim against the code and hunted for collisions with existing functionality. **This
document is the post-verification version: every item's scope is what survived review.**

Verdict badges: ✅ verified safe as written · 🔧 verified, scope adjusted (the text below IS
the adjusted scope) · 🛑 original idea collided with something real — rescoped or dropped, the
collision is explained. A ⭐ still marks best bang-for-buck. Grey file paths are for the
implementer.

**What verification changed, in one paragraph:** the two "obviously safe" items were the
biggest surprises — deleting the five "redundant" sorts (W3) would have produced phantom
pending-approval badges because the codebase secretly has FOUR different sort orders, and the
relay cache (R4) would have silently orphaned Cloudflare tunnels because one "read" it cached
is actually a race-detection token. Both are salvaged below in safer forms. Several other
items got cheaper (W11 is one config line, not 23 file edits) or more honest (the relay DB
is in Ashburn; C6's mobile compression is "5 minutes to *measure*, unknown to fix").

---

## The theme in one paragraph

Turbo mostly doesn't have "slow code" — it has code that **repeats work**. When one new word
streams in, the app re-processes the whole conversation. When one line of build output
arrives, it rebuilds the whole terminal history. When the relay answers one request, it makes
database calls whose answers it throws away. Fix the repetition and the same hardware feels
twice as fast.

---

# Part 1 — The server (runs on your PC)

### ⭐ 🔧 S4. Turn on the database's "fast mode" — one line
- **The problem:** the database physically syncs the disk after *every* tiny save (thousands
  per turn). The standard "WAL + NORMAL" pairing every SQLite guide recommends is not set.
- **What we'd change:** add the standard pragma set in the one setup layer so every
  connection gets it uniformly. Honest wording per review: an *app* crash loses nothing; a
  *power loss / hard reset* can lose the very last saves (that's the accepted trade every
  desktop app makes). Don't touch `foreign_keys` or `journal_mode`.
- **The perf gain:** every single thing the server does gets faster at once.
- **Verified:** no second process shares the connection (official import and snapshots open
  their own), so the setting can't leak or conflict.
- <sub>`apps/server/src/persistence/Layers/Sqlite.ts:33-40`; confirm both the Bun and Node
  client loaders apply it to the whole pool</sub>

### ⭐ 🔧 S1. Stop re-reading the whole chat to update four little numbers — now split in two
- **The problem (confirmed exactly as claimed):** dozens of times per turn the server reloads
  *every* message and activity in a thread to recompute four sidebar numbers. Also confirmed:
  the batching machinery built to soften this is dead code on the live path.
- **What we'd change (adjusted):** review found only **three of the four numbers** are simple
  database questions. Part A (safe now): compute "latest user message," "pending approval
  count," and "has actionable plan" with direct queries. Part B (separate, bigger): "pending
  user-input count" is a stateful walk over activity history with string matching — it needs
  its own tracked column plus a migration, done carefully. The "just switch on batching" idea
  moves into S3, where it belongs.
- **The perf gain:** Part A alone removes most of the "long chats get slow" weight.
- <sub>`apps/server/src/orchestration/Layers/ProjectionPipeline.ts:562-616` — the
  `pendingUserInputCount` fold at `:140-184` is the hard part</sub>

### ⭐ 🔧 S2. Stop rebuilding the terminal's memory on every line of output
- **The problem (half confirmed):** the quadratic rebuild is real — every output burst chops
  and re-glues the ~5,000-line scrollback. But review found the *saving* half of the claim was
  wrong: disk writes are already nicely debounced (40 ms coalescing worker). The waste is
  memory churn, not disk.
- **What we'd change (adjusted):** keep scrollback as a list of lines with incremental
  capping; batch output ~16 ms before processing. Two guardrails from review: the final
  string handed to clients must be byte-identical (a second device restores scrollback from
  it), and the new batch buffer must flush inside the existing `flushPersist`/stop paths so
  the repo's "wait on drains, never sleep" test discipline keeps working.
- **The perf gain:** builds and test runs scroll smoothly; the rest of the app stays alive.
- <sub>`apps/server/src/terminal/Manager.ts:855-865, 1717-1720`; drain contract at
  `:1440-1456, 2028-2031`</sub>

### 🛑 S3. Skip the no-op bookkeeping — rescoped after a real collision
- **The collision review caught:** the client's reconnect position is computed as the
  **minimum** progress marker across the bookkeeping components. Naively skipping markers for
  components that don't care would freeze that minimum — and every reconnect would degrade to
  a full re-download. The "optimization" would have made reconnects *slower*.
- **The safe version:** skip the no-op *work* (don't run the 8 uninterested components'
  bodies) but keep advancing **all nine** progress markers, and collapse the nine separate
  mini-transactions into **one** transaction per event. Same speed win, no frozen markers.
- **The perf gain:** per-event database work drops to roughly a quarter; turns commit faster.
- <sub>`ProjectionPipeline.ts:1626-1685`; the watermark math that must not break:
  `ProjectionSnapshotQuery.ts:191-255`, `ws.ts:1244-1260`</sub>

### 🔧 S5. Answer small questions with small lookups — all-or-nothing
- **What review caught:** the full-thread load is already shared across **five** users inside
  one event via a memo — replacing just one of them *adds* a query while the big load still
  happens. Partial fix = net loss.
- **The safe version:** replace **all five** consumers with targeted lookups in one pass so
  the big load can be deleted outright. Same disease exists un-memoized in the checkpoint
  reactor — include it.
- **The perf gain:** turn processing stops scaling with conversation length.
- <sub>`ProviderRuntimeIngestion.ts:1480-1488` (the memo and its 5 call sites);
  `CheckpointReactor.ts:165-169` (the second instance)</sub>

### 🔧 S6. Compute sidebar updates once, share with every device — share the answer, not the pipe
- **What review caught:** each device's subscription carries personal state (its own resume
  position, its own "synchronized" marker) — the *streams* can't merge. But the expensive
  part — the database refetch — produces identical results for everyone and *can* be shared.
- **The safe version:** memoize the refetched row per (item, version) for the duration of one
  50 ms window, so N devices cost one read instead of N. Keep everything per-client otherwise.
- **The perf gain:** phone + desktop + browser together cost the same as one device.
- **Heads-up:** if C6/C7 (per-client compact formats) ever lands, this shared cache must key
  by capability — the two items must be designed together.
- <sub>`ws.ts:604-718` (refetch), `:1183-1287` (per-client state that stays)</sub>

### 🛑 S7. "Send the first page, not the filing cabinet" — server half DROPPED
- **The collision review caught:** the unlimited fallback is a **written compatibility
  promise** — a code comment guarantees full threads to pre-pagination clients *because they
  have no way to ask for more*. A server-side default limit would silently amputate history
  for every older client on every surface. That's a one-way door; not doing it.
- **What survives:** (a) make *our* clients always send their page-size preference (opt-in,
  which the contract already supports); (b) bounding the thread *list* on connect needs a new
  contract field rolled out with the compatibility-flag pattern — moved to Wave 3 beside
  C6/C7 where contract changes live.
- <sub>the promise: `ws.ts:1391-1399`; the opt-in machinery that already exists:
  `contracts/orchestration.ts:548-581`</sub>

### 🔧 S8. Cheaper end-of-turn diff summary (citation corrected)
- **What review corrected:** the plan pointed at checkpoint *capture* — which must stay eager
  (revert depends on it). The real cost is computing a **full text diff** at every turn end
  just to extract per-file add/delete counts.
- **The safe version:** add a stats-only diff variant (`--numstat`) for the summary — as a
  *new* method, since the patch-producing one is still needed by the diff panel — with binary
  files handled explicitly (numstat reports them differently). The summary must still be
  ready *before* the turn's completion receipts fire, or tests break.
- **The perf gain:** turns wrap up faster, especially in big repos.
- <sub>real sites: `CheckpointReactor.ts:262-295`, `GitVcsDriver.ts:784-845`</sub>

### 🛑 S9. Cache computed diffs — the "never changes" premise was false
- **The collision review caught:** "checkpoints are frozen so diffs never go stale" is wrong
  in one case: **revert**. Reverting deletes checkpoints and the next turn re-creates the
  same turn-numbers against a different tree — the cache key gets reused and would serve the
  *old* diff. Also: the cache table's key can't tell whitespace-sensitive from
  whitespace-ignoring requests, and the Turbo official import shares the same table.
- **The safe version (all three mandatory):** add whitespace mode to the cache key (new
  migration); delete cached rows past the revert point *in the same transaction* as the
  revert; register the shared-table ownership in the seam. Then the cache is sound.
- **The perf gain:** diff panel opens instantly after first view.
- <sub>`CheckpointDiffQuery.ts:167-265`; the revert path that invalidates:
  `CheckpointReactor.ts:785-797`; table: `Migrations/003`</sub>

---

# Part 2 — The web app (what you see)

### ⭐ 🔧 W1. Code blocks blip in complete — with three guards from review
- **The problem (confirmed):** streaming re-colors the whole growing code block from the top
  on every few characters, on the main thread. (One claim trimmed: the markdown parse itself
  isn't skipped by this — the win is the coloring + code DOM + reflow, still the lion's
  share.)
- **What we'd change (your scope + three review guards):** placeholder card while code
  streams; render once, fully colored, on completion. Guards: **(1)** the placeholder must
  grow with a cheap line count — a fixed-size card becoming a 400-line block in one frame
  makes the virtualized list visibly jump; **(2)** the placeholder lives *inside* the block
  frame so the copy button and wrap toggle keep working; **(3)** if the connection drops
  mid-block, fall back to showing the partial text — otherwise the card says "writing…"
  forever. One honesty note: "complete" means when the *message* finishes, not each fence —
  fine for the calm-card experience, worth knowing.
- **The perf gain:** per-word cost of code streaming ≈ zero; code-heavy turns become the
  app's lightest moment.
- **Mobile:** has its own, different version of this bug (spawns a highlight job per delta,
  each kept 5 minutes). Filed as a companion item — not silently ignored.
- <sub>`apps/web/src/components/ChatMarkdown.tsx:670, 705-730`; list-jump risk:
  `MessagesTimeline.tsx:577-591`; mobile twin:
  `apps/mobile/src/features/threads/markdownCodeHighlightState.ts`</sub>

### 🛑 W2+W3. The six-sorts fix — the "safest change in the plan" was a trap
- **The collision review caught (the best catch of the whole pass):** the six sorts are NOT
  sorting the same way. The codebase has **four divergent orderings** (store, web view-layer,
  mobile, server SQL) that disagree on (a) where rows *without* a sequence number go — and
  such rows genuinely exist, a migration added the column with no backfill — and (b)
  lifecycle order for ties. Deleting the five "redundant" re-sorts could make an approval's
  *resolved* event sort before its *requested* event → **phantom pending-approval badges**.
  Also: the "load older messages" merge path produces unsorted arrays that only those
  re-sorts currently fix.
- **The safe version (order matters):** 1) unify on ONE comparator — put lifecycle rank into
  the store's comparator, pick one convention for missing sequence numbers, align the server
  SQL; 2) make the older-page merge sort its output; 3) *then* delete the redundant re-sorts
  — or better, sort once at the boundary the way **mobile already does** (mobile solved half
  of this first; web is the laggard).
- **The perf gain:** unchanged — busy turns stop bogging the UI — it just takes a unification
  step first instead of being a naive deletion.
- <sub>the four orderings: `threadReducer.ts:32-36`, `session-logic.ts:1532-1557`, mobile
  `threadActivity.ts:1034-1039`, `ProjectionSnapshotQuery.ts:574-578`; unsorted merge:
  `threads.ts:411-444`</sub>

### ✅ W4. Compare timestamps the cheap way — verified safe, scope widened
- **Verified:** every timestamp in the product is minted the same fixed-width way
  (`toISOString`/`formatIso`), so plain string comparison is provably equivalent to the
  heavyweight routine. No mixed formats found anywhere on the wire.
- **Widened:** the same pattern exists at seven more sites in the same file plus the shared
  `threadSort.ts` — fixing the shared one upgrades **mobile for free**.
- **The perf gain:** a solid slice of per-word streaming cost, basically free.
- <sub>`session-logic.ts:1603` + `:437, :536, :657, :668, :1546, :1611`;
  `packages/client-runtime/src/state/threadSort.ts:240-254`</sub>

### W6 / W7 / W8 — SKIPPED (operator decision 2026-08-09). Glow and orbs stay as they are.

### 🔧 W9. Keyed thread store — real, but bigger than one line
- **What review caught:** the threads array is part of the **wire contract and the on-disk
  cache format** — it can't just become a Map. The fix is a client-local state shape (or a
  parallel keyed index) with consumers migrated deliberately. Also, several downstream caches
  already guard themselves — the blast radius was overstated, though still real.
- **The perf gain:** streaming in one chat stops making the whole sidebar re-derive.
- <sub>`shellReducer.ts:31-36`; the contract boundary: `contracts/orchestration.ts:486-491`;
  cache encoders: web `connection/storage.ts:490`, mobile `environment-cache-store.ts:131`</sub>

### ✅ W10. Precompute sidebar sort keys — verified safe, two sites added
- **Verified:** decorate-sort is correct here, and the pinned-thread manual ordering is a
  fully separate code path — no interaction. Review added the *active* bucket's sort (same
  bug, bigger list) and one site in shared code (fixes mobile too).
- **The perf gain:** big thread lists sort in a blink instead of parsing thousands of dates.
- <sub>`Sidebar.logic.ts:552-585` + `:509-517`; shared: `threadSort.ts:247-254`</sub>

### ⭐ 🔧 W11. Split the 5.3 MB bundle — cheaper AND harder than planned
- **Cheaper:** the router has a one-line option (`autoCodeSplitting: true`) that does the
  splitting automatically and even handles the one tricky route correctly — no 23 hand-made
  files.
- **Harder (review found the catch):** the app's *root layout* eagerly imports the settings
  tree, so route splitting alone won't evict it — the root's imports must be pruned too or
  the win shrinks a lot. Two more guards: turn on hover-preloading (or first click on
  Settings pays a visible load), and **test the desktop app explicitly** — it serves the app
  over a custom protocol where a missing chunk fails in a special way that has bitten before.
- **The perf gain:** the hosted app and desktop appear seconds earlier — still the biggest
  cold-start win, once the root imports are handled.
- <sub>`vite.config.ts:159` (`tanstackRouter()` — add the option), `router.ts:6-11` (add
  `defaultPreload: "intent"`), `routes/__root.tsx` (the eager import graph), desktop protocol:
  `ElectronProtocol.ts:112-148`</sub>

---

# Part 3 — The relay (control plane on Cloudflare; database = your `openclaw` box in Ashburn, Virginia)

Your chat traffic already bypasses the relay. Every relay question to its database is a hop
to the one Virginia box — the game is fewer trips. Review confirmed all four items' facts and
added the guardrails below. (R2 stays skipped by your decision.)

### ⭐ 🔧 R1. Stop preparing push notifications we never send
- **Verified:** the wasted queries are real, nothing consumes their results, and the mobile
  app's status view reads only the row the publisher *stores* — so the fix is exactly "keep
  the store, skip the prep." Empty delivery lists are already what every consumer sees today.
- **Adjustments from review:** gate the swap on the same "APNs is off" condition the fork
  already uses (never unconditional); keep the row write byte-identical; and my "zero
  upstream code touched" claim was wrong — the wiring file is seam-listed, so its SEAM.md
  entry gets updated and the new layer file registered. Fork-owned tests added alongside, not
  by editing upstream's.
- **The perf gain:** the relay's hottest call ~2× faster; DB load to about a third.
- <sub>`AgentActivityPublisher.ts:56-172`; wire from `worker.ts:200-215`; mobile reader that
  must keep working: `MobileRegistrations.ts:93-105`</sub>

### ⭐ 🔧 R5. Fix the mint timeout — one line, framing corrected
- **What review corrected:** the 9-second outer deadline is *deliberate* (it turns hangs into
  traceable errors before the phone gives up) — the plan's "backwards timeouts" framing was
  wrong. Exactly one constant is broken: the 10-second inner budget that can never finish.
- **The change:** set it to **7s** (not 6 — give the environment maximum budget under the
  deadline). Know the trade: the same constant governs health checks, where a
  waking-from-sleep tunnel that needs >7s now reads "offline" (today's failure retries;
  "offline" doesn't). Acceptable; revisit with a separate health constant if it annoys.
- **Prefer upstream:** this is a one-number correctness fix in Theo's code — textbook
  upstream PR; forking it means rebasing one number forever.
- <sub>`environments/EnvironmentConnector.ts:129` vs `http/Api.ts:167`</sub>

### 🔧 R3. Stop phoning Clerk every request — split in two
- **What review corrected:** the "wasted first check" is cheap local CPU, not a network trip
  — the real win is the *cache*, and the item splits: **Part A (zero-risk, do first):** build
  the Clerk client once instead of per-request — free win, ideal upstream PR. **Part B
  (security-adjacent, separate):** remember successful verifications — capped at **30s** (not
  60), keyed by token *hash*, successes only, never past the token's own expiry. Know the
  trade: a banned user keeps access up to 30s. Don't hard-branch on token shape (some Clerk
  configs issue JWT-shaped CLI tokens) — soft-detect but keep the fallback chain.
- **The perf gain:** CLI operations lose their per-request internet round trip.
- <sub>`http/Api.ts:1167-1227` (upstream-owned — seam entry or upstream PR)</sub>

### 🛑 R4. Remember nearly-static answers — shrunk hard after two real collisions
- **What review caught (this one would have hurt):** two of the three lookups I wanted to
  cache are not plain reads. **(a)** The allocation record carries a compare-and-swap token
  used to detect races during unlink — serve it stale and unlinking **silently orphans the
  Cloudflare tunnel and DNS record** while telling you it succeeded. **(b)** The credential
  check is the *deliberate* instant-revocation enforcement point — caching it lets an
  unlinked device keep publishing for the cache window, and a purge in one Cloudflare
  location doesn't reach the others. Also, my invalidation list had 3 of the actual **6**
  writers.
- **The safe version:** cache **only** the user-link lookups, 5 seconds max, accepting a ≤5s
  window after an unlink before status reflects it. Never cache allocations or credentials.
  Honest math: requests go 3 trips → 1 (the replay-protection write stays, since R2 is
  skipped) — still worth having, no longer the headline.
- <sub>safe to cache: `EnvironmentLinks.getForUser/listForUser`; never cache:
  `ManagedEndpointAllocations.get` (CAS at `:319-357`), `EnvironmentCredentials.authenticate`
  (revocation join at `:200-217`)</sub>

---

# Part 4 — Shared client plumbing (web + mobile)

### ⭐ 🔧 C1. Stop re-measuring the terminal buffer — with three implementation notes
- **Verified,** plus a bonus: past the cap, today's trimming defeats the terminal's
  incremental-draw check **every frame** → full repaint per frame. The fix removes that too —
  a bigger win than originally claimed.
- **Adjustments:** the running byte-count must live *in the state object* (the update
  function is passed by reference — a new parameter would silently unbind); trim **down to
  the cap** when a slack threshold is exceeded (not "drop a chunk" — phones render this
  buffer directly, don't let it balloon); keep the existing multi-byte-character safety loop;
  two tests assert exact-at-cap behavior and get rewritten with the change.
- <sub>`terminalSession.ts:65-141` (+ state shape at `:20-26`); the repaint bonus:
  `ThreadTerminalDrawer.tsx:809-816`; tests: `terminalSession.test.ts:112-134, 173-186`</sub>

### ⭐ 🔧 C2. Pool-and-blip — verified with one real trap and a decided window
- **Still true:** wire/protocol untouched; this only batches what already arrived before the
  screen processes it. The lock invariant review worried about is actually *stronger* under
  batching, provided each item still runs individually inside the batch.
- **The trap review caught:** on reconnect, the fresh snapshot bypasses the pool — then stale
  pooled leftovers from the *old* session flush on top of it, and snapshot-type items aren't
  sequence-guarded. **The pool must live inside the per-session stream** so it dies with the
  session. That one placement decision is the whole safety story.
- **Window decided by review: 16 ms** — not coarser — because **approval prompts ride this
  same stream**. A 250 ms pool on a modal that gates your agent, stacked on server batching
  and network, is felt. At 16 ms it's invisible and still collapses ~30 renders/sec to ~1 per
  frame. (Also: the "synchronized" connection marker should flush immediately.)
- **Cost review priced in:** ~20 existing tests use a virtual clock and will hang on the new
  timer until each gets a clock-advance — budgeted, mechanical.
- <sub>insertion point: *inside* `subscribeToSession` in `rpc/client.ts` (NOT downstream of
  it); the bypass: `threads.ts:614`, `shell.ts:223`; tests: `threads-sync.test.ts` et al.</sub>

### 🔧 C3. Keyed thread index — order is safe, the boundary is the cost
- **Verified:** nothing depends on array order (every consumer re-sorts) — that fear is
  retired. The real constraint: the array is a wire+cache format, so the keyed structure is a
  *parallel client-side index*, not a type swap. Hermes (mobile JS engine) lacks `.toSorted`
  — use the spread form in anything shared.
- <sub>`shellReducer.ts:31-36`; contract: `orchestration.ts:486-491`</sub>

### 🔧 C5. Don't re-save state while hot — predicate redesigned
- **What review caught:** copying the thread path's guard naively would let **one running
  thread suppress saving the whole environment's state** — a project created during a turn
  would vanish from crash-recovery paint. And the shell path has no shutdown flush to pair
  with a skip.
- **The safe version:** skip only *thread-update* events for running threads (project
  create/delete and thread-removed always persist), add the missing shutdown flush — or
  simply raise the debounce to 2–3 s. Either is fine; don't copy the predicate blindly.
- <sub>`shell.ts:94-178`; the finalizer the thread path has and shell lacks:
  `threads.ts:665-691`</sub>

### 🔧 C8. Skip pointless resubscribes on app-foreground — smaller and different than planned
- **What review corrected:** "15–25 subscriptions" was wrong — only **two** streams resubscribe
  on foreground (the rest already rebuild only on real session change). Long suspends already
  force a clean reconnect through a different path, so the risky case is narrow. But the
  foreground resubscribe is currently **the only recovery** for a stream that died silently
  while the socket stayed healthy — removing it unconditionally deletes a safety net.
- **The safe version:** the signal lives in the connection supervisor (not the wakeup
  predicate file); skip the resubscribe only when the probe passed AND the stream showed life
  since the last wakeup; cap consecutive skips. Keep the relay-specific wakeup excluded as it
  is today.
- **The perf gain (right-sized):** snappier app-foreground, less battery — modest, real.
- <sub>`supervisor.ts:421-437, 685` (where the work actually is); `wakeups.ts:19-21` (where
  the plan wrongly pointed)</sub>

### 🔧 C9. Let retry backoff breathe — three consumers move with it
- **Verified:** foreground instantly resets the ladder (wired correctly), and nothing
  displays a retry countdown — the two feared blockers are clear. Three real ones found
  instead: the web landing page waits on "first 2 attempts" *by count* (minutes-long ladder =
  minutes-long blank landing — re-bound it by wall clock); a comment elsewhere hard-codes the
  ladder values (already drifted — fix it); jitter must come from a seedable source or a
  dozen exact-timing tests go flaky.
- <sub>`supervisor.ts:32, 104-106`; the landing gate: `apps/web/src/state/shell.ts:37-45`;
  the drifted comment: `state/server.ts:150-160`</sub>

### ✅ C4. Cheaper message unpacking — verified byte-identical, one trap named
- **Verified:** the swap is safe and may even unlock a faster decode path. **The one trap:**
  don't reach for the library's built-in `trim()` helper — it trims on decode only, and
  values constructed *without* decoding would newly ship untrimmed. Use the explicit
  both-directions form. The double-decode in the array helper is confirmed unintentional;
  single-decode is behaviorally identical if per-element drop-on-failure is preserved (keep a
  debug log — a silent regression here looks like "the editor list is mysteriously empty").
- <sub>`contracts/src/baseSchemas.ts:6-46`; the exact replacement:
  `SchemaTransformation.transform({ decode: v => v.trim(), encode: v => v.trim() })`</sub>

### ⭐ 🔧 C6-check. Mobile compression — measure in 5 minutes; the fix is a project
- **Verified, and the odds got better:** mobile injects the platform's global WebSocket,
  which on React Native doesn't offer compression — so "off" is *likely*, and the 68 KB → 8 KB
  gap is measured, not estimated. **Framing corrected:** confirming takes minutes (the test
  harness exists); *fixing* means adopting a WebSocket implementation that supports it — a
  dependency decision. Also test the phone→server direction: the server's decompression path
  has a documented sharp edge there.
- <sub>measure: `apps/server/src/server.test.ts:3304-3328` shows the mechanism; injection
  point if fixing: `apps/mobile/src/lib/runtime.ts:29`</sub>

### 🔧 C6/C7. Smaller envelopes — right idea, wrong half of the rollout pattern
- **What review corrected:** the compatibility flag I cited only protects one direction
  (new client / old server). The direction that matters here — old client / new server —
  needs the **per-subscription opt-in** half of the pattern, which the codebase also already
  has. Also: this item and S6's shared cache pull opposite directions (per-client shapes vs
  one-shape-for-all) — design them together. And CI's transfer-budget caps must be lowered
  with the change or the win is invisible and regressions go unpoliced.
- **Strong recommendation:** this is upstream-PR material more than fork material — wire
  formats are the worst thing to rebase nightly forever.
- <sub>envelope: `orchestration.ts:1317-1327`; the opt-in half: `orchestration.ts:548-581`;
  budget caps to lower: `TransferBudgetReport.integration.ts:33-38`</sub>

---

# The verified order of attack

**Wave 1 — tiny and now actually verified safe:**
S4 (pragmas, honest wording) · W4 (cheap comparisons, widened + shared file → mobile wins
too) · W10 (decorate-sort, 2 sites added) · C4 (with the exact transform named) · R3-Part A
(hoist the Clerk client) · R5 (7s, prefer upstream PR) · C6-check (measure only).

**Wave 2 — the monsters, with their guards on:**
W1 (blip-in + three guards) · S2 + C1 (terminal both sides, drain-contract + state-carried
count) · C2 (16 ms pool inside the session stream + test budget) · R1 (dead-push skip, seam
updated) · W2+W3 (comparator unification FIRST, then single sort) · R3-Part B (30s memo) ·
R4 (links-only, 5s).

**Wave 3 — bigger rebuilds, measured:**
S1-Part A → S3 (safe version) → S5 (all five at once) · W11 (auto-split + root pruning +
desktop verification) · W9/C3 (parallel keyed index) · S6 (shared refetch — designed with
C6/C7) · C5 · C8 · C9 · S8 (numstat variant) · S9 (with all three invalidation mandates) ·
S1-Part B (user-input counter migration) · C6/C7 + shell paging from S7 (contract work,
upstream-first).

**Skipped by operator decision:** W6 · W7 · W8 (glow and orbs untouched) · R2 (replay
protection stays in Postgres).

**Upstream-PR candidates (no seam maintenance, fix flows back via nightly sync):** S4 · W4 ·
W10 · C4 · R3-Part A · R5 · the W2+W3 comparator unification · C6/C7.
