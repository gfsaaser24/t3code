# Supabase operational rules

These are invariants for the relay database. They apply during first install, upgrades, incident
response, and credential rotation.

## Secret handling

- Never commit `.env`, connection strings, database dumps, TLS keys, tunnel credentials, generated
  JWTs, or command output containing them.
- Keep `/srv/t3turbo/supabase/.env` owned by the operator account or root with mode `0600`.
- Use an interactive `\password` prompt for PostgreSQL roles. Do not put passwords in shell history,
  process arguments, GitHub variables, or SQL files.
- Store `DATABASE_PASSWORD` in the GitHub `production` environment and the password manager.
  Alchemy uses it to reconcile Cloudflare's encrypted Hyperdrive configuration; the Worker receives
  a Hyperdrive binding, not the origin password.
- `ANON_KEY` is designed for client use, but it remains a rotatable credential and must not be used
  to authenticate the relay. `SERVICE_ROLE_KEY`, `JWT_SECRET`, `JWT_KEYS`, and database passwords
  are secrets.
- Keep backup-encryption keys in separate custody from backup objects.
- Treat `/etc/cloudflared/cert.pem` as an account-wide management credential. A running named tunnel
  uses its scoped JSON credential instead.

## Database identities

- Administrative work uses `postgres` only from the Ubuntu host or a protected operator network.
- Hyperdrive uses `relay_runtime`, a dedicated LOGIN role with a unique password and membership in
  `service_role`.
- Do not use the Supabase `postgres` password in Hyperdrive.
- `anon` and `authenticated` have no privileges on relay tables and have restrictive deny policies.
- RLS must remain enabled on all nine `relay_*` tables after schema changes.

## Hyperdrive network boundary

The locked network path is a **public TLS PostgreSQL endpoint restricted to Cloudflare IP ranges**.
Cloudflare's current networking guidance states that Hyperdrive connects from the published
Cloudflare IP ranges:

- [Hyperdrive firewall and networking](https://developers.cloudflare.com/hyperdrive/configuration/firewall-and-networking-configuration/)
- [Cloudflare IP ranges](https://www.cloudflare.com/ips/)
- [Hyperdrive TLS certificates](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)

Apply all of the following:

1. Publish a DNS-only record such as `db.t3turbo.pro` for the Ubuntu server. The normal Cloudflare
   HTTP proxy does not proxy PostgreSQL.
2. Enable native PostgreSQL SSL and publish the reviewed direct listener on port `15432` with a
   WebPKI certificate whose SAN includes `db.t3turbo.pro`. Hyperdrive already pools connections, so
   do not stack it on Supavisor transaction mode. A generic TLS terminator that does not understand
   PostgreSQL's SSL negotiation is not sufficient.
3. The current relay creates Hyperdrive with `sslmode=require`. Cloudflare documents this as
   encrypted connectivity with WebPKI certificate validation. A future move to an uploaded CA and
   `verify-full` requires a reviewed source/configuration change.
4. Permit the database TLS port only from the complete, current Cloudflare IPv4 and IPv6 ranges and
   explicitly approved operator addresses. Deny all other sources.
5. Automate a daily comparison with Cloudflare's published range lists. Add new ranges before
   removing old ones, test Hyperdrive, and alert on drift.
6. Rate-limit and log rejected connections without logging credentials or complete connection
   strings.
7. Keep Supavisor ports `5432` and `6543` blocked from the public Internet. Docker-published ports
   can bypass simple UFW rules, so enforce the allowlist at the provider firewall and in the
   `DOCKER-USER`/equivalent nftables path.

Cloudflare IP ranges are shared with other Cloudflare products and customers. An IP allowlist is
not client identity. Retain PostgreSQL password authentication, least-privilege roles, TLS hostname
verification, and credential rotation.

Cloudflare also supports Hyperdrive-to-private-database connectivity through Cloudflare Tunnel and
Workers VPC. Those options remove the public listener and are preferable if the locked network
decision changes:

- [Connect Hyperdrive to a private database](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database/)

## Health checks

Run locally after every change:

```sh
cd /srv/t3turbo/supabase
sudo docker compose ps
sudo docker compose exec db pg_isready -U postgres
sudo docker compose exec db psql -U postgres -d postgres -Atc 'select 1'
sudo docker compose exec db psql -U postgres -d postgres -Atc \
  "select count(*) from pg_tables where schemaname = 'public' and tablename like 'relay_%'"
sudo docker compose exec db psql -U postgres -d postgres -Atc \
  "select count(*) from pg_tables where schemaname = 'public' and tablename like 'relay_%' and rowsecurity"
```

Both table counts must be `9`.

After a relay request, confirm Hyperdrive reached PostgreSQL:

```sql
SELECT DISTINCT usename, application_name
FROM pg_stat_activity
WHERE application_name = 'Cloudflare Hyperdrive';
```

External readiness, once the compatible Worker exists:

```sh
curl --fail --show-error --silent https://relay.t3turbo.pro/health
```

Expected response:

```json
{ "ok": true, "service": "relay" }
```

A Worker response with `database_unavailable` is a failed database/Hyperdrive health check even if
the HTTP edge itself is reachable.

## Rotation procedures

### Relay database password

Use an overlap rotation rather than changing the only active login in place:

1. Create `relay_runtime_next`, set its password interactively, and grant `service_role`.
2. Replace the four `DATABASE_*` variables as needed and the `DATABASE_PASSWORD` secret, then
   redeploy so Alchemy updates Hyperdrive.
3. Call `/health` and exercise an authenticated read/write path.
4. Terminate old `relay_runtime` sessions only after the new path is proven.
5. Revoke login from the old role, observe one full rollback window, then drop it.
6. Rename roles only if tooling requires it; stable role generations are easier to audit.

### Supabase `JWT_SECRET`

1. Schedule a maintenance window; the legacy HS256 services share one active secret.
2. Run the reviewed `utils/generate-keys.sh` to produce a matching `JWT_SECRET`, `ANON_KEY`, and
   `SERVICE_ROLE_KEY` trio.
3. Update `.env` atomically, recreate affected containers, and verify Auth/PostgREST/Storage.
4. Revoke and remove the old trio from every consumer and the password manager history according to
   policy.

Never change only one member of the trio.

### Cloudflare deployment token

1. Create a second token with the exact scoped permissions in `infra/cloudflare/CHECKLIST.md`.
2. replace `CLOUDFLARE_API_TOKEN` in GitHub, run a read-only or no-op reconciliation, then a normal
   deployment.
3. Revoke the old token after success and record the rotation date.

### Clerk secret key

1. Issue the next secret in Clerk.
2. replace `CLERK_SECRET_KEY` in the GitHub production environment and Worker secret binding.
3. Verify token validation and an authenticated relay endpoint.
4. Revoke the old key after the overlap window.

Client builds use the publishable key; a Clerk domain change can also require a new publishable key
and a new client build.

### Tunnel credentials

For a remotely managed tunnel, rotate `CLOUDFLARE_TUNNEL_TOKEN`, update the root-readable systemd
environment file, restart one connector replica, verify it, then replace the other replica. For a
locally managed tunnel, create a new tunnel credential JSON and replace replicas one at a time.
`cert.pem` is not a runtime credential and should not remain on the server when management is done
elsewhere.

### TLS certificates and backups

- Renew the database certificate before one-third of its lifetime remains, reload PostgreSQL, and
  test Hyperdrive TLS connectivity.
- Rotate `BACKUP_ENCRYPTION_KEY` by writing new backups with the new key while retaining the old key
  until all backups encrypted by it expire.
- Test recovery after every rotation. Do not discover missing keys during an incident.

## Change and rollback rules

- Take and verify a logical backup before schema or major-version changes.
- Apply `schema.sql`, `seed.sql`, and `rls.sql` only to a fresh database. Existing deployments move
  forward through reviewed migrations.
- Never use Supabase `reset.sh` or `docker compose down -v` as rollback.
- Keep the previous Worker version deployable until the database change is proven compatible.
- Do not downgrade PostgreSQL data directories. Restore into the matching PostgreSQL major version
  and migrate forward.
- Record the pinned Supabase commit and image digests used for every production change.
