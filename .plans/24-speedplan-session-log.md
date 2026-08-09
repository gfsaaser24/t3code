# Speedplan session log — 2026-08-09

The full conversation record behind the speed plan (`.plans/23-turbo-performance-audit.md`)
and the day's operational work, kept so the reasoning survives alongside the docs. Written as
a chronological narrative: what Gabe asked, what was done, what was decided. Model: Claude
Fable 5 with Opus 5 sub-agents for verification.

---

## 1. Project setup

**Ask:** "setup this project for this https://github.com/gfsaaser24/t3code/tree/turbo"

Cloned the `turbo` branch to `C:\code\t3-turbo`. Toolchain verified (Node 24.16, pnpm
11.10.0 exact). Installed 1,833 packages; the prepare step patched the tsgo binary cleanly.
Created `.env.local` from the fork's GitHub Actions variables (Clerk test key, `t3-relay`
JWT template, `relay.t3turbo.pro`) per `docs/operations/local-build.md` — and removed the
`.env` copied from `.env.example`, which pointed at the official production stack. Verified
the setup end to end: contracts typecheck passed and the dev server booted (migrations ran,
server on `127.0.0.1:13773`, web on `5733` with a pairing URL).

## 2. The operating model, written down

**Ask:** seven rules for how this branch operates — own relay (not stock Connect), a seam for
customizations, daily ingestion of ALL upstream code and Nightly releases, Turbo changes
always survive, isolated local state with the guarded import lock, and official builds
covering every ecosystem. "Modify the agents.md and claude.md files to reflect this."

Done in `e47e5ee5`: `AGENTS.md` now opens with the full operating model (upstream guide kept
below), `CLAUDE.md` carries the Turbo preamble and imports it, both registered in `SEAM.md`
and as the `agent-docs-operating-model` seam in `customizations.json`. While verifying, found
and fixed a stale manifest entry (upstream had renamed `SidebarV2.tsx` → `Sidebar.tsx`; the
fork's marker survived in the new file).

CI survey findings recorded: `ci.yml` never runs on `turbo` pushes; `release.yml` already has
the full desktop platform matrix the nightly sync doesn't use yet; Android EAS workflows need
an `EXPO_TOKEN` secret.

## 3. The inherited follow-ups (PR #46 saga)

**Ask:** review the prior conversation in the `t3code-ef5ae05a` worktree — "has stuff we need
to do."

Found four items: merge PR #46 (ingestion of 21 upstream commits), close #45, redeploy the
hosted app, and an open version-number decision. Discovered #46's CI was **red** — the prior
session had dismissed the failures as "local-load flake," but they were deterministic:
upstream made `ProviderService` require a `ServerConfig` service the fork's five new tests
never provided. Proved it both directions locally, pushed the five-line fix (`da968fc8`),
watched CI go green, merged #46 (merge commit `6474394f`, preserving upstream history),
closed #45 as superseded.

**Decisions (Gabe):** version line continues at **0.0.38** (never downgrade); hosted app
redeploys after merge. Executed: version bumped in the three manifests (`991d9ca0`), hosted
web app built from the merged tip with the Connect config verified baked in and deployed to
the `t3turbo-hosted-app` Worker (version `19a7ea87`), live site confirmed serving 0.0.38.
Desktop installer `T3-Turbo-0.0.38-x64.exe` built and verified per the runbook (Clerk key,
relay domain, JWT template, OAuth client id, version — all present); installation left to
Gabe since it replaces the running app.

## 4. Changelog and runbook

**Ask:** "I would like us to have our own change log and run book so we can always track our
changes and seam."

Created `docs/operations/turbo-changelog.md` (version-line history seeded back through
0.0.35, plus a seam registry snapshot) and `docs/operations/turbo-runbook.md` (the operator
index: tracking layers, seam-registration checklist, nightly-sync ops, release procedure,
hosted-app deploy — which until then existed only in session memory). Both protected by the
`changelog-and-runbook` seam (`47db9463`). Learned along the way: commits staging only
`.plans/` files fail the pre-commit formatter — documented in the runbook.

## 5. The speed plan ("Turbo should embrace its name")

**Ask:** "where can we pick up very large performance gains that would be noticeable …
without breaking anything."

Four parallel audit agents swept server, web app, relay, and shared client code. The theme:
Turbo doesn't have slow code, it has code that **repeats work** — whole-conversation
reprocessing per streamed word, whole-scrollback rebuilds per terminal line, relay database
trips whose answers get discarded. Findings recorded as `.plans/23-turbo-performance-audit.md`
(`3903475f`).

**Rewrites (Gabe):** twice, for full ELI5 — every item as *the problem / what we'd change /
the perf gain*, gains stated as wins (`6f1466ae`, superseding `508f00b8`).

**Scope decisions (Gabe):**
- **W1 rescoped:** streaming code blocks don't render live at all — placeholder card, then
  blip in complete ("kills the recolor bug and saves us system resources") (`60a5d970`).
- **W6, W7, W8 skipped** (glow and orbs stay), **R2 skipped** (replay protection stays in
  Postgres) (`56527de2`).
- **"What fucking germany database?"** — fair. The audit had assumed Hetzner = Germany.
  Checked the actual Hetzner account: the relay DB is the Supabase Postgres on the `openclaw`
  box in **Ashburn, Virginia** (~10 ms away). Corrected everywhere; the findings survive
  because they're about trip *count*, not distance.
- **C2 clarified:** it never touched streaming-the-technology — it pools already-arrived
  words before the screen processes them, exactly "pool responses and blip them in," window
  adjustable 16–250 ms.

## 6. Adversarial verification

**Ask:** "ship a set of opus 5 sub agents to verify the plan and ensure no collisions or
misalignments with other functionality."

Four Opus 5 reviewers, one per surface, fact-checked every claim and hunted collisions. The
pass earned its cost — **five items would have broken real things as originally written:**

| Item | What would have broken |
|---|---|
| W2+W3 (delete the "redundant" sorts) | Four divergent sort orders exist; deletion could show phantom pending-approval badges |
| R4 (relay lookup cache) | One cached "read" is a race-detection token — unlink would silently orphan Cloudflare tunnels/DNS; another is the instant-revocation checkpoint |
| S3 (skip bookkeeping) | The reconnect watermark is a MIN over cursors — skipping freezes it and reconnects degrade to full re-downloads |
| S7 (server-side snapshot limits) | The unlimited fallback is a written compatibility promise to pre-pagination clients |
| S9 (diff cache) | Revert reuses cache keys against a different tree — stale wrong diffs |

Other corrections: W11 is one router option (`autoCodeSplitting`) plus root-layout import
pruning, not 23 hand-split files; C2's window fixed at 16 ms because approval prompts ride
the same stream, and the pool must live inside the per-session stream or reconnects flush
stale items over fresh snapshots; C6's mobile-compression check is minutes to measure but a
dependency decision to fix; R5's "backwards timeouts" framing was wrong (the 9 s deadline is
deliberate — only the 10 s inner constant is broken, fix is 7 s); C4 must avoid the library's
built-in trim helper (encode-passthrough would change bytes for un-decoded values).

