# Universal Rule: T3 Turbo Fork Policy

Authoritative operational rewrite of Gabe's directive from 2026-08-04 11:13 UTC.

## Scope

This rule applies to everything OpenClaw generates, updates, builds, deploys, or maintains for
our T3 Code fork: repositories, release branches, relay and online infrastructure, filings,
tooling, documentation, cloud functions, desktop, web, mobile, and the application itself.

## Non-negotiable outcome

T3 Turbo is a maintained downstream product, not a clean copy of upstream T3 Code. Every daily
ingestion starts with the last known-good T3 Turbo branch and keeps all reviewed T3 Turbo
customizations. Upstream changes are applied underneath or reconciled with those customizations.
It is never acceptable to obtain a clean build by dropping, skipping, reverting, replacing, or
silently omitting a T3 Turbo change.

If an upstream change cannot coexist with a T3 Turbo change automatically, stop before publishing.
Open a PR on our repository that names the collision, identifies the affected Turbo seam, explains
the required rework, and preserves the last known-good build. Send that PR to Gabe in a message.
Never resolve a collision with a blanket `ours`, `theirs`, force push, clean checkout, or a new
branch that lacks the prior Turbo customization stack.

## 1. Branding

- The fork is named **T3 Turbo**. Use that name on every polished or user-facing surface, including
  repositories, systems, filings, tooling, login screens, cloud functions, relay/portal surfaces,
  desktop, web, and mobile.
- Every generated application is titled **T3 Turbo**.
- `t3turbo.png` is the canonical icon source. Generated relay, portal, favicon, desktop, Electron,
  mobile, marketing, and widget icons must pass the repository's Turbo icon validation.
- The MIT License always retains the T3 Code attribution for T3 Tools.
- Do not publish T3 Turbo to NPM.

## 2. Daily upstream ingestion

- Ingest both upstream T3 Code `main` and the newest official T3 Code Nightly source release.
- Use the Nightly tag as a trusted release/version anchor and upstream `main` as the cumulative
  source of code changes.
- The daily cutoff is **11:00 PM America/New_York**. Resolve the latest completed Eastern-time
  cutoff to an exact UTC instant so daylight-saving changes and delayed GitHub runners do not move
  the intended boundary. A manual run before 11:00 PM uses the prior completed cutoff.
- Resolve upstream `main` with GitHub's commit `until` filter and accept Nightly releases only when
  their publication timestamp is at or before that same instant. Anything later belongs to the
  following day's candidate; the date label alone is never a valid cutoff implementation.
- Fetch upstream into isolated refs. Never give the workflow write access to the upstream
  repository and never download or republish an official installer.

## 3. Preserve and prove every T3 Turbo change

Before changing the candidate, record a machine-readable manifest of the last known-good Turbo
customization stack and its integration seams. At minimum, the manifest must cover:

- Turbo branding, application identity, updater, icon source, and generated icon targets;
- file explorer, editor-tab, Markdown preview, and image preview seams;
- multi-chat pane and client-layout persistence seams;
- official-data import/cutover seams;
- relay, online portal, tunnel, and self-host infrastructure seams;
- Turbo documentation, build policy, and secret-exclusion rules.

After applying upstream, compare the candidate with that manifest and run the seam-specific tests.
A candidate is invalid if any expected commit, module, behavior, asset, test, configuration, relay
capability, or documentation contract is missing unless a reviewed replacement is included in the
same candidate. A path moving upstream is not permission to discard the behavior; remap the seam
and update the manifest.

Use these outcomes:

1. **Clean:** upstream applies, every Turbo seam is present, and verification passes. Build it.
2. **Reworked:** upstream supersedes or moves a seam, but an explicit reviewed Turbo replacement
   preserves the behavior. Build only after its tests pass.
3. **Collision:** preservation cannot be proved automatically. Do not publish. Open the collision
   PR/report and notify Gabe.

## 4. Branch ownership

- `turbo` is the last known-good product and release line. It must contain the complete reviewed
  Turbo customization stack.
- Relay and operator-only infrastructure is maintained on `infra/t3turbo-relay`. Advance that
  branch with normal merges; do not rebase, recreate, or force-push it.
- A product ingestion must not replace the relay branch, and a relay merge must not silently pull
  unrelated operator state into the product branch.
