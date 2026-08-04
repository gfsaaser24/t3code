# OpenClaw Rule: T3 Turbo Fork Policy

**Status:** Authoritative downstream-build rule

**Owner:** Gabe

**Last reviewed:** 2026-08-04

**Applies to:** Every OpenClaw task that reads, syncs, rebases, builds, releases, or
maintains the T3 Turbo fork.

OpenClaw must read this file before touching the T3 Turbo repository. This policy
describes the fork contract. It is not permission to erase, skip, or silently
rewrite fork work.

## 1. Product identity and legal boundary

- The downstream product is **T3 Turbo**. Use that name on every user-facing
  surface, generated app, installer, release title, login/splash screen, CLI
  message, relay surface, cloud-function description, and notification.
- Preserve the MIT license and its attribution to T3 Tools / T3 Code. Branding
  the fork does not remove or rewrite the upstream legal attribution.
- Keep compatibility identifiers such as the `t3code` protocol and package
  names when changing them would break existing clients or update paths. Those
  identifiers are not product-brand exceptions.
- The only deliberately skipped distribution step is **npm publishing**. Do not
  infer that any other build, release, relay, desktop, web, or documentation
  work may be skipped.

## 2. Branch and source-of-truth model

There are five different refs in this project. Never conflate them or treat one
as a substitute for another:

| Ref                                     | Role                                                                                         | Build from it?               |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------- |
| `pingdotgg/t3code:main`                 | Read-only upstream source                                                                    | No                           |
| Official T3 Code Nightly tag            | Read-only version/source anchor                                                              | No                           |
| `gfsaaser24/t3code:main`                | Reviewed fork integration branch and current relay workflow entry point                      | No desktop build             |
| `gfsaaser24/t3code:turbo`               | Downstream desktop source: upstream base plus every Turbo customization                      | **Yes, desktop**             |
| `gfsaaser24/t3code:infra/t3turbo-relay` | Durable relay/operator source: `main` plus Cloudflare, tunnel, Supabase, and runbook commits | **Yes, relay/operator only** |

The artifact must be built from the candidate produced from `turbo`, never from
the fork `main` branch, an official Nightly checkout, a pull-request merge ref,
or a run-specific staging branch.

Every commit and path that belongs to the fork is required input. A customization
does not become optional because it is on a different branch, is not part of the
latest upstream diff, or conflicts with a new upstream file.

`infra/t3turbo-relay` is not a disposable staging branch. It must retain its own
operator commits and receive accepted `main` changes by merge. Never recreate it
from `main`, force-push over it, or omit it from the branch-union audit. The relay
deployment workflow currently triggers from `main`; until that is deliberately
moved, record `main` as the live deploy ref and the relay branch as the operator
source of truth. Do not silently claim they are already the same thing.

## 3. Mandatory branch-union audit

Before the first build after adopting this policy, and before every daily sync:

1. Fetch all relevant refs without deleting local evidence:
   `origin/main`, `origin/turbo`, `origin/infra/t3turbo-relay`, all other remote
   branches used for fork work, the upstream `main`, and the selected official
   Nightly tag.
2. Read `.t3-turbo/upstream.json`. Treat its recorded `mainSha`, `nightlySha`,
   and `version` as a checkpoint, not as permission to overwrite history.
3. Compare the fork refs from their merge base. Use commit and path inventories
   (for example `git log --left-right --cherry-pick` and
   `git diff --name-status`) to identify the union of fork-only work.
4. Replay or merge **all** desktop/app fork-only commits into the downstream
   `turbo` stack.
   If a commit is already represented by an equivalent patch, record that fact;
   do not duplicate it. If it is not represented, it must remain in the stack.
5. Separately merge accepted `main` into a candidate based on
   `origin/infra/t3turbo-relay`. Preserve the relay branch's Cloudflare, tunnel,
   Supabase, SQL, and runbook commits even when those paths do not affect the
   desktop artifact.
6. Confirm that the resulting candidates contain every fork-only path before
   building. Keep a machine-readable inventory or Markdown report with the
   source SHAs, fork SHAs, retained commit list, and retained path list.

Before publishing the relay candidate, both ancestry checks must succeed:

```sh
git merge-base --is-ancestor origin/main <relay-candidate>
git merge-base --is-ancestor origin/infra/t3turbo-relay <relay-candidate>
```

A normal fast-forward or reviewed merge may advance `infra/t3turbo-relay`. A
force-push, reset, or history rewrite may not.

The current refs are known to have diverged. That is expected evidence, not a
reason to choose one side and discard the other. The Turbo environment switcher,
explorer navigation, and related desktop/web changes are fork-owned. The newer
branding, relay, self-hosting, and release-policy changes on fork `main` are
also fork-owned. The Cloudflare, tunnel, Supabase, and operator-runbook commits
on `infra/t3turbo-relay` are fork-owned too. The daily process must reconcile the
desktop/app union into `turbo` and the accepted `main` history into the relay
branch. Neither destination may be used to erase the other branch's unique work.

## 4. Rebase and collision rules

