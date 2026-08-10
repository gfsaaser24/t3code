# T3 Turbo nightly inbound updates

## The short version

T3 Turbo does not install Theo's official binaries. Every day at 11:00 PM
`America/New_York`, our GitHub workflow resolves that local boundary to an exact UTC instant. It
selects upstream `main` and the newest published Nightly source tag at or before that instant,
replays our Turbo commit stack on top, verifies every registered customization seam, builds a new
unsigned T3 Turbo installer, and publishes that installer only in `gfsaaser24/t3code`.

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

| Field           | Meaning                                                       |
| --------------- | ------------------------------------------------------------- |
| `repository`    | The read-only official repository.                            |
| `branch`        | The cumulative source branch, currently `main`.               |
| `mainSha`       | The exact upstream main commit underneath our Turbo commits.  |
| `nightlyTag`    | The official Nightly release used as the version anchor.      |
| `nightlySha`    | The exact commit to which that official Nightly tag resolves. |
| `version`       | The last successfully published T3 Turbo updater version.     |
| `cutoffDate`    | The Eastern calendar date represented by that release.        |
| `cutoffInstant` | The exact UTC instant for 11:00 PM Eastern on that date.      |

The companion `.t3-turbo/customizations.json` file is the machine-readable preservation contract.
It checks stable content markers at each Turbo integration seam instead of hashing whole files,
which lets ordinary upstream changes coexist with the fork while still failing when expected
modules, assets, behavior markers, tests, or policy text disappear. Each seam is labeled
`implemented`, `policy`, or `planned`; a planned seam verifies its reviewed design contract and
does not claim that the feature has shipped. The same manifest registers infrastructure refs whose
state must be measured without bringing those branches into the product ingest. The
`relay-portal` entry currently owns `refs/heads/infra/t3turbo-relay`.

## Recreating the pipeline in a fork

The pipeline is fork-owned. It does not require access to Theo's GitHub account, an official T3
signing service, or official T3 runtime credentials. A new fork needs these pieces before the
first scheduled run:

1. A read-only upstream source at `pingdotgg/t3code` (the repository and branch are recorded in
   `.t3-turbo/upstream.json`).
2. A default `main` branch containing this workflow and a `turbo` branch containing the same
   workflow file plus the Turbo customization stack. The workflow blobs on both branches must be
   identical; the schedule is read from `main`, while inbound merges carry the file forward on
   `turbo`.
3. Every branch listed in `customizations.json`, including `infra/t3turbo-relay`. Registered
   infrastructure branches use normal reviewed merges and are never rebased or force-pushed by
   product ingestion.
4. GitHub Actions enabled for the fork, with the workflow allowed to write contents at the
   publish job and issues at the conflict and repair-report jobs. The workflow-scoped
   `GITHUB_TOKEN` supplies these permissions; do not add a personal access token as an Actions
   secret.
