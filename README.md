# T3 Turbo — Self-Hosted Infrastructure (`infra/t3turbo-relay`)

> **This branch is the T3 Turbo operator repo.** It carries the complete, versioned
> kit for standing up the self-hosted stack: Cloudflare relay + tunnel, Clerk auth,
> and self-hosted Supabase Postgres — no Axiom, no APNs (Android-only operator).
> Accepted fork changes from `main` must be merged into this branch without rebasing
> away or replacing its operator commits. Desktop releases are built from `turbo`,
> not from this branch.

## Start here

| What                                                                           | Where                                                                  |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Master runbook (bring-up order, architecture, threat model, secrets inventory) | [`infra/README.md`](infra/README.md)                                   |
| Branch/upstream seam — preserved files + conflict guidance                     | [`SEAM.md`](SEAM.md)                                                   |
| Supabase: schema, seed, RLS, setup rules                                       | [`infra/supabase/`](infra/supabase/)                                   |
| Cloudflare Tunnel configs + systemd unit                                       | [`infra/cloudflared/`](infra/cloudflared/)                             |
| GitHub/Cloudflare vars & secrets checklist (names only)                        | [`infra/cloudflare/CHECKLIST.md`](infra/cloudflare/CHECKLIST.md)       |
| Last public production-state audit                                             | [`infra/cloudflare/STATUS.md`](infra/cloudflare/STATUS.md)             |
| Relay deploy guide (Hyperdrive, Clerk, verification)                           | [`infra/relay/DEPLOY.md`](infra/relay/DEPLOY.md)                       |
| OpenClaw branch/build preservation rule                                        | [`OPENCLAW-T3-TURBO-FORK-POLICY.md`](OPENCLAW-T3-TURBO-FORK-POLICY.md) |

**Hard rule:** no secret values in this repository — ever. Placeholders in `<angle brackets>`
are resolved from the operator's private vault at deploy time.

---

_Upstream T3 Code README follows below (kept for rebase context)._

# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and OpenCode. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build and OpenCode. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Try it out (install-free)

The easiest way to test T3 Code is to run the server in your terminal (requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx t3@latest
```

This will launch T3 Code's backend on your machine as well as the local web app to control your agents.

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## T3 Turbo downstream

This fork also builds **T3 Turbo**, our desktop-only downstream variant. Turbo ingests official
T3 source; it never downloads or republishes an official installer. The scheduled
[`T3-Turbo Nightly Sync`](./.github/workflows/turbo-nightly-sync.yml) workflow:

1. checks `pingdotgg/t3code:main` and the newest official Nightly tag every three hours;
2. verifies that both refs move forward from the `.t3-turbo/upstream.json`
   checkpoint stored on the `turbo` branch;
3. rebases the small Turbo commit stack in an isolated worktree;
4. builds the Linux WSL native dependency and an unsigned Windows x64 installer;
5. publishes the installer, blockmap, and `nightly.yml` only in this fork; and
6. advances the `turbo` branch only after publication succeeds.

If Git reports a conflict, the workflow leaves the current branch and release untouched, uploads
a conflict report, and opens or updates a review issue. It never guesses whether our change or
upstream's change should win.

### Configure the ingestion workflow

The workflow file must be identical on both `main` and `turbo`. `main` owns the schedule, while
`turbo` carries the workflow across upstream rebases. Enable the pipeline with the required
repository variable:

```powershell
gh variable set TURBO_NIGHTLY_ENABLED --body true --repo gfsaaser24/t3code
```

Optionally assign conflict issues to a GitHub account:

```powershell
gh variable set TURBO_NOTIFY_USER --body gfsaaser24 --repo gfsaaser24/t3code
```

No official T3 credentials or signing secrets are required for ingestion or packaging. Do not
store a personal access token as an Actions secret for this workflow. GitHub supplies its scoped
`GITHUB_TOKEN` to read public upstream metadata, open conflict issues, publish fork releases, and
advance the fork branch.

OpenClaw intervention alerts are optional. When used, configure
`TURBO_OPENCLAW_ENABLED=true` and the three repository secrets named in the
[nightly inbound runbook](./docs/internals/t3-turbo-nightly-inbound.md#email-and-openclaw-telegram-alerts).

### Run and inspect it

The local commands below assume GitHub CLI is authenticated with `gh auth login`.

```powershell
# Ask the workflow to check official main and Nightly source now.
gh workflow run turbo-nightly-sync.yml --ref main --repo gfsaaser24/t3code

# Inspect runs and published installers.
gh run list --workflow turbo-nightly-sync.yml --repo gfsaaser24/t3code --limit 5
gh release list --repo gfsaaser24/t3code --limit 5
```

A manual dispatch is a source check, not an unconditional rebuild. When the recorded upstream
`main` commit and Nightly tag are already current, the run succeeds without producing another
installer; the workflow currently has no force-rebuild input. A changed upstream ref produces a
deterministic `.turbo.N` version and a new installer on the fork's
[Releases page](https://github.com/gfsaaser24/t3code/releases).

For the complete state model, version rules, conflict recovery, updater behavior, permissions,
and troubleshooting checks, read [T3 Turbo nightly inbound updates](./docs/internals/t3-turbo-nightly-inbound.md).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).