- Rebase the complete Turbo customization stack onto the newest accepted
  upstream `main` in a disposable worktree. Do not mutate the live `turbo`
  branch during collision detection.
- Merge accepted `main` into the relay candidate. Do not rebase or recreate the
  published `infra/t3turbo-relay` branch; preserve its existing tip as an
  ancestor of the candidate.
- Never run `git rebase --skip`, `git reset --hard` to an upstream ref, or a
  pathspec/exclusion that drops a Turbo file or commit. “Upstream won” is not a
  valid automatic conflict strategy.
- A conflict is a review stop, not a partial build. Preserve the last known-good
  Turbo branch and release; do not publish a candidate that is missing any
  fork-only commit or path.
- On conflict, capture: old/new upstream and Nightly SHAs, the retained Turbo
  commit range, files changed by both sides, genuinely unmerged paths, and the
  full rebase error. Open or update a GitHub issue/PR with that report and send
  Gabe the run URL, review URL, and exact files requiring a decision.
- Only after a human-reviewed resolution is committed may the next run retry the
  rebase. A green workflow that only produced a conflict artifact is **not** a
  successful build.

## 5. Daily build schedule and lifecycle

Run one scheduled Turbo build attempt per day at **11:00 PM America/New_York**.
The release cutoff is the local date at that instant. If a scheduler only accepts
UTC, calculate the America/New_York occurrence with daylight-saving changes;
do not use a fixed UTC hour that drifts from 11:00 PM ET. Use one lock/concurrency
key so a retry cannot create two releases for the same cutoff. When source or
fork history advanced, publish the one resulting artifact for that cutoff. When
the checkpoint is already current, report a verified no-op rather than creating a
duplicate release with the same source/version.

Each daily run must:

1. Fetch upstream `main` and the newest valid official Nightly tag.
2. Validate forward-only ancestry and verify the Nightly commit is contained in
   upstream `main`.
3. Run the branch-union audit above. Build an isolated desktop candidate from
   the complete `turbo` customization stack and an isolated relay candidate
   from `infra/t3turbo-relay` plus accepted `main`.
4. Stop cleanly with a no-op report when the upstream checkpoint is unchanged;
   do not manufacture a duplicate release.
5. On a clean candidate, run the focused sync tests and the build verification,
   then build the unsigned Turbo desktop installer and updater metadata.
6. Verify before publishing that the candidate still contains the complete fork
   commit/path inventory, all required T3 Turbo branding, the MIT attribution,
   and no credentials.
7. Publish only to `gfsaaser24/t3code`, then advance `turbo` with a lease check
   after every desktop build job succeeds. Advance `infra/t3turbo-relay` only
   with a normal fast-forward or reviewed merge after its ancestry and relay
   checks succeed. Never publish to or consume binary assets from
   `pingdotgg/t3code`.

The release title is `T3 Turbo MM-DD-YY`, where the date is the 11:00 PM ET
ingestion cutoff. Platform-safe artifact names may use the repository's
`T3-Turbo-...` filename prefix; do not hand-rename artifacts or update feeds.

## 6. Current failed-run handoff

The most recent scheduled sync (run #19, 2026-08-04) stopped while applying the
Turbo environment-switching commit. It reported a collision in:

- `apps/desktop/src/app/DesktopEnvironment.ts`
- `apps/desktop/src/settings/DesktopAppSettings.test.ts`
- `apps/web/index.html`
- `apps/web/src/components/ChatView.tsx`

The run uploaded a conflict artifact and opened the review issue. Treat that run
as **unpublished**. Do not mark the environment-switching commit as skipped and
do not advance the checkpoint until the complete Turbo stack, including the
branding and relay changes from the other fork history, is present and reviewed.
The relay/operator branch also must receive those accepted `main` commits while
retaining its original runbook commits; completing only the desktop candidate
does not complete the branch-union repair.

## 7. Security and external-state rules

- Never commit, print, upload, or bake credentials, tokens, private URLs, or
  signing material into source, logs, releases, issues, or artifacts.
- Use GitHub Actions secrets/variables and OpenClaw's external credentials only
  at runtime. The repository must remain publishable and safe to make public.
- OpenClaw may read, compare, test, and stage isolated candidates. It may push a
  branch or create a release only after the complete candidate passes the checks
  above. Any ambiguity about whether work is fork-owned is a stop-and-report
  condition, not authorization to delete it.

## 8. Required report for every daily run

Send Gabe a concise result containing:

- local cutoff date/time and run URL;
- upstream `main` SHA, official Nightly tag/SHA, old checkpoint, desktop
  candidate SHA, relay candidate SHA, and current live relay deploy SHA;
- retained Turbo commit range and path inventory summary;
- `no update`, `conflict`, `build failed`, or `published` status;
- release title and artifact/update-feed verification when published; and
- issue/PR URL plus the exact blocked files when not published.

The goal is a repeatable daily build that ingests upstream while preserving the
entire T3 Turbo fork: no silent exclusions, no credentials in the repository,
and no release that cannot be traced back to the complete downstream history.
