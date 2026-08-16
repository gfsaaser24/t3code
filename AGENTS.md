# T3 Turbo — how this branch operates

> **Read this section before anything else.** This is the `turbo` branch of the
> `gfsaaser24/t3code` fork. It is a downstream operator build of T3 Code, not the official
> product. The upstream T3 Code agent guide follows below and still governs how you write code
> here — but the rules in this section override it wherever they touch the fork's identity,
> infrastructure, or upstream relationship.

## The operating model

1. **We do not use the stock T3 Code Connect relay.** T3 Turbo runs its own private Connect
   stack: a self-hosted relay at `https://relay.t3turbo.pro` (Cloudflare Worker + tunnel), our
   own Clerk instance, and self-hosted Supabase Postgres. No Axiom, no APNs. The master runbook
   is `infra/README.md`. Client builds bake this config in from a repo-root `.env.local`
   (gitignored) whose authoritative values are the fork's GitHub Actions variables — see
   `docs/operations/local-build.md`. A build made without them silently compiles the Connect
   stack out.

2. **Customizations live in a seam.** Fork changes to upstream-owned files are centralized and
   tracked in two places: `SEAM.md` (human conflict guidance per file) and
   `.t3-turbo/customizations.json` (the machine-readable preservation contract, verified with
   `pnpm --dir scripts turbo:customizations:verify`). If you modify an upstream-owned file,
   register it in both. Keep Turbo-only work as a small, reviewable commit stack above the
   upstream SHA recorded in `.t3-turbo/upstream.json`.

3. **We ingest ALL upstream code daily.** The scheduled `turbo-nightly-sync.yml` workflow
   (11:00 PM Eastern) reads official `main` from `pingdotgg/t3code` and rebases the Turbo commit
   stack onto it. Upstream is strictly read-only from our side — **never push, open PRs, or
   write anything to `pingdotgg/t3code`.** The only push target is `gfsaaser24/t3code`.

4. **We ingest both main commits and official Nightly releases.** The newest published official
   Nightly source tag is the deterministic version anchor; ordinary commits pushed between
   Nightlies come along with `main`. We never download or republish an official installer —
   Turbo installers are always built from source in our own pipeline.

5. **Turbo changes always survive ingestion.** Every rebase candidate must pass the
   customization manifest before it can be built. On conflict, automation aborts, uploads a
   collision report, and opens an issue — it never chooses a resolution. When you resolve one:
   start from the new upstream file, reapply only the fork behavior described in `SEAM.md`, and
   drop a fork hunk only when upstream now provides the equivalent. Never hand-edit
   `.t3-turbo/upstream.json` and never delete checks to make a run green.

6. **Turbo state is isolated from the official T3 install.** The desktop app has its own
   identity (`com.gabef.t3turbo`, product name "T3 Turbo"), its own state home `~/.t3-turbo`
   (official uses `~/.t3`), and a fork-owned update feed (`nightly.yml` published only in
   `gfsaaser24/t3code`). Moving official data into Turbo happens only through the guarded
   one-way official import (`apps/server/src/turbo/officialImport/`): official state is opened
   read-only, the official app must be closed, and the staging/install path is serialized by a
   heartbeat-owned `.official-import.lock`. Never share a database, credentials, or environment
   identity between the two installs, and never modify official state.

7. **Official Turbo builds cover every ecosystem.** Published builds must include all desktop
   platforms — macOS (arm64 + x64 dmg), Linux (AppImage), and Windows (nsis) — using the
   platform matrix already in `.github/workflows/release.yml`, plus Android mobile via the
   inherited EAS workflows (this operator kit is Android-only; no APNs, so iOS is out of
   scope). The nightly sync currently publishes Windows x64 only; treat that as a gap to
   close, not the target state.

## Hard rules for agents on this branch

- Upstream `pingdotgg/t3code` is read-only. All pushes go to `gfsaaser24/t3code`.
- No secret values in this repository, ever. Placeholders in `<angle brackets>` resolve from the
  operator's private vault at deploy time. Client-public identifiers belong in `.env.local`, not
  in committed files.
- The `turbo-nightly-sync.yml` workflow file must stay byte-identical on `main` and `turbo`.
- Registered infrastructure branches (e.g. `infra/t3turbo-relay`) use normal reviewed merges and
  are never rebased or force-pushed by product ingestion.
- Some root scripts and docs inherited from upstream still assume the official repo or deploy
  targets. Check where a script points before running anything that publishes, deploys, or
  syncs.