Four items verified clean as written: W4, W10, C4 (with the trap named), C6-check.

All verdicts folded into the plan as the **verified edition** (`e936bca8`) — each item badged
✅/🔧/🛑 with its post-review scope inline, waves re-ordered, and an eight-item upstream-PR
candidate list (fixes that cost zero seam maintenance because they flow back through the
nightly sync).

## 7. This branch

**Ask:** "lets make sure this conversation is inserted into the speedplan branch, along with
the docs."

The `speedplan` branch carries the whole stack of this session's doc commits (operating
model, changelog, runbook, and the verified speed plan) plus this session log. The raw
machine transcript of the session lives at
`~/.claude/projects/C--code-t3-turbo/98c7a805-4dba-4e55-aa41-1f356b77d1ce.jsonl` (2.7 MB,
not committed — this log is the human-readable record).

## Commit index (chronological)

| Commit | What |
|---|---|
| `da968fc8` | fix(server): provide ServerConfig to the new provider binding tests (PR #46 branch) |
| `6474394f` | Merge PR #46 — ingest upstream through nightly .1042 |
| `e47e5ee5` | docs(turbo): operating model into AGENTS.md/CLAUDE.md + seam |
| `991d9ca0` | chore(turbo): version line → 0.0.38 |
| `47db9463` + `4b2bd877` | docs(turbo): changelog + operator runbook + seam |
| `3903475f` | docs(turbo): four-surface performance audit as plan 23 |
| `508f00b8` → `6f1466ae` | plan rewritten plain-language, then fully ELI5 |
| `60a5d970` | W1 rescoped: code blocks blip in complete |
| `56527de2` | W6/W7/W8/R2 skipped; Ashburn correction; C2 pool-and-blip |
| `e936bca8` | verification folded in — the verified edition |
