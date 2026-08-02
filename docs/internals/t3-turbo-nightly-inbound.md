# T3 Turbo nightly inbound updates

## The short version

T3 Turbo does not install Theo's official binaries. Every three hours, our GitHub workflow checks
Theo's public releases for a newer Nightly source tag. When one exists, it replays our small Turbo
commit stack on top of that source, verifies the result, builds a new unsigned T3 Turbo installer,
and publishes that installer only in `gfsaaser24/t3code`.

Theo's repository is always read-only from our side.

## The three pieces of state

| State                     | Purpose                                                                     |
| ------------------------- | --------------------------------------------------------------------------- |
| `pingdotgg/t3code`        | Read-only source of official Nightly tags and commits.                      |
| `gfsaaser24/t3code:main`  | Our fork's default branch. GitHub reads the scheduled workflow from here.   |
| `gfsaaser24/t3code:turbo` | The official source commit plus our reviewable Turbo customization commits. |

The file `.t3-turbo/upstream.json` records the exact official tag and commit currently underneath
our Turbo commits. It is the workflow's durable checkpoint.

## What happens every three hours

```text
Theo publishes a Nightly source release
                 |
                 v
Our workflow compares its version with upstream.json
        |                         |
        | already current         | newer version
        v                         v
      Stop              Fetch official source tag
                                  |
                                  v
                     Validate forward-only history
                                  |
                                  v
                  Rebase Turbo commits in a temporary worktree
                           |                   |
                           | conflict          | clean
                           v                   v
                  Report and stop       Run verification
                                               |
                                               v
                                  Build unsigned Windows installer
                                               |
                                               v
                              Publish release to our fork only
                                               |
                                               v
                              Advance the turbo branch safely
```

The schedule is `20 */3 * * *`, meaning minute 20 of every third UTC hour. The repository variable
`TURBO_NIGHTLY_ENABLED` is the master switch.

## Step-by-step

1. The workflow checks out our `turbo` branch with a sparse, read-only Git fetch.
2. It reads public release metadata from `pingdotgg/t3code`.
3. The dependency-free resolver selects the highest valid Nightly version, not merely the most
   recently published record.
4. If that version is not newer than `.t3-turbo/upstream.json`, the workflow succeeds and stops.
5. For a newer version, official tags are fetched into `refs/t3-turbo/official-tags/*`. This keeps
   official source tags separate from identically named T3 Turbo release tags in our fork.
6. Git verifies that the candidate is a descendant of our recorded source commit. A backward or
   unrelated update is rejected.
7. The workflow creates a temporary Git worktree and rebases our Turbo commits onto the new source
   commit. It never edits the live `turbo` branch during this stage.
8. A clean candidate is bundled and handed to isolated Linux and Windows build jobs.
9. Linux builds the WSL `node-pty` native module. Windows builds the T3 Turbo NSIS installer and
   update blockmap without any signing or official-service credentials.
10. The workflow requires a valid `nightly.yml` update manifest pointing at our fork-owned build.
11. Only after all validation succeeds does the publish job create a prerelease in
    `gfsaaser24/t3code` and advance `turbo` with `--force-with-lease`.

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
- Checkout credentials are not persisted in source or build workspaces.
- Only the final publish job receives `contents: write`.
- The publish script targets `gfsaaser24/t3code`; the packaging code rejects
  `pingdotgg/t3code` case-insensitively.
- The workflow never downloads, republishes, or modifies an official T3 installer.
- Branch advancement uses `--force-with-lease`, so an unexpected concurrent branch change stops
  the update instead of overwriting it.

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
and publish steps skipped.

## What requires human attention

Routine forward updates require nothing from us. Human review is needed only when:

- Git cannot rebase a Turbo customization cleanly;
- upstream history moves backward or becomes unrelated;
- tests or packaging fail on the rebased candidate; or
- we intentionally change the workflow and must copy the same YAML to both `main` and `turbo`.

Until the issue is resolved, the current branch and release remain the last known-good version.
