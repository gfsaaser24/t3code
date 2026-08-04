# T3 Turbo nightly inbound updates

## The short version

T3 Turbo does not install Theo's official binaries. Every three hours, our GitHub workflow checks
both upstream `main` and the newest published Nightly source tag. It replays our small Turbo commit
stack on top of the latest `main`, verifies the result, builds a new unsigned T3 Turbo installer,
and publishes that installer only in `gfsaaser24/t3code`.

`main` is the source we actually inherit. The Nightly tag is a trusted version anchor. This means
we receive ordinary commits pushed between official Nightly releases as well as the releases
themselves. Theo's repository is always read-only from our side.

## The three pieces of repository state

| State                     | Purpose                                                                   |
| ------------------------- | ------------------------------------------------------------------------- |
| `pingdotgg/t3code`        | Read-only source of official `main`, Nightly tags, and commits.           |
| `gfsaaser24/t3code:main`  | Our fork's default branch. GitHub reads the scheduled workflow from here. |
| `gfsaaser24/t3code:turbo` | The recorded upstream main commit plus our Turbo customization commits.   |

The file `.t3-turbo/upstream.json` is the workflow's durable checkpoint:

| Field        | Meaning                                                       |
| ------------ | ------------------------------------------------------------- |
| `repository` | The read-only official repository.                            |
| `branch`     | The cumulative source branch, currently `main`.               |
| `mainSha`    | The exact upstream main commit underneath our Turbo commits.  |
| `nightlyTag` | The official Nightly release used as the version anchor.      |
| `nightlySha` | The exact commit to which that official Nightly tag resolves. |
| `version`    | The last successfully published T3 Turbo updater version.     |

The companion `.t3-turbo/customizations.json` file is the machine-readable preservation contract.
It checks stable content markers at each Turbo integration seam instead of hashing whole files,
which lets ordinary upstream changes coexist with the fork while still failing when expected
modules, assets, behavior markers, tests, or policy text disappear. Each seam is labeled
`implemented`, `policy`, or `planned`; a planned seam verifies its reviewed design contract and
does not claim that the feature has shipped.

## Recreating the pipeline in a fork

The pipeline is fork-owned. It does not require access to Theo's GitHub account, an official T3
signing service, or official T3 runtime credentials. A new fork needs these pieces before the
first scheduled run:

1. A read-only upstream source at `pingdotgg/t3code` (the repository and branch are recorded in
   `.t3-turbo/upstream.json`).
2. A default `main` branch containing this workflow and a `turbo` branch containing the same
   workflow file plus the Turbo customization stack. The workflow blobs on both branches must be
   identical; the schedule is read from `main`, while inbound rebases carry the file forward on
   `turbo`.
3. GitHub Actions enabled for the fork, with the workflow allowed to write contents at the
   publish job and issues at the conflict-report job. The workflow-scoped `GITHUB_TOKEN` supplies
   these permissions; do not add a personal access token as an Actions secret.
