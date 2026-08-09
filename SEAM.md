# Upstream seam

`git show --name-status 774c53df b4904491` identifies 16 of these upstream-owned paths; the agent
docs (`AGENTS.md`, `CLAUDE.md`) were added to the seam later. The label is the nature of this
fork's change.

- **Prepended** `AGENTS.md` — the "T3 Turbo — how this branch operates" section above the upstream
  agent guide. On conflict, take the new upstream body and reapply the Turbo header verbatim.
- **Replaced** `CLAUDE.md` — Turbo preamble plus an explicit `@AGENTS.md` import (upstream ships a
  bare pointer). On conflict, keep the fork file.
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
- **Tuned** `apps/server/src/persistence/Layers/Sqlite.ts` — the shared `setup` layer adds
  `PRAGMA synchronous = NORMAL;` (the standard WAL companion) after the existing `foreign_keys`
  and `journal_mode` pragmas. On conflict, take the upstream `setup` body and re-add only the
  `synchronous` line, still after `journal_mode`; never change the other two pragmas.
- **Additive** `apps/server/src/persistence/Layers/SqlitePragmas.test.ts` — asserts the pragma is
  live on fresh in-memory and file-backed connections. On conflict, keep the fork file.
- **Tuned** `apps/web/src/session-logic.ts` — a local `compareIsoTimestamps` helper replaces
  `String.prototype.localeCompare` at the seven timestamp comparison sites (pending approvals,
  pending user inputs, both proposed-plan picks, activity order, timeline order, checkpoint turn
  counts). On conflict, take the upstream comparator bodies and re-swap only the timestamp
  operands; never touch the `id.localeCompare` tiebreaks — ids are not fixed-width and the
  collation decides real ordering there.
- **Tuned** `apps/web/src/components/Sidebar.logic.ts` — `sortThreadsForSidebar` and
  `sortSettledThreadsForSidebar` are decorate-sorts: the sort key is resolved once per row instead
  of inside the comparator. On conflict, take the upstream comparator verbatim and re-wrap it in
  the decoration; the comparator body, the `id.localeCompare` tiebreak, and the pinned-thread
  ordering path must stay as upstream ships them.
- **Tuned** `packages/client-runtime/src/state/threadSort.ts` — the keyless half of
  `sortPinnedThreadsByOrderKey` orders by plain `createdAt` string comparison instead of a
  `Date.parse` pair per comparison; this file is shared with mobile, so keep it Hermes-safe. On
  conflict, keep the upstream keyed sort and `identityTiebreak` untouched and re-apply only the
  keyless comparator.
- **Additive** `packages/client-runtime/src/state/threadSortPinnedKeyless.test.ts` — pins the
  keyless pinned order against the pre-swap implementation, ties included. On conflict, keep the
  fork file.

## Nightly sync conflicts

Resolve against the new upstream file first, then reapply only the behavior above; never take the
fork's whole file over a newer upstream implementation. Drop a fork hunk when upstream now provides
equivalent gating or optionality. Preserve the PlanetScale fallback, the Cloudflare credential
gates, and the all-or-nothing `DATABASE_*`, Axiom, and APNs groups. Re-run the focused relay tests
and compare workflow variable/secret names after every conflict. Never use a credential, generated
state, or production output to resolve a conflict.
