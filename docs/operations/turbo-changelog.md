# T3 Turbo changelog

The fork's own record of what changed and when, on the fork's own version line (see
[the runbook](./turbo-runbook.md) for the version rules). Newest first. Every PR merged to
`turbo` that changes behavior, a seam, infrastructure, or an operational procedure appends an
entry here in the same PR. Upstream code arriving through the nightly sync is not logged
per-commit — the ingestion PR entry records the upstream range instead.

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
- Preserved the full working-session record behind the speed plan as
  `.plans/24-speedplan-session-log.md`, carried with the docs on the `speedplan` branch.
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

Eleven seams protected by `.t3-turbo/customizations.json` (93 checks; verify with
`pnpm --dir scripts turbo:customizations:verify`):

| Seam                           | Status      | What it protects                                                   |
| ------------------------------ | ----------- | ------------------------------------------------------------------ |
| `agent-docs-operating-model`   | implemented | Operating model atop `AGENTS.md`/`CLAUDE.md`, seam registration    |
| `changelog-and-runbook`        | implemented | This changelog and the operator runbook                            |
| `product-identity-and-updater` | implemented | `com.gabef.t3turbo` identity, `~/.t3-turbo` home, fork update feed |
| `canonical-icon-pipeline`      | implemented | Turbo icon and all platform derivatives                            |
| `file-explorer`                | implemented | File actions, reveal, Alt-click bulk expansion                     |
| `workspace-image-preview`      | implemented | Image types in editor tabs via shared classifier                   |
| `markdown-preview-preference`  | implemented | Source/rendered Markdown as persisted preference                   |
| `official-data-import`         | implemented | One-way official import: planning, remapping, staging, restore     |
| `multi-chat-pane-workspace`    | implemented | Typed persisted chat-pane layouts                                  |
| `relay-policy`                 | policy      | Relay/portal/tunnel credential and ownership boundaries            |
| `nightly-and-secret-policy`    | policy      | 11 PM Eastern ingestion rules, fork-only publishing, no secrets    |
