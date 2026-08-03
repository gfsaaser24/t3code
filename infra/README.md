# T3 Turbo self-hosted infrastructure

This directory is the operator runbook for `t3turbo.pro`. It covers the locked deployment:

- Cloudflare DNS, a relay Worker, Hyperdrive, and Cloudflare Tunnel
- Clerk authentication
- self-hosted Supabase Docker with PostgreSQL 17 and persistent host storage
- `relay.t3turbo.pro` for the relay API and `app.t3turbo.pro` for the hosted T3 surface
- an Android-only operator deployment, with no APNs and no Axiom

No secret value belongs in this repository. Values shown between angle brackets are replacement
markers and must remain outside Git history after they are resolved.

## Supported minimum stack

The relay source on this branch directly supports the locked deployment:

- A complete `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, and
  `DATABASE_PASSWORD` set selects external PostgreSQL and causes Alchemy to create Hyperdrive for
  that origin. It takes precedence over the legacy PlanetScale fallback.
- Omitting the complete Axiom variable/secret pair disables Axiom resources and trace export.
- Omitting every APNs variable/secret disables APNs queues and delivery at deployment and runtime.

For T3 Turbo, provide the complete `DATABASE_*` set and leave every PlanetScale, Axiom, and APNs
setting unset. An incomplete database set is not a partial configuration: the relay falls back to
the legacy PlanetScale path and the deploy fails without its credentials.

## Architecture

```text
                                      Clerk production instance
                                      JWT template: t3-relay
                                      aud: t3-code-relay
                                               ^
                                               | token verification
                                               |
 Android / web / desktop clients               |
       |                                       |
       +---- https://relay.t3turbo.pro --------+---- Cloudflare Worker
       |                                                |
       |                                                | Hyperdrive
       |                                                v
       |                                  db.t3turbo.pro:15432
       |                                  public TLS, Cloudflare IP ACL
       |                                                |
       |                                                v
       |                                  Supabase PostgreSQL 17
       |                                  /srv/t3turbo/supabase/volumes
       |
       +---- https://app.t3turbo.pro ---- Cloudflare edge
                                                        |
                                                        | outbound tunnel
                                                        v
                                                 cloudflared on Ubuntu
                                                        |
                                                        v
                                              T3 server / hosted app

 Normal environment API and WebSocket traffic goes directly through each linked environment's
 managed tunnel. The relay is a control plane, not a terminal or filesystem traffic proxy.
