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

## Settled-lifecycle fix (partially retired 2026-08-16)

Upstream #5880 landed a completed-PR settle toggle (`autoSettleOnMerge` on `effectiveSettled`),
which is the equivalence this seam's drop rule named. The fork's merged-PR `updatedAt` gate and
its threading (`threadSettled.ts`, `contracts/git.ts` `updatedAt`, `GitManager.toStatusPr`, the
web/mobile call sites) are retired — upstream's versions are taken wholesale on ingest.

Still carried (upstream has no equivalent yet, see pingdotgg/t3code#5575):

- **Behavioral** `apps/server/src/orchestration/decider.ts` — activity un-settles only a `"settled"`
  override; the `"active"` keep-alive pin survives messages, session starts, and approval/input
  requests (three sites).

On a nightly-sync conflict in decider.ts, prefer upstream wholesale if upstream lands a sticky
un-settle; otherwise reapply only the pin behavior above.

## Reaper wedge cap (upstream adopted the base fix)

Upstream #5677 landed the fork's background-liveness reaper skip (the
`ThreadBackgroundLiveness` service and the thread-shell `backgroundLiveness` field are now
upstream-owned). The fork's remaining delta is only the wedge cap: background work may defer
reaping, but never forever.

- **Behavioral** `apps/server/src/provider/Layers/ProviderSessionReaper.ts` —
  `backgroundWorkMaxIdleMs` option (default 4 h, floored at the inactivity threshold); the
  background-liveness skip applies only while `idleDurationMs` is under the cap.
- **Behavioral** `apps/server/src/provider/Layers/ProviderSessionReaper.test.ts` — upstream's
  "skips stale sessions while background work is still live" pins its idle time inside the cap,
  and the additive "reaps sessions with live background work once past the wedge cap" exercises
  the cap through the thread-shell field.

On a nightly-sync conflict here, take upstream's reaper wholesale and reapply only the cap
condition; drop the cap if upstream grows an equivalent bound.

## Nightly sync conflicts

Resolve against the new upstream file first, then reapply only the behavior above; never take the
fork's whole file over a newer upstream implementation. Drop a fork hunk when upstream now provides
equivalent gating or optionality. Preserve the PlanetScale fallback, the Cloudflare credential
gates, and the all-or-nothing `DATABASE_*`, Axiom, and APNs groups. Re-run the focused relay tests
and compare workflow variable/secret names after every conflict. Never use a credential, generated
state, or production output to resolve a conflict.
