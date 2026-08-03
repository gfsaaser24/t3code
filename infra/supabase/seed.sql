-- T3 Connect relay seed contract.
--
-- The current relay has no required seed or configuration rows. All persistent rows are created by
-- authenticated runtime operations. The default managed tunnel limit is the code constant
-- DEFAULT_MANAGED_TUNNEL_LIMIT = 3 in
-- infra/relay/src/environments/ManagedTunnelLimits.ts; a row in
-- relay_managed_tunnel_limits is only a per-user override.
--
-- Keep this file as an explicit, executable no-op so fresh-environment automation can always apply
-- schema.sql, seed.sql, and rls.sql in the same order.

BEGIN;
COMMIT;
