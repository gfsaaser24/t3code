# Self-hosted Supabase Docker for the relay

This guide installs the official Supabase Docker stack on Ubuntu with PostgreSQL 17, persistent
host storage, and the relay schema. It deliberately keeps secrets and mutable runtime state outside
this repository.

Authoritative upstream references:

- [Self-hosting with Docker](https://supabase.com/docs/guides/self-hosting/docker)
- [PostgreSQL 17 self-hosting](https://supabase.com/docs/guides/self-hosting/postgres-upgrade-17)
- [Self-hosted authentication keys](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys)

## Host layout and prerequisites

Use a dedicated persistent filesystem:

```text
/srv/t3turbo/supabase/
  .env                    # mode 0600; never Git-tracked
  docker-compose.yml
  run.sh
  utils/
  volumes/
    db/data/              # PostgreSQL data bind mount
    storage/              # Storage file backend
    functions/            # Edge Functions, if retained
```

The official compose file also creates a Docker named volume named `db-config`. It contains the
pgsodium root key and must be included in recovery planning; backing up `volumes/db/data` alone is
not sufficient for deployments that store Vault secrets.

Minimum production starting point: 4 CPU cores, 8 GB RAM, and 80 GB of SSD storage. Install Docker
Engine, Docker Compose v2, Git, OpenSSL, `curl`, and PostgreSQL 17 client tools.

## Clone and pin the Docker configuration

Never run production from an ephemeral application checkout. Clone upstream into a staging
directory, review an immutable commit, and copy only the Docker deployment into `/srv`:

```sh
git clone --filter=blob:none --no-checkout https://github.com/supabase/supabase.git \
  /var/tmp/supabase-source
cd /var/tmp/supabase-source
git sparse-checkout init --cone
git sparse-checkout set docker
git checkout <REVIEWED_SUPABASE_COMMIT_SHA>
reviewed_supabase_commit=$(git rev-parse HEAD)
sudo install -d -m 0750 /srv/t3turbo/supabase
sudo cp -a docker/. /srv/t3turbo/supabase/
cd /srv/t3turbo/supabase
sudo cp .env.example .env
sudo chmod 0600 .env
printf '%s\n' "$reviewed_supabase_commit" | sudo tee SUPABASE_UPSTREAM_COMMIT >/dev/null
unset reviewed_supabase_commit
```

`SUPABASE_UPSTREAM_COMMIT` is operational metadata, not a secret. Review image changes and the
upstream self-hosting changelog before changing it. Fresh current Supabase Docker installs use
PostgreSQL 17 by default; do not add the legacy PostgreSQL 15 compose override.

## Generate `.env` safely

Set a restrictive umask and run the official generator from a private terminal. It generates the
legacy HS256 keys and the other required random values and updates `.env`:

```sh
cd /srv/t3turbo/supabase
umask 077
sudo sh utils/generate-keys.sh --update-env
sudo sh utils/add-new-auth-keys.sh --update-env
sudo chmod 0600 .env
sudo rm -f .env.old docker-compose.yml.old
```

The generator prints generated values. Do not run it in CI, a recorded terminal, a shared shell,
or with `tee`. Move the values into the password manager without copying them into notes or Git.

Before first start, replace every insecure default in `.env`. At minimum review:

- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `ANON_KEY`
- `SERVICE_ROLE_KEY`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`
- `JWT_KEYS` and `JWT_JWKS`
- `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD`
- `SECRET_KEY_BASE`
- `REALTIME_DB_ENC_KEY`
- `VAULT_ENC_KEY`
- `PG_META_CRYPTO_KEY`
- `LOGFLARE_PUBLIC_ACCESS_TOKEN` and `LOGFLARE_PRIVATE_ACCESS_TOKEN`
- `S3_PROTOCOL_ACCESS_KEY_ID` and `S3_PROTOCOL_ACCESS_KEY_SECRET`
- `POOLER_TENANT_ID`

The locked stack does not enable the optional `docker-compose.logs.yml` override. Its Logflare
tokens are still generated so an insecure default is never left in `.env`; they are unrelated to
Axiom.

### `VAULT_ENC_KEY` is exactly 32 bytes

Supavisor requires `VAULT_ENC_KEY` to be exactly 32 characters. Generate 16 random bytes encoded as
32 lowercase hexadecimal ASCII bytes:

```sh
openssl rand -hex 16
```

After placing it in `.env`, validate without printing it:

```sh
set -a
. /srv/t3turbo/supabase/.env
set +a
test "$(LC_ALL=C printf %s "$VAULT_ENC_KEY" | wc -c)" -eq 32
unset VAULT_ENC_KEY
```

A zero exit code is required. Do not use a 32-byte random input encoded as hex; that produces 64
characters and is invalid for this setting.

### HS256 `ANON_KEY` and `SERVICE_ROLE_KEY`

`ANON_KEY` and `SERVICE_ROLE_KEY` are JWTs, not random strings. Both must:

- use header `{"alg":"HS256","typ":"JWT"}`;
- be signed with the same `JWT_SECRET` configured for Supabase services;
- contain `role: "anon"` or `role: "service_role"` respectively;
- contain valid `iss`, `iat`, and `exp` claims.

`utils/generate-keys.sh` performs this generation with OpenSSL and writes all three matching values.
Do not generate the API JWTs independently and do not paste sample JWTs from documentation. To
rotate `JWT_SECRET`, generate a new matching trio, update them together during a maintenance
window, recreate affected containers, and invalidate the old tokens.

The newer asymmetric keys created by `utils/add-new-auth-keys.sh` supplement the legacy HS256 keys;
they do not make mismatched `ANON_KEY` or `SERVICE_ROLE_KEY` values safe.

## URLs and ports

The relay uses PostgreSQL directly and Clerk for authentication; it does not need the Supabase HTTP
APIs on a public hostname. Keep Kong/Studio private and use coherent loopback URLs:

```dotenv
SUPABASE_PUBLIC_URL=http://127.0.0.1:8000
API_EXTERNAL_URL=http://127.0.0.1:8000/auth/v1
SITE_URL=https://app.t3turbo.pro
```

Access Studio through an SSH port forward to loopback. If Supabase HTTP APIs are later required,
give them a separate protected hostname behind Cloudflare Access; do not reuse
`app.t3turbo.pro`, which belongs to the T3 server, and never publish Studio unauthenticated.

Port `8443` conflicts with an existing host service in this deployment. Remap only the host side by
setting:

```dotenv
KONG_HTTPS_PORT=18443
```

The compose mapping remains `${KONG_HTTPS_PORT}:8443`, so containers still use Kong's internal
port `8443`. Leave `POSTGRES_PORT=5432` and `POOLER_PROXY_PORT_TRANSACTION=6543` unless a reviewed
network design changes both the compose mapping and every connection string.

Restrict host firewall access before starting. Kong, Studio, Supavisor, and PostgreSQL must not be
world-accessible by default. See [SETUP-RULES.md](./SETUP-RULES.md) for the database TLS boundary.

### Pinned gateway compatibility

This runbook's compose override assumes the pinned Supabase revision uses the `kong` service and
`KONG_HTTP_PORT`/`KONG_HTTPS_PORT`. Supabase has announced that Envoy becomes the default API
gateway during the week of 2026-08-09. Keep the deployment on a reviewed Kong-based commit until an
Envoy override has been tested. Before every repin, inspect `docker compose config --services` and
the rendered port bindings; if the gateway service or variables changed, stop and adapt this
override instead of applying the `kong` block blindly.

## Native PostgreSQL TLS for Hyperdrive

Hyperdrive already pools database connections, so the locked path connects it directly to
PostgreSQL rather than stacking it on Supavisor. PostgreSQL must perform its own protocol-aware TLS
negotiation; a generic HTTPS/TCP TLS terminator is not a substitute for PostgreSQL SSL.

Use the DNS-only hostname `db.t3turbo.pro` and public port `15432`. Obtain a WebPKI certificate by
DNS-01 so no database HTTP service must be exposed. With a dedicated Cloudflare token restricted to
Zone Read and DNS Write for `t3turbo.pro`:

```sh
sudo apt-get install certbot python3-certbot-dns-cloudflare
sudo install -d -m 0700 /root/.secrets/certbot
sudo install -m 0600 /dev/null /root/.secrets/certbot/cloudflare.ini
sudoedit /root/.secrets/certbot/cloudflare.ini
sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /root/.secrets/certbot/cloudflare.ini \
  --dns-cloudflare-propagation-seconds 30 \
  --non-interactive --agree-tos \
  --email <ACME_CONTACT_EMAIL> \
  -d db.t3turbo.pro
```

The credential file contains only:

```ini
dns_cloudflare_api_token = <CLOUDFLARE_ACME_DNS_TOKEN>
```

Copy the issued material into the persistent `db-config` volume, with the private key readable only
by PostgreSQL:

```sh
cd /srv/t3turbo/supabase
sudo docker compose exec db install -d -o postgres -g postgres -m 0700 \
  /etc/postgresql-custom/tls
sudo docker compose cp -L /etc/letsencrypt/live/db.t3turbo.pro/fullchain.pem \
  db:/etc/postgresql-custom/tls/server.crt.next
sudo docker compose cp -L /etc/letsencrypt/live/db.t3turbo.pro/privkey.pem \
  db:/etc/postgresql-custom/tls/server.key.next
sudo docker compose exec db install -o postgres -g postgres -m 0644 \
  /etc/postgresql-custom/tls/server.crt.next \
  /etc/postgresql-custom/tls/server.crt
sudo docker compose exec db install -o postgres -g postgres -m 0600 \
  /etc/postgresql-custom/tls/server.key.next \
  /etc/postgresql-custom/tls/server.key
sudo docker compose exec db rm -f \
  /etc/postgresql-custom/tls/server.crt.next \
  /etc/postgresql-custom/tls/server.key.next
```

Create `/srv/t3turbo/supabase/docker-compose.t3turbo.yml` as an operator-owned, reviewed override:

```yaml
services:
  kong:
    ports: !override
      - "127.0.0.1:8000:8000"
      - "127.0.0.1:18443:8443"

  supavisor:
    ports: !override
      - "127.0.0.1:5432:5432"
      - "127.0.0.1:6543:6543"

  db:
    ports:
      - "15432:5432"
    command:
      - postgres
      - -c
      - config_file=/etc/postgresql/postgresql.conf
      - -c
      - log_min_messages=fatal
      - -c
      - ssl=on
      - -c
      - ssl_cert_file=/etc/postgresql-custom/tls/server.crt
      - -c
      - ssl_key_file=/etc/postgresql-custom/tls/server.key
```

Set `COMPOSE_FILE=docker-compose.yml:docker-compose.t3turbo.yml` in the server's `.env`, then
reconcile and verify:

```sh
sudo docker compose up -d
sudo docker compose exec db psql -U postgres -d postgres -Atc 'show ssl'
openssl s_client -starttls postgres -connect 127.0.0.1:15432 \
  -servername db.t3turbo.pro -verify_hostname db.t3turbo.pro </dev/null
```

`show ssl` must return `on`, and OpenSSL must report successful certificate verification. Apply the
Cloudflare IP allowlist in the provider firewall and a Docker-aware host firewall before publishing
the port. Docker-published ports can bypass simple UFW input rules; enforce the restriction in the
cloud firewall and the `DOCKER-USER`/equivalent nftables path, then test from allowed and denied
networks.

The `!override` tag requires Docker Compose 2.24.4 or newer and prevents the upstream all-interface
port mappings from being appended. Verify the rendered bindings with `docker compose config` and
`ss -H -ltn`; Kong and Supavisor must listen only on `127.0.0.1`, while `15432` is the sole
firewalled database listener. Reach Studio with `ssh -L 8000:127.0.0.1:8000 <UBUNTU_HOST>` and open
`http://127.0.0.1:8000` locally.

Map the direct endpoint to the relay deployment as one atomic group:

| GitHub setting      | Locked value source                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_HOST`     | `db.t3turbo.pro`                                                                                                                                      |
| `DATABASE_PORT`     | `15432`                                                                                                                                               |
| `DATABASE_NAME`     | `postgres`                                                                                                                                            |
| `DATABASE_USER`     | `relay_runtime`                                                                                                                                       |
| `DATABASE_PASSWORD` | The interactive `relay_runtime` password created in [Install relay tables and policies](#install-relay-tables-and-policies); store as a GitHub secret |

The first four are GitHub variables. `DATABASE_PASSWORD` is a GitHub `production` environment
secret. Never store a rendered PostgreSQL URL. The relay uses the complete group to create
Hyperdrive; if any member is empty it selects the legacy PlanetScale fallback instead.

Automate certificate renewal with a deploy hook that repeats the two copies/installs above and sends
PostgreSQL a configuration reload. Test the hook with `certbot renew --dry-run`. Keep the hook and
its logs free of token and private-key content.

## Persistence

The official compose deployment uses host bind mounts below `./volumes`; placing the compose
directory at `/srv/t3turbo/supabase` makes those paths durable. Confirm mount sources before first
write:

```sh
cd /srv/t3turbo/supabase
docker compose config
docker compose config --volumes
```

Required durable material includes:

- `volumes/db/data`
- `volumes/storage`
- `volumes/functions` if functions are used
- `.env`
- local compose overrides and TLS configuration
- the Docker `db-config` named volume
- the ACME account/configuration and a recovery copy of the database TLS private key

Never place `volumes/` on `/tmp`, an ephemeral cloud disk, or the application Git worktree. Never
symlink production data into a developer checkout.

## Start and verify PostgreSQL 17

```sh
cd /srv/t3turbo/supabase
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps
sudo docker compose exec db pg_isready -U postgres
sudo docker compose exec db psql -U postgres -d postgres -Atc 'show server_version'
```

Every required service must be healthy and the server version must begin with `17`. If a service is
unhealthy, inspect only its logs first:

```sh
sudo docker compose logs --tail=200 <SERVICE_NAME>
```

Do not repeatedly recreate the whole stack; that obscures the first failure.

## Install relay tables and policies

Apply files in this order from a trusted checkout:

```sh
cd /srv/t3turbo/supabase
sudo docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < /path/to/t3code/infra/supabase/schema.sql
sudo docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < /path/to/t3code/infra/supabase/seed.sql
sudo docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < /path/to/t3code/infra/supabase/rls.sql
```

`schema.sql` is the fresh-database projection of the current Drizzle schema and migrations.
`seed.sql` is intentionally empty because the relay has no required configuration rows. `rls.sql`
enables RLS on every relay table, denies `anon` and `authenticated`, and grants `service_role` full
table access.

Create the Worker login interactively:

```sh
sudo docker compose exec db psql -U postgres -d postgres
```

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

Use the `relay_runtime.<POOLER_TENANT_ID>` username when connecting through Supavisor session mode.
Never give Hyperdrive the `postgres` password.

## Backup and restore

Self-hosting makes the operator responsible for recovery. Use both logical and encrypted
configuration backups:

1. Run a daily custom-format logical backup with PostgreSQL 17 `pg_dump`.
2. Encrypt it before sending it to storage on a different host/account.
3. Back up `.env`, reviewed compose overrides, TLS certificates, and the `db-config` named volume
   separately; encrypt them with a key not stored beside the backup.
4. Back up Storage objects separately. A PostgreSQL dump contains Storage metadata, not the files.
5. Retain daily, weekly, and monthly generations according to the recovery objective.
6. Restore into an isolated PostgreSQL 17 environment on a schedule and run the relay table/RLS and
   `/health` checks. A backup that has not been restored is unverified.

Example logical backup, with the destination already on encrypted storage:

```sh
sudo install -d -m 0700 /srv/t3turbo/backups/staging
sudo docker compose exec -T db pg_dump -U postgres -d postgres \
  --format=custom --no-owner --no-privileges \
  > /srv/t3turbo/backups/staging/relay-$(date -u +%Y%m%dT%H%M%SZ).dump
```

Do not leave the staging dump unencrypted. Do not commit dumps. Coordinate `pg_dump`/`pg_restore`
client major versions with PostgreSQL 17.

For a physical snapshot, stop writes or use storage-level snapshot semantics proven consistent for
PostgreSQL. Copying a live `volumes/db/data` directory is not a valid backup. Preserve the
`db-config` volume because loss of its pgsodium root key can make Vault data unrecoverable.

## Safe lifecycle operations

Safe routine stop/start:

```sh
sudo docker compose stop
sudo docker compose start
```

Safe container reconciliation after an environment change:

```sh
sudo docker compose up -d --remove-orphans
```

Destructive and prohibited during routine operations:

- `reset.sh`
- `docker compose down -v`
- deletion of `volumes/db/data`, `volumes/storage`, or the `db-config` volume
- replacing `.env` with `.env.example`