5. The repository variable `TURBO_NIGHTLY_ENABLED=true`.
6. Optional conflict or repair assignment with `TURBO_NOTIFY_USER=<github-login>`.
7. Optional OpenClaw secrets described in [Email and OpenClaw Telegram alerts](#email-and-openclaw-telegram-alerts).

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
Never hand-edit `mainSha`, `nightlySha`, or `version` to bypass a failed ingest. If the checkpoint
is wrong, stop the schedule, compare it with the last successful release, and repair the branch
as a reviewed commit.

## What happens every night

```text
Upstream pushes main commits and periodically publishes a Nightly
                              |
                              v
Resolve the latest completed 11 PM Eastern cutoff instant
                              |
                              v
Select main and the Nightly anchor at or before that instant
                 |                            |
                 | already built for this run  | new daily cutoff/source
                 v                            v
               Stop              Fetch main and Nightly refs
                                               |
                                               v
                                  Validate forward-only history
                                               |
                                               v
                               Merge upstream in temp worktree
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

The timezone-aware schedule is `0 23 * * *` with `America/New_York`, so daylight-saving changes do
not move the 11:00 PM Eastern cutoff. A delayed runner still queries the source state at the exact
scheduled boundary. A manual run before 11:00 PM uses the prior completed cutoff instead of
claiming a future boundary. The repository variable `TURBO_NIGHTLY_ENABLED` is the master switch.

## Step-by-step

1. The workflow checks out our `turbo` branch with a sparse, read-only Git fetch, reads the
   `relay-portal` ref from the manifest, and records that branch's commit before ingestion.
2. The dependency-free resolver turns the latest completed 11:00 PM Eastern boundary into a UTC
   instant, including the correct daylight-saving offset.
3. It reads public metadata from `pingdotgg/t3code`: the latest `main` commit returned by GitHub's
   `until` filter and the highest valid Nightly whose `published_at` timestamp is no later than the
   same cutoff. GitHub then reports how many commits that exact main snapshot is ahead of the
   Nightly anchor.
4. The resolver assigns the cutoff date and GitHub workflow run number to a unique updater version.
   A scheduled run therefore builds once for every nightly cutoff even when upstream has no new
   commit. An exact rerun that was already published is idempotent and stops.
5. Official `main` and Nightly refs are fetched into private `refs/t3-turbo/official-*` names.
   This keeps them separate from identically named T3 Turbo release tags in our fork.
6. Git verifies that the new `main` descends from our recorded `mainSha`, that the Nightly commit
   is contained in `main`, and that the official tag has not moved. A backward, divergent, or
   rewritten update is rejected.
7. The workflow creates a temporary Git worktree and merges the new `main` commit into our Turbo
   branch. It never edits the live `turbo` branch during this stage. It merges rather than
   rebases because `turbo` is not a linear stack above the recorded anchor — it carries merge
   commits of its own, so replaying it would re-litigate conflicts those merges already settled.
8. A clean merge must pass the dependency-free customization manifest verifier inside the
   temporary candidate worktree. Missing seams fail the source job before a bundle is created.
   The manifest, not the shape of the history, is the preservation contract.
9. The verified candidate is bundled and handed to isolated Linux and Windows build jobs.
10. Linux builds the WSL `node-pty` native module. Windows builds the T3 Turbo NSIS installer and
    update blockmap without signing or official-service credentials.
11. The Windows candidate runs focused tests for the registered branding, explorer, Markdown,
    image-preview, multi-chat, official-import, and nightly workflow seams. The workflow also
    requires a valid `nightly.yml` update manifest for our fork-owned build.
12. Only after every check succeeds does the publish job create a prerelease in
    `gfsaaser24/t3code` and advance `turbo` with `--force-with-lease`.
13. The publish job fetches the same registered relay/portal ref again and records whether its
    commit stayed fixed or moved independently during the run. It then records the cutoff,
    upstream/prior/resulting SHAs, validation status, measured infrastructure state, installer
    SHA-256, and release URL in the release notes, Actions summary, and a downloadable report.

The jobs are intentionally gated in sequence:

```text
sync_source
    |
    +-- conflict --> report artifact + issue; stop
    |
    +-- exact published rerun --> green run; build and publish skipped
    |
    +-- clean update --> build_wsl_node_pty --> build_windows --> publish --> advance turbo
```

`workflow_dispatch` has no inputs. Every new manual workflow run gets its own monotonic run number,
so it can safely rebuild the latest completed Eastern cutoff. Re-running the exact same GitHub run
reuses the same version and source candidate.

## Validating a candidate locally

The source-aware resolver and report generator have focused tests. Run those before changing the
workflow or its checkpoint logic:

```powershell
node scripts/turbo-customization-manifest.ts verify
vp test run scripts/turbo-nightly-sync.test.ts scripts/turbo-customization-manifest.test.ts
```

The source job runs the verifier before it bundles the merged candidate. The Windows build job
runs the tooling tests plus the focused feature tests named directly in the workflow; marker
presence alone is not proof that a behavior still works. If upstream moves or replaces a seam,
update the manifest only in the same reviewed change that supplies and tests the replacement;
removing a check merely to make ingestion green violates the preservation policy. A full installer
requires the Linux `node-pty` artifact and the Windows toolchain used by Actions; the supported
packaging path is therefore the workflow's isolated build, not a local build against the live T3
userdata directory.

## How daily versions work

The official Nightly remains the source/version anchor. T3 Turbo then appends the Eastern cutoff
date and GitHub workflow run number. For an August 4 cutoff in workflow run 42:

```text
0.0.32-nightly.20260803.986.turbo.20260804.42
```

This remains valid semver on the Electron `nightly` channel, advances once per workflow invocation,
and makes repeat attempts deterministic. The GitHub release title is `T3 Turbo MM-DD-YY.exe`, which
states the 11:00 PM Eastern ingestion cutoff. The updater assets retain their version and
architecture in their filenames because `nightly.yml` addresses them by those exact names.

The nightly cutoff imports the newest cumulative `main` commit at or before the recorded instant.
If several commits land during the day, all of them arrive together in one merged Turbo build.
Commits and Nightly releases after that instant wait for the following cutoff even when the runner
starts late.

## Successful-run report

The completion report is generated from validated workflow inputs rather than handwritten shell
text. It records the exact cutoff instant, upstream main SHA, official Nightly tag/SHA, prior Turbo
SHA, resulting Turbo SHA, manifest and focused-test results, measured relay/portal branch state,
installer name and SHA-256, and the fork release link. The same Markdown is used for the release
notes, appended to the Actions job summary, and uploaded as `turbo-success-report-<tag>`.

The relay/portal line is not a handwritten claim. The workflow resolves the `relay-portal` branch
name from `customizations.json`, records its commit before ingestion, fetches that same ref again
before publication, and reports both SHAs. Equal SHAs mean the branch stayed fixed. Different SHAs
mean it moved independently during the run; product ingestion still did not deploy it.

## What happens when Git reports a conflict

Automation never chooses "ours" or "theirs." It:

1. records files changed by both upstream and Turbo;
2. records Git's genuinely unmerged paths and the merge output;
3. aborts the temporary merge;
4. uploads the Markdown conflict report;
5. opens or updates a GitHub issue; and
6. leaves the current Turbo branch and installer release untouched.

The issue gives the exact recovery route: branch from the unchanged `turbo` tip, resolve each
collided file starting from the new upstream version and reapplying only the `SEAM.md` behavior, and open a reviewed PR back to `turbo`. If the workflow changes, its
blob must also land identically on `main` before retry. The existing installation remains on the
last known-good release until that corrected stack is reviewed and pushed.

## What happens when verification or building fails

Manifest, focused seam, branding, icon, native-module, installer, and publish failures all stop
before `turbo` advances. A final workflow job opens or updates a repair issue with every job result,
the exact Actions run, and this required repair path:

1. create `repair/turbo-nightly-<run-id>` from the unchanged `turbo` branch;
2. reproduce the first failed focused check and repair its registered seam or pipeline guard;
3. keep the manifest marker and regression test with the repair, running the manifest verifier,
   named focused tests, and `pnpm icons:turbo:check` when branding or icons are involved;
4. open a reviewed PR back to `turbo`, mirroring workflow changes identically onto `main`; and
5. rerun ingestion only after the repaired stack becomes the new last known-good base.

Do not delete checks to make the run green, hand-edit `.t3-turbo/upstream.json`, publish a partial
artifact, or advance the product branch around the failed candidate.

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
- Only the source-sync and final repair-report jobs receive issue-writing permission.
- Only the final publish job receives `contents: write`.
- The publish script targets `gfsaaser24/t3code`; packaging rejects `pingdotgg/t3code`
  case-insensitively.
- The workflow never downloads, republishes, or modifies an official T3 installer.
- The candidate tag is pushed with an expect-absent lease before release creation. Release retries
  are accepted only when the existing tag points at the same candidate commit.
- Branch advancement uses `--force-with-lease`, so an unexpected concurrent branch change stops
  the update instead of overwriting it.

The nightly workflow uses standard GitHub-hosted runners (`ubuntu-24.04` for source, native
dependency, publish, and notification jobs; `windows-2025` for the installer). The general CI
workflow keeps the upstream-only Blacksmith labels for `pingdotgg/t3code` and selects available
GitHub-hosted labels in this fork. A run that is queued indefinitely should be checked for a runner
label regression before changing the merge logic.

## Email and OpenClaw Telegram alerts

GitHub Actions email and OpenClaw alerts cover different states. GitHub can email workflow
failures without any repository secret; enable Actions email for failed workflows in the GitHub
account notification settings. Conflicts are deliberately reported as review issues rather than
failed jobs, so `TURBO_NOTIFY_USER` is optional and only controls the issue assignee. The assignee
receives GitHub's normal issue notifications according to their account settings.

If an existing OpenClaw gateway already owns the Telegram channel, it can deliver the optional
intervention alerts. The workflow notification job runs only when the source merge conflicts or a
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
GitHub schedule, while `turbo` carries the workflow forward during merges.

Useful checks:

```powershell
git status -sb
git rev-parse origin/main:.github/workflows/turbo-nightly-sync.yml
git rev-parse origin/turbo:.github/workflows/turbo-nightly-sync.yml
gh variable get TURBO_NIGHTLY_ENABLED --repo gfsaaser24/t3code
gh run list --workflow turbo-nightly-sync.yml --repo gfsaaser24/t3code --limit 5
```

The two workflow blob hashes should match. Each new scheduled or manually dispatched run publishes
with the daily `.turbo.YYYYMMDD.RUN` suffix described above. Only an exact already-published rerun
uses the green no-build path.

## What requires human attention

Routine forward updates require nothing from us. Human review is needed only when:

- Git cannot merge upstream into a Turbo customization cleanly;
- upstream history moves backward or becomes unrelated;
- manifest, focused seam, icon, native build, packaging, or publication checks fail; or
- we intentionally change the workflow and must copy the same YAML to both `main` and `turbo`.

Until the issue is resolved, the current branch and release remain the last known-good version.

## Troubleshooting by symptom

| Symptom                            | First checks                                                     | Expected interpretation                                                                 |
| ---------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| No sync job appears                | `TURBO_NIGHTLY_ENABLED`, Actions enabled, 11 PM Eastern schedule | A disabled variable causes the job to be skipped.                                       |
| Green run, no installer            | `sync_source` outputs and checkpoint                             | The exact workflow run/version was already published; inspect if this was not a retry.  |
| Conflict issue/artifact            | Issue body, `turbo-rebase-report.md`, unmerged paths             | Resolve the merge conflict, then rerun; the prior release is safe.                      |
| Build or seam failure              | Repair issue plus the first failed job log                       | The candidate was not published; follow the documented repair PR path.                  |
| No Telegram/Slack notice           | notification job, variable/secrets names, hook reachability      | OpenClaw delivery is optional and non-blocking; inspect the gateway separately.         |
| Run queued indefinitely            | job runner label and Actions runner availability                 | Check for an accidental private runner label; do not rewrite history to work around it. |
| Publish refuses to advance `turbo` | branch history and `--force-with-lease` message                  | Someone changed the branch concurrently; inspect before retrying.                       |

For any failed run, start with the generated repair issue and its run URL. Do not manually create a
release from a partial artifact or copy an official binary into the fork feed. The safe recovery is
the reviewed repair branch and PR described above, followed by a clean rerun that lets the publish
job atomically create the fork-owned release.