```

`relay.t3turbo.pro` is a Worker custom domain. `app.t3turbo.pro` is a Cloudflare Tunnel hostname.
They must not be assigned to the same DNS record or tunnel ingress rule.

## Threat model

TLS certificate issuance records hostnames in public Certificate Transparency logs. Treat
`relay.t3turbo.pro`, `app.t3turbo.pro`, and `db.t3turbo.pro` as discoverable; unguessable DNS names
are not a security control.

- Put deny-by-default Cloudflare Access (Zero Trust) applications and policies in front of both
  the relay and app hostnames before production use. The relay policy must use an authentication
  path that every intended web, CLI, and Android client can satisfy, such as enrolled Cloudflare
  One devices; never embed an Access service token in a public client build.
- Keep application origin IPs out of public DNS and behind the outbound-only Cloudflare Tunnel.
  Bind the local T3 service to loopback. The DNS-only PostgreSQL endpoint is the explicit exception.
- Restrict the PostgreSQL listener to Cloudflare's complete, current published IPv4 and IPv6 ranges
  plus explicitly approved operator addresses, with default-deny firewalling everywhere else.
- Put no secret in DNS, source code, examples, comments, issue text, workflow output, or logs.
  Hostnames, account IDs, and public client identifiers must never be treated as credentials.

## Components

| Component         | Responsibility                                                                                            | Durable state                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Cloudflare DNS    | Hosts `t3turbo.pro` records and Worker/tunnel hostnames.                                                  | Cloudflare account                                          |
| Cloudflare Access | Enforces deny-by-default Zero Trust policy before requests reach the relay or hosted app.                 | Cloudflare account                                          |
| Relay Worker      | Authenticates clients, links environments, issues short-lived credentials, and manages endpoint metadata. | Worker configuration plus PostgreSQL                        |
| Hyperdrive        | Pools Worker-to-PostgreSQL connections. Query caching is disabled by the current relay source.            | Cloudflare account                                          |
| Clerk             | Provides web/mobile sessions, the relay JWT template, and public CLI OAuth.                               | Clerk production instance                                   |
| Supabase Docker   | Runs PostgreSQL 17 and the supporting self-hosted Supabase services.                                      | Host bind mounts and Docker named volumes                   |
| `cloudflared`     | Provides outbound-only connectivity for `app.t3turbo.pro` and optional protected operator services.       | Tunnel record in Cloudflare and scoped credential on Ubuntu |
| GitHub Actions    | Builds releases and reconciles the Worker from the locked external-database mode.                         | Repository/environment variables and secrets                |

## Bring-up order

### Phase 0: establish custody and recovery

1. Assign one password manager vault for infrastructure secrets and an independent encrypted backup
   destination.
2. Record the Ubuntu host owner, Cloudflare account owner, Clerk owner, GitHub environment
   reviewers, and recovery contacts.
3. Confirm the Ubuntu host has at least 4 CPU cores, 8 GB RAM, an SSD-backed persistent filesystem,
   Docker Engine, Docker Compose v2, Git, OpenSSL, `curl`, and PostgreSQL 17 client tools.
4. Patch Ubuntu and configure time synchronization before issuing certificates or tokens.

Verification:

```sh
docker version
docker compose version
openssl version
psql --version
timedatectl status
```

Rollback: no service state exists yet. Remove only packages installed for this phase; do not erase
the server if it contains unrelated workloads.

### Phase 1: activate Cloudflare and reserve names

1. Add `t3turbo.pro` to the intended Cloudflare account and complete nameserver activation.
2. Reserve these non-conflicting names:
   - `relay.t3turbo.pro`: Worker custom domain; no pre-existing CNAME.
   - `app.t3turbo.pro`: Cloudflare Tunnel DNS route.
   - `db.t3turbo.pro`: DNS-only database TLS endpoint when using the locked public-endpoint path.
3. Create the least-privilege deployment token described in
   [cloudflare/CHECKLIST.md](./cloudflare/CHECKLIST.md). Store it only in the password manager and
   GitHub Actions.
4. Create self-hosted Cloudflare Access applications for `relay.t3turbo.pro` and
   `app.t3turbo.pro`. Attach deny-by-default policies for the intended operators and enrolled
   devices. Prove the chosen relay policy works with every client surface before deployment.
5. Decide the managed endpoint zone. The current code requires `RELAY_TUNNEL_ZONE_NAME`; using
   `t3turbo.pro` is valid, though a delegated child zone reduces blast radius.

Verification:

```sh
dig +short NS t3turbo.pro
dig +short relay.t3turbo.pro
dig +short app.t3turbo.pro
```

The nameservers must be Cloudflare-owned. Relay and app may remain unresolved until later phases.

Rollback: delete only records created for this deployment. Do not delete the zone if it hosts other
services.

### Phase 2: install self-hosted Supabase

Follow [supabase/README.md](./supabase/README.md) from a persistent directory such as
`/srv/t3turbo/supabase`. Pin the Supabase Git commit, generate every `.env` secret, set
`KONG_HTTPS_PORT=18443`, and start the stack. Fresh current Supabase Docker deployments use
PostgreSQL 17.

Verification:

```sh
cd /srv/t3turbo/supabase
docker compose ps
docker compose exec db pg_isready -U postgres
docker compose exec db psql -U postgres -d postgres -Atc 'show server_version'
```

Every required container must be healthy, `pg_isready` must succeed, and the server version must
start with `17`.

Rollback: use `docker compose down` to stop containers while retaining state. Never use
`reset.sh`, `docker compose down -v`, or delete `volumes/` during a routine rollback.

### Phase 3: install the relay schema and RLS

From the Supabase project directory, apply the checked-in SQL in order:

```sh
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < /path/to/t3code/infra/supabase/schema.sql
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < /path/to/t3code/infra/supabase/seed.sql
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < /path/to/t3code/infra/supabase/rls.sql
```

Create a dedicated login role, set its password interactively, and grant it membership in
`service_role`:

```sh
docker compose exec db psql -U postgres -d postgres
```

Then run in `psql`:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'relay_runtime') THEN
    CREATE ROLE relay_runtime LOGIN;
  END IF;
END
$$;
\password relay_runtime
GRANT service_role TO relay_runtime;
```

