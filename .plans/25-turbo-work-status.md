# T3 Turbo work status — 2026-08-09

Where the fork stands after the speed-plan waves landed, what is deliberately held, and what the
nightly ingestion owes us. Companion to [`23-turbo-performance-audit.md`](./23-turbo-performance-audit.md)
(the verified plan) and [`24-speedplan-session-log.md`](./24-speedplan-session-log.md) (how the plan
was written). Shipped work is recorded in
[`docs/operations/turbo-changelog.md`](../docs/operations/turbo-changelog.md); this file is the
forward-looking ledger.

---

## 1. Shipped — speed plan waves 1 and 2

Both waves are merged to `turbo`:

| Wave | PR | Merge commit | Items |
|---|---|---|---|
| 1 | [#47](https://github.com/gfsaaser24/t3code/pull/47) | `131038e1` | S4, W4, W10, C4, R3-A, R5, C6-check |
| 2 | [#48](https://github.com/gfsaaser24/t3code/pull/48) | `07d6d50c` | W2+W3, W1, S2, C1, C2, R1, R3-B, R4 |

Both were built the same way: one agent per item, an independent reviewer per item, bounded fix
rounds with scoped re-reviews, then a ten-angle review of the whole PR and a single consolidated
fix wave. Wave 1's fix wave was re-reviewed and closed clean.

**Seam registry after both waves: 25 seams / 164 file checks, verified green on the merged tip.**

### Seams added by the waves

| Seam id | What it protects |
|---|---|
| `sqlite-fast-mode-pragma` | the `synchronous = NORMAL` line in the one persistence setup layer |
| `cheap-timestamp-and-sort-keys` | ISO-string comparisons + the three sidebar decorate-sorts |
| `cheap-message-unpacking` | the both-directions trim and the single-decode wire array |
| `relay-request-budget-and-clerk-client` | the 7s mint budget under the 9s deadline, and the one-per-config Clerk client |
| `unified-activity-order` | the one canonical activity comparator and all four server `ORDER BY` copies |
| `deferred-streaming-code-blocks` | the streaming placeholder and the one-shot highlight |
| `terminal-scrollback-batching` | the line-list scrollback, the history batch, and the dirty-flag persist gate |
| `terminal-buffer-byte-budget` | the client buffer's running byte count and trim-to-cap-on-slack |
| `stream-pool-within-frame` | the 16 ms pool inside the session stream and its non-negotiables |
| `relay-apns-off-publish-skip` | the APNs-off publisher layer and its `worker.ts` gate |
| `relay-link-and-token-memos` | the TTL memos, the never-cache list, and the fresh-read write path |

---

## 2. Held for later — waves 3 and 4

**Operator decision: not scheduled. Recorded here so nothing is silently dropped.**

### Wave 3 — the bigger rebuilds (from the verified plan)

Ordered as the plan orders them; each still carries the scope its adversarial review produced.

- **S1-Part A → S3 → S5** — the projection-pipeline trio, in that order. S1-A computes three of the
  four sidebar numbers with direct queries; S3 skips the no-op bookkeeping work while still
  advancing all nine progress markers in one transaction (the naive version froze the reconnect
  watermark); S5 replaces all five consumers of the full-thread load at once so the load can be
  deleted (a partial fix is a net loss).
- **W11** — bundle split: `autoCodeSplitting: true` plus root-layout import pruning plus
  `defaultPreload: "intent"`, and the desktop custom-protocol path must be tested explicitly.
- **W9 / C3** — a parallel keyed thread index (the array is a wire *and* on-disk cache format, so
  it cannot become a Map).
- **S6** — share the sidebar refetch across devices; must be designed together with C6/C7 because
  they pull in opposite directions.
- **C5** — don't re-save state while hot, with the redesigned predicate (skip only thread-update
  events for running threads) plus the missing shutdown flush.
- **C8** — skip pointless resubscribes on app-foreground; only two streams are affected, and the
  foreground resubscribe is currently the only recovery for a silently dead stream.
- **C9** — let retry backoff breathe; three consumers move with it, and jitter must be seedable.
- **S8** — a stats-only (`--numstat`) diff variant for the end-of-turn summary, as a new method.
- **S9** — the diff cache, with all three invalidation mandates (whitespace mode in the key,
  delete-past-revert in the revert transaction, seam-register the shared table).
- **S1-Part B** — the pending-user-input counter: a tracked column plus a migration.
- **C6/C7 + the client half of S7** — smaller envelopes and shell paging. Contract work.

### Wave 4 — the follow-ups this session generated

Not in the original plan; produced by the reviews and audits.

- **W1's mobile companion** — filed at [`.plans/23b-w1-mobile-companion.md`](./23b-w1-mobile-companion.md).
  The mobile markdown path spawns a highlight job per delta and retains each for five minutes.
- **Upstream `streaming` flag** — Wave 2 clears it at the client reducer when a turn settles. The
  durable fix is server-side: emit the completion on `turn.aborted` / `runtime.error` /
  `session.exited`. That would delete both stall windows and restore highlight caching for
  history. Good upstream-PR material.
- **C6-check step 1** — confirm the Android verdict (OkHttp probably already negotiates
  `permessage-deflate`); ~10 minutes with an Android dev build. Then decide the dependency
  question for iOS.
- **PR #48 fix-wave re-review** — the consolidated fix wave for Wave 2 landed without its own
  scoped re-review (the only gate skipped in either wave). Two items its authors wanted a second
  reader on: `flushPersist` now enqueues a batch before draining, and there is no multi-session
  isolation test for the per-session output debounce.
- **`compareIsoTimestamps` scope asymmetry** — the pinned-thread sort guards against
  non-canonical stamps and falls back to the parse comparator; the seven `session-logic` sites
  still compare raw strings. Their operands are server-minted, so the risk is lower, but the two
  should agree.
- **Deferred minors** — the per-task ledger entries under
  `.superpowers/sdd/23-turbo-performance-audit/progress.md` list every minor finding that was
  reviewed, judged non-blocking, and parked with a ruling.

---

## 3. Upstream ingestion status

**Anchor (`.t3-turbo/upstream.json`):** `mainSha 1a003e38`, `nightlyTag v0.0.33-nightly.20260809.1042`.

**Pending as of 2026-08-09:** 12 commits on upstream `main`, and three newer official nightlies —
`.1043` (which is our recorded `mainSha`), `.1045`, `.1047`. All twelve are `fix(...)` commits;
nothing structural.

**Collision assessment against the seam — clean.** The twelve commits touch 20 files. Two are
seam-protected:

| File | Seam | Upstream change | Our change | Overlap |
|---|---|---|---|---|
| `apps/web/src/components/chat/ChatHeader.tsx` | `multi-chat-pane-workspace` | one `className` (drops `flex-1`) at ~:266 | two lines adding `<ChatPaneControl />` | none |
| `apps/web/src/components/settings/SettingsSidebarNav.tsx` | `markdown-preview-preference` | `Kbd` styling at ~:234 | two lines adding the `/settings/t3-turbo` nav item | none |

A trial merge of `upstream/main` into the merged `turbo` tip completed with **zero conflicts**.

### Why the automation has not picked this up

The scheduled sync failed on 2026-08-08 and 2026-08-09, and a manual dispatch on 2026-08-09
failed too — three failures, two distinct causes, both now understood:

1. **2026-08-08 / 2026-08-09 (scheduled):** `Turbo published version must derive from its recorded
   Nightly tag` (`scripts/turbo-nightly-sync.ts:237`). When the fork took its own version line on
   2026-08-08 (0.0.35 → 0.0.38), `upstream.json`'s `version` field stopped deriving from its
   `nightlyTag`, which that guard requires. **Resolved** — the manual ingestion in PR #46 rewrote
   the field to `0.0.33-nightly.20260809.1042`, which is consistent again.
2. **2026-08-09 (manual dispatch):** `Refusing to move the recorded official Nightly release
   backward` (`:288`). The resolver runs against a cutoff window; a dispatch at 20:32 ET resolved
   the window ending `2026-08-09T03:00Z`, whose newest nightly is older than the `.1042` the
   morning's manual ingestion had already recorded. The guard is correct and the state is fine —
   the manual ingestion simply moved the anchor past the window the automation was looking at.

**Expected resolution:** the next scheduled run (23:00 ET) computes a `2026-08-09` cutoff, which
covers `.1043`/`.1045`/`.1047` — forward of `.1042`, so the guard passes. No repair needed.

**Standing risk to watch:** guard 1 will fire again the moment `upstream.json`'s `version` stops
deriving from its `nightlyTag`. If the fork's independent version line is ever written into that
field, the nightly sync stops silently — the failure only surfaces as a Telegram notice and a
repair issue. The two version concepts (the fork's release line vs. the recorded upstream anchor)
must stay in separate fields.

---

## 4. Known local condition (not a fork change)

The desktop product-flavor work in progress (`apps/desktop/src/app/desktopProductFlavor.ts`,
`scripts/lib/desktop-product-flavor.ts`, `scripts/clone-turbo-userdata-to-beta.ps1`) parameterizes
the product identity, so the hardcoded `product-identity-and-updater` markers
(`const APP_BASE_NAME = "T3 Turbo";`, `"com.gabef.t3turbo"`,
`input.joinPath(input.homeDirectory, ".t3-turbo")`) no longer match while it is uncommitted. Three
seam checks fail in that working tree and pass everywhere else. When that work lands, its seam
markers need re-pointing at the flavor table rather than the literals.
