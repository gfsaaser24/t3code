# T3 Turbo

T3 Turbo is a desktop-only downstream variant that keeps its custom behavior in
small, reviewable modules on top of upstream T3 Code.

## Product identities

- Display name: `T3 Turbo`
- Installer and artifact prefix: `T3-Turbo`
- Application ID: `com.gabef.t3turbo`
- Electron user data: `t3-turbo`
- T3 home: `~/.t3-turbo`

These identities must remain separate from the official desktop app so both can
run on the same machine.

## Official environment integration

Turbo treats the running official T3 backend as an environment, not as files to
copy. The official runtime descriptor is discovered from
`~/.t3/userdata/server-runtime.json`, authenticated through the existing T3
pairing/session flow, and persisted in Turbo's encrypted connection catalog.

This makes the official backend the single writer and event source for its own
projects, threads, provider credentials, terminals, and running turns. Both
desktop clients receive the same snapshot and live WebSocket events. Turbo's
own backend remains available as a separate environment.

Directly launching two backend processes against the same `state.sqlite` is not
a synchronization mechanism. Each process owns an in-memory read model, queues,
reactors, providers, terminals, and live event streams. A second process can
therefore make decisions from stale state even when SQLite accepts both writes.
For that reason, "use official data" means attaching to the official process.

## Upstream nightlies

Turbo never installs official T3 Code binary assets. A source-sync workflow:

1. fetches upstream `main` plus the latest Nightly tag used as its version anchor;
2. calculates path overlap and a three-way merge report;
3. rebases the Turbo customization commits in an isolated checkout;
4. runs focused verification and builds Turbo-branded artifacts;
5. publishes only to the explicitly configured Turbo fork feed; and
6. stops with a conflict artifact and issue when human resolution is required.

`T3CODE_DESKTOP_UPDATE_REPOSITORY` is the only way to embed a GitHub update feed
in a Turbo build. `GITHUB_REPOSITORY` is intentionally ignored, and
`pingdotgg/t3code` is rejected as a Turbo feed.

The complete operator procedure is documented in
[T3 Turbo nightly inbound updates](./t3-turbo-nightly-inbound.md). It covers fork bootstrap,
checkpoint validation, manual checks, conflict recovery, runner selection, release outputs, and
OpenClaw/Telegram alert delivery.

### Build lifecycle at a glance

The scheduled workflow runs from the fork's `main` branch, while the candidate source and Turbo
customizations live on `turbo`:

1. Resolve the newest official Nightly and the current upstream `main` commit.
2. Compare both against `.t3-turbo/upstream.json` and stop cleanly when there is no update.
3. Rebase Turbo commits in an isolated worktree; never modify the live branch during conflict
   detection.
4. Build the Linux WSL `node-pty` prebuild, validate the source-aware tooling, and produce an
   unsigned Windows NSIS installer with a fork-owned `nightly.yml` feed.
5. Publish the installer, blockmap, and manifest only to `gfsaaser24/t3code`, then advance
   `turbo` with a lease check.

Conflict or build failure leaves the last published Turbo branch and release intact. A manual
workflow dispatch checks for source changes; it does not force a new installer when the checkpoint
is already current.

## Current task list

- [x] File preview breadcrumb navigation
- [x] File context menu actions
- [x] Alt-click expand/collapse all folders
- [x] Isolated T3 Turbo desktop identity
- [x] Explicit fork-only updater configuration
- [x] T3 Turbo environment selector
- [x] Official local environment discovery and pairing
- [x] Nightly source collision report and rebase workflow
- [x] Focused verification and Windows installer rebuild
