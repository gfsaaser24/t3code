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
8. A clean candidate is bundled and handed to isolated Linux and Windows build jobs.
9. Linux builds the WSL `node-pty` native module. Windows builds the T3 Turbo NSIS installer and
   update blockmap without signing or official-service credentials.
10. The workflow requires a valid `nightly.yml` update manifest for our fork-owned build.
11. Only after every check succeeds does the publish job create a prerelease in
    `gfsaaser24/t3code` and advance `turbo` with `--force-with-lease`.

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

## Email and Telegram alerts

GitHub can email workflow failures without any repository secret. In the GitHub account's
notification settings, enable Actions email for failed workflows. Conflicts are deliberately
reported as review issues instead of failed builds, so set the repository variable
`TURBO_NOTIFY_USER` to the GitHub username that should be assigned and emailed.

Telegram is optional and intervention-only. Configure:

| Kind     | Name                       | Value                              |
| -------- | -------------------------- | ---------------------------------- |
| Variable | `TURBO_TELEGRAM_ENABLED`   | `true`                             |
| Secret   | `TURBO_TELEGRAM_BOT_TOKEN` | Token issued by Telegram BotFather |
| Secret   | `TURBO_TELEGRAM_CHAT_ID`   | Destination user or chat ID        |

The final notification job calls Telegram's `sendMessage` endpoint directly. It does not import a
third-party action, and notification failure cannot fail or roll back an update. Alerts include
the exact Actions run, the conflict issue when one exists, and the authenticated GitHub workflow
page where a manual run can be confirmed.

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