4. The repository variable `TURBO_NIGHTLY_ENABLED=true`.
5. Optional conflict assignment with `TURBO_NOTIFY_USER=<github-login>`.
6. Optional OpenClaw secrets described in [Email and OpenClaw Telegram alerts](#email-and-openclaw-telegram-alerts).

Verify the branch and workflow wiring before enabling the schedule:

```powershell
gh repo view gfsaaser24/t3code --json defaultBranchRef,isFork,parent
git fetch origin main turbo
git rev-parse origin/main:.github/workflows/turbo-nightly-sync.yml
git rev-parse origin/turbo:.github/workflows/turbo-nightly-sync.yml
gh variable get TURBO_NIGHTLY_ENABLED --repo gfsaaser24/t3code
```

The two workflow blob hashes must match. The durable checkpoint must be committed on `turbo`; the
workflow updates it only inside the isolated candidate and publishes it with the candidate branch.
Never hand-edit `mainSha`, `nightlySha`, or `version` to bypass a failed rebase. If the checkpoint
is wrong, stop the schedule, compare it with the last successful release, and repair the branch
as a reviewed commit.

## What happens every three hours

```text
Upstream pushes main commits and periodically publishes a Nightly
                              |
                              v
Compare main and the Nightly anchor with upstream.json
                 |                            |
                 | already current            | changed
                 v                            v
               Stop              Fetch main and Nightly refs
                                               |
                                               v
                                  Validate forward-only history
                                               |
                                               v
                              Rebase Turbo commits temporarily
                                    |                    |
                                    | conflict           | clean
                                    v                    v
                              Report and stop       Run verification
                                                         |
                                                         v
                                            Build unsigned installer
                                                         |
                                                         v
                                        Publish only in our fork
                                                         |
                                                         v
                                     Advance turbo with a lease check
```

The schedule is `20 */3 * * *`, meaning minute 20 of every third UTC hour. The repository variable
`TURBO_NIGHTLY_ENABLED` is the master switch.

## Step-by-step

1. The workflow checks out our `turbo` branch with a sparse, read-only Git fetch.
2. It reads public release and `main` metadata from `pingdotgg/t3code`.
3. The dependency-free resolver selects the highest valid official Nightly and asks GitHub how
   many commits upstream `main` is ahead of it.
4. If neither the Nightly tag nor `main` changed, the workflow succeeds and stops.
5. Official `main` and Nightly refs are fetched into private `refs/t3-turbo/official-*` names.
   This keeps them separate from identically named T3 Turbo release tags in our fork.
6. Git verifies that the new `main` descends from our recorded `mainSha`, that the Nightly commit
   is contained in `main`, and that the official tag has not moved. A backward, divergent, or
   rewritten update is rejected.
7. The workflow creates a temporary Git worktree and rebases our Turbo commits onto the new main
   commit. It never edits the live `turbo` branch during this stage.
8. A clean rebase must pass the dependency-free customization manifest verifier inside the
   temporary candidate worktree. Missing seams fail the source job before a bundle is created.
9. The verified candidate is bundled and handed to isolated Linux and Windows build jobs.
10. Linux builds the WSL `node-pty` native module. Windows builds the T3 Turbo NSIS installer and
    update blockmap without signing or official-service credentials.
11. The workflow requires a valid `nightly.yml` update manifest for our fork-owned build.
12. Only after every check succeeds does the publish job create a prerelease in
    `gfsaaser24/t3code` and advance `turbo` with `--force-with-lease`.

The jobs are intentionally gated in sequence:

```text
sync_source
    |
    +-- conflict --> report artifact + issue; stop
    |
    +-- no update --> green run; build and publish skipped
    |
    +-- clean update --> build_wsl_node_pty --> build_windows --> publish --> advance turbo
```

`workflow_dispatch` has no inputs. A manual run asks the resolver to check the current upstream
state; it is not a force-rebuild switch. When `main` and the Nightly tag already match the
checkpoint, a successful run is expected to produce no installer.

## Validating a candidate locally

The source-aware resolver and report generator have focused tests. Run those before changing the
workflow or its checkpoint logic:

```powershell
node scripts/turbo-customization-manifest.ts verify
vp test run scripts/turbo-nightly-sync.test.ts scripts/turbo-customization-manifest.test.ts
```

The source job runs the verifier before it bundles the rebased candidate. The Windows build job
runs both focused tooling tests after installing dependencies. If upstream moves or replaces a
seam, update the manifest only in the same reviewed change that supplies and tests the replacement;
removing a check merely to make ingestion green violates the preservation policy. A full installer
requires the Linux `node-pty` artifact and the Windows toolchain used by Actions; the supported
packaging path is therefore the workflow's isolated build, not a local build against the live T3
userdata directory.

## How versions work between Nightlies

When upstream `main` exactly matches the newest Nightly tag, Turbo uses the official source
version:

```text
0.0.32-nightly.20260802.980
```

If `main` is one commit ahead, the deterministic Turbo version is:

```text
0.0.32-nightly.20260802.980.turbo.1
```

Two commits ahead becomes `.turbo.2`, and so on. This is valid semver on the same Electron
`nightly` channel. It is based on Git history instead of a clock or workflow run number, so the
same source always resolves to the same version. The next official Nightly naturally sorts above
the preceding `.turbo.N` snapshots.

The three-hour poll imports the cumulative `main` tip it observes. If several commits land between
polls, all of them arrive together in one rebased Turbo build; the workflow does not need one
installer per individual upstream commit.

## What happens when Git reports a conflict

Automation never chooses "ours" or "theirs." It:

1. records files changed by both upstream and Turbo;
2. records Git's genuinely unmerged paths and rebase error;
3. aborts the temporary rebase;
4. uploads the Markdown conflict report;
5. opens or updates a GitHub issue; and
6. leaves the current Turbo branch and installer release untouched.

The existing T3 Turbo installation therefore remains on the last known-good release until we
review the conflict and push a corrected commit stack.

## How the installed app receives our update

The T3 Turbo package embeds `gfsaaser24/t3code` as its GitHub update repository and uses the
`nightly` Electron update channel. It watches releases in our fork, not official T3 releases.

For each successful Turbo release, GitHub hosts:

- `T3-Turbo-<version>-x64.exe`;
- its `.blockmap`; and
- `nightly.yml`, containing the version, size, and SHA-512 checksum.

The installer is intentionally unsigned because this is our personal downstream workflow. Windows
may show SmartScreen. No Azure signing, Clerk, relay, or official T3 credentials are required.

## Permissions and safety boundaries

- Source and build jobs receive read-only repository permissions.
- Only the source-sync job receives issue-writing permission for conflict reports.
- Only the final publish job receives `contents: write`.
- The publish script targets `gfsaaser24/t3code`; packaging rejects `pingdotgg/t3code`
  case-insensitively.
- The workflow never downloads, republishes, or modifies an official T3 installer.
- Release retries are accepted only when the existing tag points at the same candidate commit.
- Branch advancement uses `--force-with-lease`, so an unexpected concurrent branch change stops
  the update instead of overwriting it.

The nightly workflow uses standard GitHub-hosted runners (`ubuntu-24.04` for source, native
dependency, publish, and notification jobs; `windows-2025` for the installer). The general CI
workflow keeps the upstream-only Blacksmith labels for `pingdotgg/t3code` and selects available
GitHub-hosted labels in this fork. A run that is queued indefinitely should be checked for a runner
label regression before changing the rebase logic.

## Email and OpenClaw Telegram alerts

GitHub Actions email and OpenClaw alerts cover different states. GitHub can email workflow
failures without any repository secret; enable Actions email for failed workflows in the GitHub
account notification settings. Conflicts are deliberately reported as review issues rather than
failed jobs, so `TURBO_NOTIFY_USER` is optional and only controls the issue assignee. The assignee
receives GitHub's normal issue notifications according to their account settings.

If an existing OpenClaw gateway already owns the Telegram channel, it can deliver the optional
intervention alerts. The workflow notification job runs only when the source rebase conflicts or a
sync/build/publish job fails. It does not send success or no-update messages. Enable OpenClaw's
authenticated `/hooks/agent` endpoint and configure:

| Kind     | Name                             | Value                                      |
| -------- | -------------------------------- | ------------------------------------------ |
| Variable | `TURBO_OPENCLAW_ENABLED`         | `true`                                     |
| Secret   | `TURBO_OPENCLAW_HOOK_URL`        | Full reachable `/hooks/agent` endpoint     |
| Secret   | `TURBO_OPENCLAW_HOOK_TOKEN`      | Dedicated OpenClaw hooks bearer token      |
| Secret   | `TURBO_OPENCLAW_TELEGRAM_TARGET` | Existing OpenClaw Telegram user or chat ID |

Configure those values without printing them into chat or logs:

```powershell
gh variable set TURBO_OPENCLAW_ENABLED --body true --repo gfsaaser24/t3code
gh secret set TURBO_OPENCLAW_HOOK_URL --repo gfsaaser24/t3code
gh secret set TURBO_OPENCLAW_HOOK_TOKEN --repo gfsaaser24/t3code
gh secret set TURBO_OPENCLAW_TELEGRAM_TARGET --repo gfsaaser24/t3code
```

The hook token must be dedicated to this hook; it must not be the OpenClaw gateway token or the
Telegram bot token. The endpoint must be reachable from a GitHub-hosted runner. A loopback-only or
private tailnet URL needs a trusted HTTPS reverse proxy/tunnel or a self-hosted runner. OpenClaw
should keep its hook restricted to the intended agent and reject unauthenticated requests.

The final notification job asks OpenClaw to run an isolated notification turn with `deliver: true`,
`channel: telegram`, and the configured target. The message includes the exact Actions run, the
manual workflow page, and the conflict issue when one exists. This repository does not store Slack
credentials or a Slack token. If the OpenClaw gateway is configured to mirror that Telegram alert
into an authenticated Slack DM/channel, the mirror is performed by OpenClaw; GitHub still sends
only the single authenticated hook request. Notification failure is deliberately
`continue-on-error` and cannot fail or roll back an update.

Verify wiring without exposing secret values:

```powershell
gh variable list --repo gfsaaser24/t3code
gh secret list --repo gfsaaser24/t3code
gh run list --workflow turbo-nightly-sync.yml --repo gfsaaser24/t3code --limit 5
gh release list --repo gfsaaser24/t3code --limit 5
```

To test the gateway itself, use OpenClaw's trusted host or its existing control channel. Do not
paste the bearer token into a workflow log, issue, Telegram message, or URL. A missing or rejected
alert never changes the source candidate or release outcome, so the Actions run remains the source
of truth.

GitHub does not provide a safe dispatch-by-GET link. The workflow page is intentionally a
confirm-then-run link; never place a personal access token in an email or Telegram URL.

## Current wiring and how to inspect it

The workflow file must remain identical on our `main` and `turbo` branches: `main` activates the
GitHub schedule, while `turbo` carries the workflow forward during rebases.

Useful checks:

```powershell
git status -sb
git rev-parse origin/main:.github/workflows/turbo-nightly-sync.yml
git rev-parse origin/turbo:.github/workflows/turbo-nightly-sync.yml
gh variable get TURBO_NIGHTLY_ENABLED --repo gfsaaser24/t3code
gh run list --workflow turbo-nightly-sync.yml --repo gfsaaser24/t3code --limit 5
```

The two workflow blob hashes should match. A normal no-update run is green with the rebase, build,
and publish jobs skipped. A `main` snapshot ahead of its Nightly anchor publishes with the
`.turbo.N` suffix described above.

## What requires human attention

Routine forward updates require nothing from us. Human review is needed only when:

- Git cannot rebase a Turbo customization cleanly;
- upstream history moves backward or becomes unrelated;
- tests or packaging fail on the rebased candidate; or
- we intentionally change the workflow and must copy the same YAML to both `main` and `turbo`.

Until the issue is resolved, the current branch and release remain the last known-good version.

## Troubleshooting by symptom

| Symptom                            | First checks                                                   | Expected interpretation                                                                 |
| ---------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| No sync job appears                | `TURBO_NIGHTLY_ENABLED`, Actions enabled, schedule time in UTC | A disabled variable causes the job to be skipped.                                       |
| Green run, no installer            | `sync_source` outputs and checkpoint                           | Upstream is already current; this is the normal no-update path.                         |
| Conflict issue/artifact            | Issue body, `turbo-rebase-report.md`, unmerged paths           | Resolve the Turbo commit stack, then rerun; the prior release is safe.                  |
| Build failure                      | `build_wsl_node_pty` and `build_windows` logs                  | The candidate was not published and `turbo` was not advanced.                           |
| No Telegram/Slack notice           | notification job, variable/secrets names, hook reachability    | OpenClaw delivery is optional and non-blocking; inspect the gateway separately.         |
| Run queued indefinitely            | job runner label and Actions runner availability               | Check for an accidental private runner label; do not rewrite history to work around it. |
| Publish refuses to advance `turbo` | branch history and `--force-with-lease` message                | Someone changed the branch concurrently; inspect before retrying.                       |

For any failed run, start with the run URL and job logs. Do not manually create a release from a
partial artifact or copy an official binary into the fork feed. The safe recovery is to fix the
candidate or workflow, rerun it, and let the publish job atomically create the fork-owned release.
