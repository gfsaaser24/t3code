# T3 Turbo operator runbook

The single index for operating this fork. Each procedure lives where it's deepest; this file
holds the procedures that had no home and points at the ones that do. Pair it with the
[changelog](./turbo-changelog.md) — every change that alters one of these procedures updates
both files in the same PR.

## Where everything is tracked

| What                                            | Where                                                               | Verify with                                      |
| ----------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| Fork changes to upstream-owned files            | `SEAM.md` (conflict guidance per file)                              | manual review on conflict                        |
| Machine-enforced customization seams            | `.t3-turbo/customizations.json`                                     | `pnpm --dir scripts turbo:customizations:verify` |
| Upstream checkpoint (SHA, nightly tag, version) | `.t3-turbo/upstream.json`                                           | never hand-edit; the sync workflow owns it       |
| Human-readable history                          | [`turbo-changelog.md`](./turbo-changelog.md)                        | appended in every behavior-changing PR           |
| The Turbo commit stack                          | `git log origin/turbo --not <upstream.json mainSha> --first-parent` | —                                                |

## Registering a new customization (checklist)

1. Keep the change as a small, reviewable commit on a branch off `turbo`; PR into `turbo`.
2. If it touches an upstream-owned file: add a `SEAM.md` entry (label + conflict guidance).
3. Add or extend a seam in `.t3-turbo/customizations.json` with stable content markers —
   markers survive normal upstream edits; whole-file hashes do not.
4. Run `pnpm --dir scripts turbo:customizations:verify` — must pass before merge.
5. Append a [changelog](./turbo-changelog.md) entry in the same PR.

**Gotcha:** a commit staging _only_ `.plans/` files fails the pre-commit hook — the formatter
ignore-lists that directory and errors on an empty target set. Stage a formatter-eligible file
in the same commit (a changelog or runbook line usually belongs in it anyway).

## Nightly sync operations

Full state model: [t3-turbo-nightly-inbound.md](../internals/t3-turbo-nightly-inbound.md).

```powershell
# Trigger a source check now (no-op when upstream refs are current)
gh workflow run turbo-nightly-sync.yml --ref main --repo gfsaaser24/t3code
# Inspect runs and releases
gh run list --workflow turbo-nightly-sync.yml --repo gfsaaser24/t3code --limit 5
gh release list --repo gfsaaser24/t3code --limit 5
```

On conflict the workflow aborts, uploads a collision report, and opens an issue. Resolving one:
start from the new upstream file, reapply only the behavior described in `SEAM.md`, drop a fork
hunk only when upstream now provides the equivalent, re-run the manifest verifier and the
focused tests for the touched seams. Never resolve with blanket `ours`/`theirs`, never hand-edit
`upstream.json`, never delete checks to go green.

## Shipping a release (version rules)

The fork versions on its own 0.0.x counter, independent of upstream. Never downgrade — the
updater compares versions. Per shipped build:

1. Bump the patch version in all three manifests: `apps/desktop/package.json`,
   `apps/server/package.json`, `apps/web/package.json`. Commit to `turbo`.
2. Build and verify the desktop installer: [local-build.md](./local-build.md). The Connect
   config comes from repo-root `.env.local` (values = the fork's Actions variables via
   `gh variable list --repo gfsaaser24/t3code`); a build without it silently compiles the
   Connect stack out — always extract-and-grep the artifact per that runbook.
3. Redeploy the hosted web app from the same tip (below) so the exact-string version compare in
   `versionSkew.ts` matches.
4. Append the changelog entry.

## Deploying the hosted web app (app.t3turbo.pro)

Cloudflare Worker `t3turbo-hosted-app`, account `1b9d91cd7176bde5ce433d2aa7d2da16`, config
`apps/web/wrangler.hosted.jsonc`. From the repo root, on the turbo tip being shipped:

```powershell
$env:VITE_HOSTED_APP_CHANNEL = 'latest'
$env:VITE_HOSTED_APP_URL = 'https://app.t3turbo.pro'
pnpm --filter @t3tools/web run build
```

Verify before deploying — the unconfigured-build failure mode is silent:

```powershell
Get-ChildItem apps\web\dist\assets -Filter *.js |
  Select-String -List -Pattern 'relay.t3turbo.pro' -SimpleMatch   # relay baked in
# also grep for the Clerk publishable key and the version string
```

```powershell
Set-Location apps\web
$env:CLOUDFLARE_ACCOUNT_ID = '1b9d91cd7176bde5ce433d2aa7d2da16'
npx wrangler deploy --config wrangler.hosted.jsonc
```

Post-deploy: fetch `https://app.t3turbo.pro/`, follow the entry script, confirm it carries the
new version string.

## Self-hosted stack

Master runbook: [infra/README.md](../../infra/README.md) (relay Worker, Cloudflare tunnel,
Clerk, Supabase). Relay deploys: [infra/relay/DEPLOY.md](../../infra/relay/DEPLOY.md) or the
`deploy-relay.yml` manual dispatch. Registered infra branches (`infra/t3turbo-relay`) take
normal reviewed merges only — never rebased by product ingestion.

## Hard boundaries (never cross)

- `pingdotgg/t3code` is read-only. The only push target is `gfsaaser24/t3code`.
- No secret values in the repository; `<angle bracket>` placeholders resolve from the private
  vault at deploy time.
- `turbo-nightly-sync.yml` stays byte-identical on `main` and `turbo`.
- Turbo state (`~/.t3-turbo`) and official state (`~/.t3`) never share a database, credentials,
  or identity; official data moves only through the guarded one-way import.
