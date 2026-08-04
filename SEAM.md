# Fork and upstream seam

## Branch preservation contract

`infra/t3turbo-relay` is the durable operator branch. Sync it by merging the newest accepted
`origin/main` into a temporary branch based on `origin/infra/t3turbo-relay`, reviewing the combined
tree, and then advancing the relay branch with a normal fast-forward or reviewed merge. Never
force-push, reset, or rebase the published relay branch in a way that removes its operator commits.

Before updating the branch, both commands below must succeed against the reviewed candidate:

```sh
git merge-base --is-ancestor origin/main <candidate>
git merge-base --is-ancestor origin/infra/t3turbo-relay <candidate>
```

This preserves two independent inputs: newer application/relay fixes from `main`, and the
Cloudflare, tunnel, Supabase, and operator documentation commits owned by this branch. A clean merge
does not make either side optional.

The production relay workflow currently runs on pushes to `main`. Until that workflow is deliberately
moved to this branch, merging here updates the operator source of truth without triggering a
production deployment. Record that distinction in every handoff.

## Relay customization seam

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

## Upstream and fork-main sync conflicts

Resolve against the new upstream file first, then reapply only the behavior above; never take the
fork's whole file over a newer upstream implementation. Drop a fork hunk when upstream now provides
equivalent gating or optionality. Preserve the PlanetScale fallback, the Cloudflare credential
gates, and the all-or-nothing `DATABASE_*`, Axiom, and APNs groups. Re-run the focused relay tests
and compare workflow variable/secret names after every conflict. Never use a credential, generated
state, or production output to resolve a conflict.
