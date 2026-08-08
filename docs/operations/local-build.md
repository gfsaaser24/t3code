# Local Windows installer builds

How to cut a T3 Turbo installer from `turbo` on a local machine so it matches
what CI nightlies produce — including the self-hosted T3 Connect stack, which
is **build-time configuration** and silently compiles out when missing.

> Why this document exists: on 2026-08-08 three local builds shipped without
> the connect config. The Clerk sign-in and relay integration vanished from
> the app, and it looked like a source regression. Nothing in the source was
> wrong — the builds were made without the variables CI injects.

## 1. Connect config — the part that must never be skipped

The client bakes the self-host connect config in at build time:

- `scripts/lib/public-config.ts` reads `T3CODE_*` env **or** a repo-root
  `.env` / `.env.local`, and bridges the values to `VITE_*`.
- `apps/web/vite.config.ts` compiles them into the web bundle.
- `apps/web/src/main.tsx` mounts Clerk **only when the publishable key is
  non-empty** — an unconfigured build has no sign-in button and no relay.

Create a repo-root `.env.local` (it is **gitignored** — it never lands on
`turbo` or anywhere online) with these four keys:

```
T3CODE_CLERK_PUBLISHABLE_KEY=…
T3CODE_CLERK_JWT_TEMPLATE=…
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=…
T3CODE_RELAY_URL=https://<RELAY_DOMAIN>
```

The authoritative values are the fork's Actions variables — the same source
CI nightlies use (`.github/workflows/release.yml`, `relay_public_config` job):

```
gh variable list --repo gfsaaser24/t3code
# RELAY_DOMAIN → T3CODE_RELAY_URL (as https://<value>)
# CLERK_PUBLISHABLE_KEY / CLERK_JWT_TEMPLATE / CLERK_CLI_OAUTH_CLIENT_ID → the rest
```

Keeping the literals out of this document and out of git means the committed
tree stays value-free; the file on disk is the only carrier, and CI keeps
using the variables directly. (The values are client-public — they ship
inside every installer — but they still don't belong in the branch.)

## 2. Version

The fork versions on its own counter, independent of upstream. Bump the
patch version in all three manifests for every shipped build:

```
apps/desktop/package.json
apps/server/package.json
apps/web/package.json
```

Commit the bump to `turbo`. (History: 0.0.35 started the independent line,
0.0.36 added the personal `~/.t3` backend, 0.0.37 restored the connect
config to local builds.)

## 3. Build

```powershell
pnpm install --frozen-lockfile
Remove-Item release -Recurse -Force -ErrorAction SilentlyContinue
pnpm dist:desktop:win:x64
```

Artifacts land in `release/` (`T3-Turbo-<version>-x64.exe`). The
`No WSL node-pty prebuild` warning is expected locally — it only affects the
WSL backend, which CI builds on Linux.

## 4. Verify before installing — do not assume

The connect config failure mode is **silent**. Prove the artifact carries it
by extracting the installer (7za lives in electron-builder's cache at
`%LOCALAPPDATA%\electron-builder\Cache\7zip@*\...\7za.exe`):

```powershell
& $7za x release\T3-Turbo-<v>-x64.exe -o$env:TEMP\t3check -y
# app.asar        → must contain the Clerk publishable key
# app.asar.unpacked (web assets) → must contain the relay domain,
#                                  JWT template name, CLI OAuth client id
Select-String -Path $env:TEMP\t3check\resources\app.asar -Pattern $clerkKey -SimpleMatch
Get-ChildItem $env:TEMP\t3check\resources\app.asar.unpacked -Recurse -Filter *.js |
  Select-String -Pattern 'relay\.' -List | Select-Object -First 3
```

Zero hits on any marker = unconfigured build. Fix `.env.local`, rebuild.
Also worth spot-checking whatever the build was supposed to change
(server fixes live in `app.asar` as `apps/server/dist/bin.mjs`).

## 5. Install

Close the running T3 Turbo first — the installer targets
`%LOCALAPPDATA%\Programs\t3-turbo` and replaces it in place. User data
(`~/.t3-turbo`, `~/.t3`) is never touched by install/uninstall.

## Fresh-worktree checklist

A brand-new worktree is missing three things a long-lived checkout has:

- [ ] `.env.local` (section 1) — or the connect stack compiles out
- [ ] `pnpm install` — and note desktop unit tests need Electron's
      postinstall, which worktrees often skip
- [ ] version bump (section 2)