Verification:

```sh
docker compose exec db psql -U postgres -d postgres -c \
  "select count(*) as relay_tables from pg_tables where schemaname = 'public' and tablename like 'relay_%';"
docker compose exec db psql -U postgres -d postgres -c \
  "select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename like 'relay_%' order by tablename;"
```

The table count must be `9`, and `rowsecurity` must be true for all nine tables.

Rollback: restore a pre-schema logical backup or drop only the nine `relay_*` tables after proving
they contain no required data. Do not reset the Supabase database.

### Phase 4: configure database TLS, firewalling, and Hyperdrive

Follow [supabase/SETUP-RULES.md](./supabase/SETUP-RULES.md). The locked path is a public PostgreSQL
TLS endpoint whose firewall admits the current Cloudflare IP ranges and explicitly approved
operator addresses only. Use a WebPKI certificate whose SAN includes `db.t3turbo.pro`, and connect
as `relay_runtime`, never as `postgres`. The current relay
creates Hyperdrive with `sslmode=require`, caching disabled, and an origin connection limit of 20.

Cloudflare documents three supported network paths: unrestricted public access, public access with
a Cloudflare IP ACL, and a private database via Cloudflare Tunnel. The second is the locked path.
The third is the preferred alternative when the deployment policy is later allowed to change.

Verification:

- A non-allowlisted network cannot open the database port.
- A TLS client receives the expected certificate and hostname.
- An allowlisted operator can authenticate as `relay_runtime` and query the relay tables.

After Phase 7, Hyperdrive's connection must succeed and `pg_stat_activity` must show
`application_name = 'Cloudflare Hyperdrive'` after a relay query.

Rollback: close the public database firewall rule and keep the database running locally. Do not
delete the database or revoke the current login until any deployed Worker is confirmed quiescent.

### Phase 5: configure Clerk

1. Create or select a Clerk production instance for `t3turbo.pro`.
2. Create the `t3-relay` JWT template with claims `{ "aud": "t3-code-relay" }`.
3. Create a public CLI OAuth application using PKCE with `openid`, `profile`, and `email` scopes.
4. Allow both `http://127.0.0.1:34338/callback` and
   `https://app.t3turbo.pro/connect/callback`.
5. Configure the Android/native application and restrict production origins and sign-ups to the
   intended operator population.
6. Enroll intended Android devices in the Cloudflare One/Access path selected in Phase 1 and prove
   that native relay requests pass the outer Access policy.
7. Store the publishable key as a GitHub variable and the secret key as a GitHub secret. Never put
   the secret key in a client build.

Verification: obtain a token with template `t3-relay`, decode it locally without logging it, and
confirm `aud` is `t3-code-relay`, `iss` is the production Clerk issuer, and the token is unexpired.

Rollback: disable the OAuth application and template only after clients have been pointed away from
the relay. Rotating the Clerk secret key is safer than deleting the production instance.

### Phase 6: install the application tunnel

Follow [cloudflared/README.md](./cloudflared/README.md). Create a tunnel for the Ubuntu-hosted T3
surface, route `app.t3turbo.pro`, install the systemd service, and place Cloudflare Access in front
of any optional SSH or raw TCP hostname.

Do not route `relay.t3turbo.pro` to this tunnel while the relay Worker owns that custom domain. Put
the required Access application and policy in place before routing `app.t3turbo.pro`. The example
configuration includes a clearly marked, mutually exclusive relay-origin fallback only for a future
non-Worker deployment.

Verification:

```sh
systemctl is-active cloudflared
cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
cloudflared access curl https://app.t3turbo.pro/
```

Rollback: remove the `app.t3turbo.pro` tunnel DNS route or stop `cloudflared`. Existing local T3
service data remains intact.

### Phase 7: deploy the relay Worker

Use [relay/DEPLOY.md](./relay/DEPLOY.md). Configure all four `DATABASE_*` variables and the
`DATABASE_PASSWORD` secret. Alchemy creates Hyperdrive with caching disabled and an origin
connection limit of 20. Leave PlanetScale, Axiom, and APNs settings unset; the deployment report
must state that tracing and mobile push are disabled.

