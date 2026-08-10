# Upstream seam

`git show --name-status 774c53df b4904491` identifies these 16 unique upstream-owned paths. The
label is the nature of this fork's change.

- **Gated** `.github/workflows/deploy-relay.yml` — fork-safe credential detection, manual dispatch,
  and external-database/optional-service inputs.
- **Gated** `.github/workflows/release.yml` — release artifacts remain buildable when Connect is not
  configured.
- **Gated** `docs/operations/release.md` — documents the optional Connect release path.
- **Additive** `docs/operations/self-host-relay.md` — self-hosting runbook.
- **Optional** `infra/relay/.env.example` — external PostgreSQL settings and optional Axiom/APNs
  groups.
- **Optional** `infra/relay/alchemy.run.ts` — provider layers and tracing outputs exist only when
  configured.
- **Optional** `infra/relay/scripts/deploy.test.ts` — covers deployments without tracing outputs.
- **Optional** `infra/relay/scripts/deploy.ts` — accepts absent tracing outputs while retaining the
  relay URL requirement.
- **Optional** `infra/relay/src/Config.ts` — APNs is a complete optional group.
- **Optional** `infra/relay/src/agentActivity/ApnsDeliveries.test.ts` — adapts delivery tests to the
  optional APNs type.
- **Optional** `infra/relay/src/agentActivity/ApnsDeliveries.ts` — supplies the disabled APNs layer.
- **Additive** `infra/relay/src/agentActivity/ApnsDisabled.test.ts` — proves disabled delivery is a
  no-op.
- **Gated** `infra/relay/src/db.ts` — a complete `DATABASE_*` group selects external PostgreSQL;
  otherwise the upstream PlanetScale path remains.
- **Additive** `infra/relay/src/deploymentConfiguration.test.ts` — covers complete and absent
  provider groups.
- **Optional** `infra/relay/src/observability.ts` — Axiom resources require the complete pair.
- **Optional** `infra/relay/src/worker.ts` — APNs queues and tracing layers are conditional.

## Settled-lifecycle fix (upstream candidate)

One behavioral change carried until upstream lands its own (see pingdotgg/t3code#5575 /
pingdotgg/t3code#5643): the explicit un-settle pin is sticky against activity, and a merged/closed
PR only insta-settles a thread whose activity is not newer than the PR's `updatedAt`.

- **Behavioral** `apps/server/src/orchestration/decider.ts` — activity un-settles only a `"settled"`
  override; the `"active"` keep-alive pin survives messages, session starts, and approval/input
  requests (three sites).
- **Behavioral** `packages/client-runtime/src/state/threadSettled.ts` — `effectiveSettled` accepts
  `changeRequestUpdatedAt`; post-completion activity defers a merged/closed PR to the inactivity
  rule.
- **Additive** `packages/contracts/src/git.ts` — optional `updatedAt` on `VcsStatusChangeRequest`.
- **Additive** `apps/server/src/git/GitManager.ts` — `toStatusPr` forwards the PR's `updatedAt`.
- **Additive** web (`SidebarV2.tsx`, `ChatView.tsx`, `chat/ChatHeader.tsx`,
  `hooks/useThreadActionMenu.ts`) and mobile (`threadListV2.ts`, `thread-list-v2-items.tsx`,
  `HomeScreen.tsx`, `ThreadNavigationSidebar.tsx`, `state/thread-pr-presentation.ts`) — thread the
  PR `updatedAt` into the settled classification.

On a nightly-sync conflict here, prefer upstream's version wholesale if upstream has merged an
equivalent (a sticky un-settle or a completed-PR settle gate/toggle); otherwise reapply only the
behavior above.

## Nightly sync conflicts

Resolve against the new upstream file first, then reapply only the behavior above; never take the
fork's whole file over a newer upstream implementation. Drop a fork hunk when upstream now provides
equivalent gating or optionality. Preserve the PlanetScale fallback, the Cloudflare credential
gates, and the all-or-nothing `DATABASE_*`, Axiom, and APNs groups. Re-run the focused relay tests
and compare workflow variable/secret names after every conflict. Never use a credential, generated
state, or production output to resolve a conflict.
