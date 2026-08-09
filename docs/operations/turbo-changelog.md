# T3 Turbo changelog

The fork's own record of what changed and when, on the fork's own version line (see
[the runbook](./turbo-runbook.md) for the version rules). Newest first. Every PR merged to
`turbo` that changes behavior, a seam, infrastructure, or an operational procedure appends an
entry here in the same PR. Upstream code arriving through the nightly sync is not logged
per-commit — the ingestion PR entry records the upstream range instead.

## Unreleased — on `turbo`, not yet in a shipped build

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
- **Timestamp comparisons stop building a collator (W4).** Every timestamp on the wire is minted
  fixed-width ISO, so plain string comparison yields exactly the order `localeCompare` yielded
  without doing the collation work. Seven comparison sites in the web session logic and the keyless
  half of the shared pinned-thread sort now compare strings directly — the shared file means mobile
  gets it too. The id tiebreaks stay on `localeCompare`: ids are not fixed width, so collation
  genuinely decides their order there.
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

No version manifests were bumped: this work ships with the next release, per the
[runbook's version rules](./turbo-runbook.md).

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

Fifteen seams protected by `.t3-turbo/customizations.json` (108 checks; verify with
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
| `relay-policy`                          | policy      | Relay/portal/tunnel credential and ownership boundaries            |
| `nightly-and-secret-policy`             | policy      | 11 PM Eastern ingestion rules, fork-only publishing, no secrets    |