- Feature branches and open PRs are not part of a release until they are reviewed and deliberately
  included in `turbo`. OpenClaw must report requested Turbo work that remains outside `turbo`; it
  must not describe that work as shipped or preserved.

## 5. Collision handling and reporting

All rebase, merge, build, verification, and publish work happens in an isolated candidate checkout.
On a collision or failed preservation check:

- leave `turbo`, the relay branch, and the last published release unchanged;
- save the upstream base, prior Turbo head, candidate head, overlapping paths, unmerged paths,
  missing seam checks, and failing tests;
- open or update a PR or issue in `gfsaaser24/t3code` with the exact corrective work;
- message Gabe with the review link and a plain-language summary;
- resume publishing only from the reviewed, repaired Turbo stack.

## 6. Security

- Never bake credentials, tokens, secrets, personal environment state, database contents, or relay
  operator credentials into the repository, application, artifacts, logs, or collision reports.
- Credentials live outside the codebase and are used only through the relevant deployment secret
  store.
- Treat everything committed to the repository as eventually public.
- `SECRETS DO NOT COMMIT.md` is a local operator note and must remain ignored.

## 7. Release naming and cutoff meaning

- User-facing Windows releases are named `T3 Turbo MM-DD-YY.exe`.
- That date means the candidate contains all upstream `main` and Nightly source changes available
  at the 11:00 PM Eastern cutoff on that date, plus the complete reviewed T3 Turbo customization
  manifest.
- Do not publish an artifact with that date if ingestion, seam preservation, tests, branding,
  relay compatibility, or secret checks are incomplete.
- Publish only in `gfsaaser24/t3code`. Never publish to the official T3 repository or updater feed.

## 8. Required completion report

Every daily run reports:

- upstream `main` SHA and Nightly tag/SHA included;
- prior and resulting Turbo SHAs;
- the preserved Turbo seam manifest and its test results;
- relay/portal status and whether their branch changed;
- artifact name, checksum, and release link, or the exact reason no artifact was published;
- collision PR/issue link when human review is required.

For a successful publish, write the report into the GitHub release notes, the Actions job summary,
and a downloadable workflow artifact. Report relay/portal preservation honestly: validation of
their registered seams is not a deployment and must not be described as one.

The job is complete only when upstream is synchronized, our changes are demonstrably intact,
everything is branded T3 Turbo, nothing sensitive is embedded, and the last known-good release is
recoverable.

---

## Original directive (verbatim)

Universal Rule: T3 Turbo Fork Policy

Saved verbatim from Gabe's directive, 2026-08-04 11:13 UTC (Slack DM).

Scope: This rule applies to everything generated, updated, or maintained for our T3 Code fork — repos, systems, filings, tooling, the relay system, and the app itself.

1. Branding — everything is "T3 Turbo"

• Our fork of T3 Code is named T3 Turbo. That name appears on everything we produce: repos, systems, filings, tooling, login screens, cloud functions, and any other polished, user-facing surface — in both the relay system and the normal app.
• Any generated app is titled "T3 Turbo". No exceptions.
• The MIT License must have the T3 Code attribution for T3 Tools. Always.
• The only branding step we skip is NPM publishing.

2. Upstream ingestion — daily, automatic, collision-free

• T3 Turbo ingests all upstream changes from two sources: T3 Code main and the T3 Code nightly build.
• Ingestion runs once a day at 11:00 PM ET.
• Ingestion must happen without collisions: our changes must rebase cleanly on top of upstream and remain fully maintained after every sync. If there is rework needed, open a PR on our repo, documented with the collision and what needs to change, and send it to Gabe in a message.

3. Security — no credentials, ever

• No access credentials are ever baked into the repo or the relay app. Credentials live outside the codebase, for our use only.
• Reason: the project may go public at some point. Assume everything in the repo will eventually be visible at some point.

4. Release naming — the date is the ingestion cutoff

• On publish, releases are named: _T3 Turbo MM-DD-YY.exe_
• The date means: as of 11:00 PM ET on that date, all pending main and nightly changes have been ingested.
• Anything pushed upstream after 11:00 PM ET is picked up in the following night's ingestion and release.

Goal: a repeatable nightly workflow — upstream synced, our changes intact, everything branded T3 Turbo, nothing sensitive in the code.