Deeper reading: `docs/operations/turbo-runbook.md` (operator runbook — start here),
`docs/operations/turbo-changelog.md` (the fork's changelog; append an entry in every
behavior-changing PR), `docs/internals/t3-turbo-nightly-inbound.md` (full ingestion state
model), `.t3-turbo/README.md` (sync bootstrap), `infra/README.md` (self-host stack),
`docs/operations/local-build.md` (local installer builds).

---

_The upstream T3 Code agent guide follows. It applies unless it conflicts with the Turbo rules
above._

# T3 Code

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs (Codex, Claude Code, Cursor, Grok, OpenCode) and serves web, desktop, and mobile clients.

You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.

## What makes T3 Code special?

We have over 100,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks. We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of T3 Code's websocket layer (npx t3) enables a lot of awesome remote features. These have become core to the product. Whether users are connecting directly over their local network, using Tailscale, or leaning in fully with T3 Connect (our tunnel solution, also in this repo), we need to make sure new features are properly supported.

### 4. Multi-surface

T3 Code has 3 key app surfaces: **web**, **desktop**, and **mobile**.

**Web** is kind of two surfaces, as we have the public facing "app.t3.codes" as well as locally hosting the web app through the `npx t3` command. Both need to be supported by all new features where reasonable.

**Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well. The desktop app can also be used as the host server, allowing remote connections from app.t3.codes or the mobile app.

**Mobile** is a React Native app for both iOS and Android, available on the App Store and Google Play. The mobile app allows for connecting to any T3 Code server to control work remotely.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most T3 Code contributions will come from T3 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the T3 Code instance that the contributor is using.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing T3 Code.
- **we, us, and maintainers** mean Theo, Julius and the people building T3 Code. These are who you are talking to now.
- **user** means the person using T3 Code to direct coding agents.
- **agent** means the coding agent a user runs inside T3 Code. Depending on context, that may also include you.
- **provider** means the agent runtime or harness T3 Code talks to, such as Codex, Claude, Cursor, or OpenCode.
- **client** means the web, desktop, or mobile UI.
- **environment** means one running T3 server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **T3 home** means the base data directory. Runtime state normally lives below its userdata directory.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real T3 Code database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`
- **Providers.** Codex, Claude, Cursor, Grok, and OpenCode each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** `docs/` splits by audience. Behavior changes that a user would notice belong in `docs/user/` (shipped-product voice, no repo tooling or source paths); architecture and contributor changes in `docs/internals/`; runbooks in `docs/operations/`; new vocabulary in `docs/internals/glossary.md`.

## Dev servers

- `vp i` installs. Worktrees get this from the t3.json setup script; if module resolution looks broken, it probably did not run.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, paste that full URL (token included) in your reply. Do not wire up `tailscale serve` by hand for this, and do not open the URL yourself.
- The web app requires pairing. Hand over the pairing URL, not the bare origin. A URL without its token is useless to whoever you gave it to. If the token got consumed, mint a fresh one with `node apps/server/src/bin.ts pair` — note it carries standard scopes, while the startup URL carries admin scopes (needed for Settings → Connections management).
- Stop what you started, by the PID you tracked. See rule 1.

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- Copy from `~/.t3/userdata` (the developer's real data, the most realistic test set) or `~/.t3/dev`. Worktree state lives at `<worktree>/.t3/userdata`.
- Snapshot the database with `VACUUM INTO`, which is safe even while a server has the source open and yields one consistent file:

  ```bash
  mkdir -p .t3/userdata
  rm -f .t3/userdata/state.sqlite*  # VACUUM INTO refuses to overwrite
  bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.t3/userdata/state.sqlite'\")"
  ```

  A plain `cp` is only safe when no server has the source open, and must bring the `-wal` and `-shm` siblings along. A live file copy is a corrupt copy.

- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Smallest proof that the change works. `vp test run <files>` for the tests you touched, targeted lint and typecheck for the scope you changed.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- The server is event-sourced and its async flows emit typed receipts. Wait on receipts and worker drains, never on sleeps or polling. A test that needs a timeout to pass is wrong.
- Upon request, user-visible frontend changes should get one integrated pass in a real client: `test-t3-app` for web, `test-t3-mobile` for mobile. The primary agent does this once after integrating. Subagents do not launch their own dev servers. Ask permission before doing computer use or spinning up browsers.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- One concern per PR. If the description says "also", split it.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_, a pure _decider_ turns commands into persisted _events_, and a _projector_ derives the read model the UI renders. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Side effects run in queue-backed _reactors_ that emit _receipts_ when milestones land. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Full glossary with file links: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read `.repos/effect-smol/LLMS.md` before writing Effect code.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
