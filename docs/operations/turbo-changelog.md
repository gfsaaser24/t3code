# T3 Turbo changelog

The fork's own record of what changed and when, on the fork's own version line (see
[the runbook](./turbo-runbook.md) for the version rules). Newest first. Every PR merged to
`turbo` that changes behavior, a seam, infrastructure, or an operational procedure appends an
entry here in the same PR. Upstream code arriving through the nightly sync is not logged
per-commit — the ingestion PR entry records the upstream range instead.

## Unreleased — on `turbo`, not yet in a shipped build

- **Nightly ingestion merges upstream instead of rebasing onto it.** The sync workflow replayed
  the fork's commits onto each new upstream `main`. That could never finish: `turbo` is not a
  linear stack above the recorded anchor — it carries merge commits of its own and its root is
  several upstream generations back — so a rebase re-litigated conflicts those merges had already
  settled. The run that prompted this would have replayed 94 commits (15 of them merges) and
  aborted on the first handful; merging the same upstream tip conflicts on exactly one generated
  file (`apps/web/src/routeTree.gen.ts`). Because the rebase always aborted, the publish job never
  ran and `.t3-turbo/upstream.json` never advanced, so every following night repeated the same
  failure — and the two ingests that did land (PRs #46 and #53) were both merges done by hand.
  The step now merges the resolved upstream SHA into the Turbo branch inside the same isolated
  worktree. Everything around it is unchanged: automation still never auto-resolves, still writes
  the same collision report and opens the same review issue, still aborts and leaves `turbo` and
  the last release untouched, and the customization manifest gate still stands between a clean
  candidate and any build. That manifest — not the shape of the history — is what preserves the
  seams, and `AGENTS.md`, `SEAM.md`, and the runbook now say so. One real bug surfaced while
  dry-running the new step: `git merge` names conflicted files on stdout rather than stderr, so
  the report reads a combined merge log and no longer files an empty error section.

Wave 1 of the speed plan ([`.plans/23-turbo-performance-audit.md`](../../.plans/23-turbo-performance-audit.md)):
seven items across four surfaces. Every one keeps the behavior it found — the tests that pin the
old orderings and the old wire bytes are part of the wave.

- **Server writes stop waiting on the disk (S4).** SQLite was running at `synchronous=FULL`, which
  fsyncs after every commit — thousands of them per turn. The single persistence setup layer now
  also applies `synchronous=NORMAL`, the standard companion to the WAL mode already in use, so one
  statement covers every connection the persistence layer opens. (The guarded official-import
  staging path deliberately opens its own raw handles and keeps the default.) Durability trade: an
  app crash still loses
  nothing; only a power loss or hard reset can drop the most recent commits. New seam
  `sqlite-fast-mode-pragma`.
- **Timestamp comparisons stop building a collator (W4).** Product-minted timestamps are
  fixed-width ISO, so plain string comparison yields exactly the order `localeCompare` yielded
  without doing the collation work. Seven comparison sites in the web session logic and the keyless
  half of the shared pinned-thread sort now compare strings directly for the canonical stamps the
  product mints — the pinned sort verifies both operands with a strict calendar check and falls
  back to the old parse comparator (malformed stamps keep sinking to the bottom) otherwise. The
  shared file means mobile gets it too. The id tiebreaks stay on `localeCompare`: ids are not
  fixed width, so collation genuinely decides their order there.
- **Sidebar buckets resolve each row's sort key once (W10).** All three sidebar bucket sorts —
  active, settled, and the snoozed shelf — parsed timestamps
  inside the comparator, so a bucket of n rows paid O(n log n) parses — and the settled bucket
  re-walked four candidate timestamps on every comparison. They now decorate each row once and sort
  on the precomputed key. Same comparator, same id tiebreak, same tie order; the manual pinned
  ordering path is untouched. W4 and W10 share the seam `cheap-timestamp-and-sort-keys`, and both
  are pinned by tests that replay the pre-change implementations over randomized corpora with
  deliberate ties, so a future edit that shifts an order fails in a test rather than in the sidebar.
- **Message decoding stops doing the same work twice (C4).** `TrimmedString` built its trim out of
  `transformOrFail`, which allocates an Effect per value in both directions; it is now the pure
  transform, still trimming on decode _and_ encode (the stock trim helper only does decode, which
  would newly ship untrimmed values constructed without decoding). `ForwardCompatibleArray` decoded
  every element twice — once to test whether this build understands it, then again for real — and
  now keeps the value the first pass already produced. Per-element drop-on-failure is unchanged and
  now leaves a debug breadcrumb with the drop count, because a silent drop here looks like "the
  list is mysteriously empty". New seam `cheap-message-unpacking`.
- **The relay builds its Clerk client once (R3 part A).** The OAuth fallback path constructed a
  fresh Clerk backend client on every request; it is now built once per relay configuration and
  reused. The fallback order, the client options, and the error mapping are unchanged.
- **The relay's mint budget now fits inside its own deadline (R5).** The environment mint timeout
  was 10s, above the relay's 9s request deadline, so it could never fire — a stuck environment
  surfaced as a generic 504 instead of a mint timeout. It is now 7s; the 9s deadline is deliberate
  and was left alone. R3-A and R5 share the seam `relay-request-budget-and-clerk-client`.
- **Mobile WebSocket compression measured instead of assumed (C6-check).** Written up in
  `.plans/23a-c6-mobile-compression-measurement.md`: iOS React Native never offers
  `permessage-deflate`, so both directions are uncompressed there — but Android rides a different
  native stack (OkHttp) and probably already negotiates it, which corrects the plan's framing that
  it is off on React Native generally. Settling Android is step one; the record also flags the
  server's shared-decompressor sharp edge on the inbound path and the dependency change a fix would
  require. No product code changed — the wave adds a fork-owned probe test that pins the
  consequence in bytes.

Wave 2 of the speed plan: seven items across the same four surfaces, plus the fix rounds each one
earned in review. Same rule as Wave 1 — the visible behavior stays put, and the tests that pin the
old orderings and the old wire bytes ship with the wave.

- **Threads sort themselves once, the same way everywhere (W2+W3).** The store, the web chat view,
  mobile, and the server's SQL each carried their own idea of how a thread's activities are ordered,
  and the web layer re-sorted the same list five more times on the way to the screen. There is now
  one canonical comparator in the client runtime — sequence number first, then creation time, then
  lifecycle phase, then id — and every surface calls it. Rows with no sequence number sort **last**,
  which is what the thread timeline has always shown: a missing sequence does not mean "old", it
  means "not part of the provider's numbered stream", and the rows that carry no sequence include
  the "Checkpoint captured" line every turn writes. All four of the server's activity queries spell
  that out explicitly (SQLite's own default is the opposite) along with the same lifecycle tiebreak
  and a code-unit id tiebreak, so SQL and JavaScript agree character for character — and a
  fork-owned test replays a generated corpus through every one of those queries and through the
  comparator and asserts the two orders are identical, so a future edit to any single copy fails
  there instead of in someone's thread. The older-page merge sorts its output, so pagination can no
  longer hand the view an out-of-order page, and the five per-derivation re-sorts collapse into one
  memoized sort at the view boundary. New seam `unified-activity-order`.
- **Streaming code blocks stop re-colouring on every delta (W1).** A code fence was syntax
  highlighted from scratch on every delta while the model typed it — the most expensive render in
  the chat, repeated hundreds of times per block. It now shows a placeholder card inside the normal
  code-block frame that reserves one line of height per line of code received, and gets exactly one
  coloured render when the message completes. The placeholder draws at most two dozen shimmer rows
  and reserves the rest as a single spacer, counts new lines by looking only at the text that just
  arrived, and uses the app's existing duty-cycled shimmer rather than an animation that repaints
  every frame for the life of the stream. An old message still flagged as streaming — those exist in
  saved history — is highlighted immediately instead of pulsing forever.
- **A message that stops streaming now says so (W1 follow-up).** "This message is streaming" was
  only ever turned off by the message's own final chunk. If a turn ended any other way — the
  provider errored or exited, the session stopped, or you pressed stop — that chunk never arrived,
  the flag stayed on, and it was saved that way. One flag, five symptoms: code blocks that shimmered
  forever, an "empty response" label, a missing message footer, a copy button stuck in its streaming
  state, and turns grouped wrongly. The thread reducer now turns the flag off wherever it already
  ends a turn, and none of those five places needed touching. New seam
  `streaming-flag-cleared-on-turn-settle`; the code-fence work keeps the seam
  `deferred-streaming-code-blocks`.
- **The server terminal stops rebuilding its scrollback per chunk (S2).** Every PTY chunk chopped
  and re-glued the whole retained scrollback string. A session now keeps scrollback as a list of
  lines with incremental capping, and batches history-side appends on a ~16 ms coalescing worker.
  Every read flushes the batch first, so the string handed to a client stays byte-identical to what
  upstream produced; a dirty-since-persist flag — not the last flush's result — decides whether a
  write is still owed, so a read racing the batch tick cannot strand the tail. Each session waits
  out its own ~16 ms window: the coalescing worker is a single worker shared by every terminal, so
  waiting inside it made eight busy terminals queue behind one another — their batches stretched to
  eight times the intended window, one noisy terminal could hold up the rest, and Clear, Restart and
  Close waited out unrelated terminals' timers before they could act. The window is also armed once
  per burst of output instead of once per chunk from the shell. The wire cadence to the terminal is
  unchanged: this is history-side only. New seam `terminal-scrollback-batching`.
- **The client terminal buffer stops re-encoding itself to measure itself (C1).** Enforcing the byte
  cap re-encoded the entire retained buffer on every append just to learn how big it was. The
  reducer now carries a running byte count and only re-encodes once the total passes the cap plus a
  25% slack window, then trims back down to the cap. The multi-byte safety loop that keeps a trim
  from splitting a character is untouched. New seam `terminal-buffer-byte-budget`.
- **Screen updates arrive one frame at a time (C2).** A burst of stream items used to cost the
  screen one update each. Inside the per-session subscription, items that have already arrived now
  pool for 16 ms and release as a single chunk — one blip per frame instead of one per item. The
  pool is created and shut down with the session, the "synchronized" connection marker bypasses the
  window so a reconnect is never held back, and the window boundary is drop-proof: a pool that is
  closing flushes what it holds rather than dropping it. The streaming protocol and the wire bytes
  are unchanged. New seam `pooled-subscription-frame`.
- **The relay stops preparing pushes nobody will receive (R1).** With APNs off, publishing agent
  activity still ran the delivery-user, active-row, and Live Activity target queries — and then
  handed the results to a delivery layer that throws them away. A separate publisher layer keeps the
  row write verbatim and returns the same response without those queries; it is selected only when
  APNs is off, and the APNs-on wiring is untouched. New seam `relay-apns-off-publish-skip`.
- **The relay remembers who it just verified (R3-B + R4).** Every request re-verified its bearer
  token against Clerk and re-read the same user-link rows. Successful verifications are now
  remembered per isolate for at most 30 seconds, keyed by the token's SHA-256 digest (never the
  token itself) and never past the token's own expiry — an unreadable expiry caps at the same 30
  seconds, and a failed verification is never remembered. The links-only lookup answers from a
  5-second memo. The allocation record that carries the compare-and-swap token and the credential
  check that enforces instant revocation are never cached. New seam `relay-auth-and-link-memos`.
- **Mobile's copy of the streaming-code problem is written down, not fixed (W1 companion).**
  `.plans/23b-w1-mobile-companion.md`: the mobile chat caches highlighted code under a key that
  includes the code itself, so a streaming fence starts a fresh highlight job per delta and keeps
  every intermediate version of the block in memory for five minutes. That is the same shape W1
  fixed on web, but the mobile fix needs a product decision (plain text while streaming, or a mobile
  placeholder) rather than a mechanical port, and mobile was not one of the surfaces this audit
  measured. Filed so the asymmetry is visible: after this wave, web streams code cheaply and mobile
  does not. No product code changed.

Four trades this wave accepts, stated plainly: a revoked principal can keep working for up to 30
seconds before the verification memo expires; for up to 5 seconds after an unlink a lookup can still
return the old link record; terminal echo can lag by up to one frame (~16 ms) under the pool; and in
threads old enough to predate activity sequence numbers, those oldest rows now sit at the bottom of
the thread rather than the top. The last one is the price of putting every turn's "Checkpoint
captured" line in the right place, and it matches what the store and the mobile app always did.

No version manifests were bumped: this work ships with the next release, per the
[runbook's version rules](./turbo-runbook.md).

- **Both waves merged to `turbo`** ([#47](https://github.com/gfsaaser24/t3code/pull/47) →
  `131038e1`, [#48](https://github.com/gfsaaser24/t3code/pull/48) → `07d6d50c`). Seam registry
  after the merges: **25 seams / 164 file checks**, verified on the merged tip.
- **Forward-looking status recorded** in
  [`.plans/25-turbo-work-status.md`](../../.plans/25-turbo-work-status.md): the seams each wave
  added, waves 3 and 4 held by operator decision (the plan's bigger rebuilds, plus the follow-ups
  the reviews produced), the pending upstream backlog with its collision assessment, and the two
  distinct guard failures that stalled the nightly sync.
- **Nightly sync diagnosis.** The scheduled runs on 08-08 and 08-09 failed because
  `upstream.json`'s `version` stopped deriving from its `nightlyTag` once the fork took its own
  version line — the PR #46 ingestion already restored that field. A manual dispatch then failed
  on the cutoff guard, which correctly refused to move the anchor backward relative to the window
  it was resolving. No repair needed; the next scheduled run resolves forward. Both guards and the
  standing risk are written up in the status plan.

## 0.0.38 — 2026-08-09 (desktop installer not yet shipped)

- Ingested upstream `main` through official nightly `.1042` (21 commits) via
  [#46](https://github.com/gfsaaser24/t3code/pull/46); all seams preserved. Notables inherited:
  sidebar v2 becomes the default sidebar (seam remapped from `SidebarV2.tsx` to `Sidebar.tsx`),
  greedy-agent process isolation, draft preservation rework, per-project worktree choice.
  Upstream's PR #5710 (our own fix, merged by Theo) superseded the downstream copy; #45 closed
  as redundant.
- Fixed the five fork binding/heartbeat tests that failed once upstream's `ProviderService`
  began requiring `ServerConfig` (`da968fc8`) — the failure previously misdiagnosed as
  combined-run flake.
- Wrote the T3 Turbo operating model into `AGENTS.md`/`CLAUDE.md` and registered the agent docs
  as a protected seam (`e47e5ee5`).
- Redeployed the hosted web app at `app.t3turbo.pro` from this tip (Worker version `19a7ea87`),
  clearing the hosted side of the version-skew banner.
- Added this changelog and the [operator runbook](./turbo-runbook.md).
- Recorded a four-surface performance audit (server, web, relay, client runtime) as
  `.plans/23-turbo-performance-audit.md` — the ranked backlog for the Turbo speed push,
  written in plain language: each item states the problem, the change, and the perf gain.
  Scope decisions: streaming code blocks will not render live — they show a placeholder card
  and blip in fully formatted on completion (W1); screen updates pool-and-blip in batches
  with no change to the streaming protocol (C2); W6/W7/W8 (glow, orbs) and R2 (replay
  protection) are skipped. Corrected: the relay database is the `openclaw` Hetzner box in
  Ashburn, Virginia — not Germany.
- Adversarially verified the speed plan with four Opus 5 reviewers (one per surface). Five
  original items collided with real functionality and were rescoped: W2+W3 (four divergent
  sort orders; naive deletion could show phantom pending approvals), R4 (caching would break
  unlink race-detection and instant credential revocation), S3 (skipping cursors would freeze
  the reconnect watermark), S7 (server-side limits would break the written pre-pagination
  compatibility promise), S9 (revert reuses diff-cache keys). The plan now carries
  per-item verdicts and verified scopes.

## 0.0.37 — 2026-08-08

- Restored the T3 Connect build-time config to local installer builds and wrote the
  [local Windows build runbook](./local-build.md) (`880cbc07`) after three builds shipped with
  the Connect stack silently compiled out.

## 0.0.36 — 2026-08-08

- Hosted the personal official T3 Code home as a second local backend on the desktop
  (`cf516adb`), since replaced by the guarded one-way official import.

## 0.0.35 — 2026-08-08

- T3 Turbo takes its own version line, independent of upstream nightlies (`a0732bb8`).

## Pre-versioning foundation (2026-08-02 → 2026-08-07)

The initial Turbo stack, still visible as the reviewable commit stack above the upstream SHA:
brand identity and icon pipeline, self-hosted relay/Supabase/Cloudflare infrastructure,
fork-owned nightly inbound sync and packaging CI, shared contract and client-runtime
extensions, server-side official data import and external launcher seams, web surfaces (chat
panes, explorer, markdown, image tabs), desktop identity/state home/official import, Turbo
mobile surfaces, reaper and phantom-turn fixes (#41–#44), resizable chat panes (#36), theme
region roles (#37), thinking orbs (#38).

## Seam registry snapshot (2026-08-09)

Twenty-two seams protected by `.t3-turbo/customizations.json` (146 checks; verify with
`pnpm --dir scripts turbo:customizations:verify`):

| Seam                                    | Status      | What it protects                                                   |
| --------------------------------------- | ----------- | ------------------------------------------------------------------ |
| `agent-docs-operating-model`            | implemented | Operating model atop `AGENTS.md`/`CLAUDE.md`, seam registration    |
| `changelog-and-runbook`                 | implemented | This changelog and the operator runbook                            |
| `product-identity-and-updater`          | implemented | `com.gabef.t3turbo` identity, `~/.t3-turbo` home, fork update feed |
| `canonical-icon-pipeline`               | implemented | Turbo icon and all platform derivatives                            |
| `file-explorer`                         | implemented | File actions, reveal, Alt-click bulk expansion                     |
| `workspace-image-preview`               | implemented | Image types in editor tabs via shared classifier                   |
| `markdown-preview-preference`           | implemented | Source/rendered Markdown as persisted preference                   |
| `official-data-import`                  | implemented | One-way official import: planning, remapping, staging, restore     |
| `multi-chat-pane-workspace`             | implemented | Typed persisted chat-pane layouts                                  |
| `sqlite-fast-mode-pragma`               | implemented | `synchronous=NORMAL` in the one persistence setup layer            |
| `cheap-timestamp-and-sort-keys`         | implemented | ISO string timestamp compares, decorate-sorted sidebar buckets     |
| `cheap-message-unpacking`               | implemented | Both-directions trim, single-decode wire arrays                    |
| `relay-request-budget-and-clerk-client` | implemented | One Clerk client per config, 7s mint budget under the 9s deadline  |
| `unified-activity-order`                | implemented | One activity comparator across store, web, mobile, server SQL      |
| `deferred-streaming-code-blocks`        | implemented | Growing placeholder while streaming, one colouring on completion   |
| `terminal-scrollback-batching`          | implemented | Line-list scrollback, 16ms history batch, dirty-flag persist gate  |
| `terminal-buffer-byte-budget`           | implemented | Byte-counted client terminal buffer, trim to cap on slack          |
| `pooled-subscription-frame`             | implemented | 16ms pool-and-blip inside the per-session stream                   |
| `relay-apns-off-publish-skip`           | implemented | No push-delivery prep when APNs is off                             |
| `relay-auth-and-link-memos`             | implemented | 30s verified-token memo, 5s links-only lookup memo                 |
| `relay-policy`                          | policy      | Relay/portal/tunnel credential and ownership boundaries            |
| `nightly-and-secret-policy`             | policy      | 11 PM Eastern ingestion rules, fork-only publishing, no secrets    |