Verification:

```sh
cloudflared access curl https://relay.t3turbo.pro/health
cloudflared access curl \
  https://relay.t3turbo.pro/.well-known/oauth-authorization-server
cloudflared access curl \
  https://relay.t3turbo.pro/.well-known/oauth-protected-resource
```

The health response must be `{"ok":true,"service":"relay"}`.

Rollback: redeploy the last known-good Worker version or detach its custom domain. Do not roll back
the database schema unless the previous Worker is schema-incompatible and a tested backup exists.

### Phase 8: configure and verify releases

Populate the exact locked-stack variables and secrets in
[cloudflare/CHECKLIST.md](./cloudflare/CHECKLIST.md). Build clients with:

- `T3CODE_CLERK_PUBLISHABLE_KEY`
- `T3CODE_CLERK_JWT_TEMPLATE=t3-relay`
- `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`
- `T3CODE_RELAY_URL=https://relay.t3turbo.pro`

Verification:

1. The Release relay-public-config job succeeds rather than skipping.
2. A built Android client signs in and lists linked environments.
3. `t3 connect status --json` shows the intended environment.
4. Normal API and WebSocket traffic reaches the environment tunnel, not the relay Worker.

Rollback: ship a client build with Connect public configuration disabled or point a new build at the
last known-good relay. Build-time public values cannot be changed inside an already shipped binary.

## Routine verification

Run these checks after upgrades and at least weekly:

- `docker compose ps` and `pg_isready` on the Ubuntu host.
- PostgreSQL backup age, size, encryption, and a scheduled restore test.
- TLS expiry for the database endpoint and the two public HTTPS hostnames.
- Access-authenticated `GET https://relay.t3turbo.pro/health`, plus a denied request from an
  unmanaged client.
- Cloudflare Tunnel connector health and systemd restart count.
- Hyperdrive origin health and connection count.
- Clerk sign-in, JWT audience, and CLI OAuth callback.
- GitHub production-environment secret review and stale credential removal.

## Rebase safety and state ownership

The branch is safe to rebase only when code and operator state remain separate.

Lives in Git:

- relay source, migrations, and these runbooks;
- SQL schema, empty seed contract, and RLS policy definitions;
- example tunnel and systemd files containing placeholders only;
- workflow _names_ and variable/secret _names_.

Lives in Cloudflare:

- zones, DNS records, Worker versions, custom domains, queues, Hyperdrive configuration;
- tunnels, tunnel credentials, Access policies, certificates, and Alchemy state.

Lives in GitHub variables or the `production` environment:

- public account IDs, domains, Clerk publishable identifiers, template name, audience, and public
  OAuth client ID.

Lives in GitHub secrets, the server, or the password manager:

- API tokens, Clerk secret, database passwords, Supabase `.env`, TLS private keys, tunnel
  credentials, and backup-encryption material.

Never resolve a rebase conflict by committing `.env`, Alchemy state, a Wrangler state directory,
tunnel JSON, `cert.pem`, a database dump, a private key, or a rendered connection string. Recheck
workflow input names against the workflow files after every upstream rebase. A rebase must not
delete or recreate retained Cloudflare or PostgreSQL state.

## Secrets inventory

This inventory names secrets; it never records their values.

| Secret name                     | Authoritative location                                                                                  | Consumers                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`          | GitHub Actions secret and operator password manager                                                     | Worker/Hyperdrive/DNS deployment                                 |
| `CLOUDFLARE_ACME_DNS_TOKEN`     | `/root/.secrets/certbot/cloudflare.ini` mode `0600` and password manager                                | DNS-01 renewal for `db.t3turbo.pro`                              |
| `CLOUDFLARE_TUNNEL_TOKEN`       | `/etc/cloudflared/tunnel.env` mode `0600`, or password manager                                          | Remotely managed `cloudflared` service                           |
| `CLOUDFLARE_TUNNEL_CREDENTIALS` | `/etc/cloudflared/<TUNNEL_UUID>.json`, root-owned and mode `0640` for the dedicated `cloudflared` group | Locally managed tunnel runtime                                   |
| `CLOUDFLARE_ORIGIN_CERT`        | `/etc/cloudflared/cert.pem` mode `0600`; remove from runtime host when no longer needed                 | Locally managed tunnel creation/administration only              |
| `CLERK_SECRET_KEY`              | GitHub `production` environment secret and Clerk                                                        | Relay Worker backend verification                                |
| `POSTGRES_PASSWORD`             | `/srv/t3turbo/supabase/.env` mode `0600` and password manager                                           | Supabase services and administration                             |
| `DATABASE_PASSWORD`             | GitHub `production` environment secret, password manager, and PostgreSQL role verifier                  | Hyperdrive origin login for `relay_runtime`                      |
| `JWT_SECRET`                    | Supabase `.env` and password manager                                                                    | Legacy Supabase HS256 signing/verification                       |
| `ANON_KEY`                      | Supabase `.env`; treat as public-but-rotatable credential                                               | Supabase `anon` API role                                         |
| `SERVICE_ROLE_KEY`              | Supabase `.env` and password manager                                                                    | Supabase privileged API role                                     |
| `SUPABASE_SECRET_KEY`           | Supabase `.env` and password manager when asymmetric keys are enabled                                   | Server-side Supabase API                                         |
| `JWT_KEYS`                      | Supabase `.env` and password manager when asymmetric keys are enabled                                   | Supabase Auth signing keys                                       |
| `DASHBOARD_PASSWORD`            | Supabase `.env` and password manager                                                                    | Supabase Studio basic authentication                             |
| `SECRET_KEY_BASE`               | Supabase `.env` and password manager                                                                    | Realtime/Supavisor cryptography                                  |
| `REALTIME_DB_ENC_KEY`           | Supabase `.env` and password manager                                                                    | Realtime sensitive database fields                               |
| `VAULT_ENC_KEY`                 | Supabase `.env` and password manager                                                                    | Supavisor configuration encryption                               |
| `PG_META_CRYPTO_KEY`            | Supabase `.env` and password manager                                                                    | Studio/postgres-meta connection-string encryption                |
| `LOGFLARE_PUBLIC_ACCESS_TOKEN`  | Supabase `.env` and password manager                                                                    | Supabase local logs override, if enabled; not Axiom              |
| `LOGFLARE_PRIVATE_ACCESS_TOKEN` | Supabase `.env` and password manager                                                                    | Supabase local logs override, if enabled; not Axiom              |
| `S3_PROTOCOL_ACCESS_KEY_ID`     | Supabase `.env` and password manager                                                                    | Supabase Storage S3 protocol                                     |
| `S3_PROTOCOL_ACCESS_KEY_SECRET` | Supabase `.env` and password manager                                                                    | Supabase Storage S3 protocol                                     |
| `POSTGRES_TLS_PRIVATE_KEY`      | PostgreSQL `db-config` volume, ACME source directory, and encrypted backup                              | Native PostgreSQL TLS                                            |
| `BACKUP_ENCRYPTION_KEY`         | Offline/password-manager custody, separate from backup storage                                          | Database and configuration backups                               |
| `CloudMintKeyPair.privateKey`   | Alchemy/Cloudflare encrypted state                                                                      | Relay-issued cloud credentials                                   |
| `ApnsDeliveryJobSigningSecret`  | Alchemy/Cloudflare encrypted state only when APNs is enabled                                            | Optional APNs queue signing; not created for the locked target   |
| `PLANETSCALE_API_TOKEN_ID`      | GitHub Actions secret only for the legacy PlanetScale fallback                                          | Optional legacy database deployment; unset for the locked target |
| `PLANETSCALE_API_TOKEN`         | GitHub Actions secret only for the legacy PlanetScale fallback                                          | Optional legacy database deployment; unset for the locked target |
| `AXIOM_TOKEN`                   | GitHub Actions secret only when paired with `AXIOM_ORG_ID`                                              | Optional hosted tracing; unset for the locked target             |
| `APNS_PRIVATE_KEY`              | GitHub `production` environment secret only with the complete APNs set                                  | Optional Apple push; unset for the locked target                 |

`CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, `CLERK_JWT_AUDIENCE`,
`CLERK_CLI_OAUTH_CLIENT_ID`, Cloudflare account IDs, zone names, hostnames, and Hyperdrive IDs are
configuration identifiers, not secrets.
