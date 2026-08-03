# Deploy the T3 Turbo relay

This runbook targets `https://relay.t3turbo.pro`, Clerk authentication, and a Hyperdrive connection
to self-hosted Supabase PostgreSQL 17.

## Locked deployment mode

The current Alchemy stack supports this deployment without source changes:

- A complete `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, and
  `DATABASE_PASSWORD` set selects external PostgreSQL and provisions Hyperdrive for it.
- An absent/incomplete `AXIOM_ORG_ID` and `AXIOM_TOKEN` pair disables Axiom provisioning and trace
  export.
- An absent/incomplete APNs set disables APNs resources and uses the runtime's disabled delivery
  layer.

Set the database group completely. Leave all PlanetScale, Axiom, and APNs inputs unset. If the
database group is incomplete, configuration falls back to the legacy PlanetScale path and deploy
fails without PlanetScale credentials.

## Prerequisites

- Active Cloudflare zone `t3turbo.pro`.
- `relay.t3turbo.pro` free of conflicting DNS/tunnel records.
- Deny-by-default Cloudflare Access application and policy for `relay.t3turbo.pro`, with an
  authentication path already proven on every intended client surface.
- Cloudflare account features used by the locked relay: Workers, Hyperdrive, Secrets Store/Alchemy
  state, DNS, and Cloudflare Tunnel. Queues are not created when APNs is disabled.
- A least-privilege `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- Healthy self-hosted Supabase PostgreSQL 17 with `schema.sql`, `seed.sql`, and `rls.sql` applied.
- Dedicated `relay_runtime` database role with `service_role` membership.
- A TLS database endpoint reachable by Hyperdrive and limited to Cloudflare IP ranges, or an
  approved private-database Tunnel/VPC path.
- Clerk production publishable/secret keys, JWT template `t3-relay`, audience
  `t3-code-relay`, and a public CLI OAuth application.
- Vite+ installed through the repository's normal setup and relay dependencies installed.

## Hyperdrive against self-hosted Supabase

### Locked option: public TLS endpoint

1. Enable native PostgreSQL SSL and expose the reviewed direct listener at
   `db.t3turbo.pro:15432` with a WebPKI certificate valid for that hostname.
2. Do not stack Hyperdrive on Supavisor transaction mode. Hyperdrive already pools connections, and
   a direct PostgreSQL origin preserves relay transaction semantics without double pooling.
3. Firewall the TLS port to the current Cloudflare IPv4/IPv6 ranges and operator addresses only.
4. Use database `postgres` and username `relay_runtime`.
5. Put the host, port, database, and user in GitHub variables and the password in the
   `DATABASE_PASSWORD` GitHub secret. Do not construct or print a connection URL.
6. Allow Alchemy to create `RelayHyperdrive`. The current source sets `sslmode=require`, disables
   query caching, and limits the origin to 20 connections.
7. Tune only after measuring PostgreSQL and Hyperdrive; do not change pooling limits during first
   bring-up.

Cloudflare documentation:

- [Connect Hyperdrive to PostgreSQL](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/)
- [Hyperdrive firewall and networking](https://developers.cloudflare.com/hyperdrive/configuration/firewall-and-networking-configuration/)
- [Hyperdrive TLS certificates](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)

Security caveat: Cloudflare's published source ranges are shared. The firewall is only one layer;
retain password authentication, a dedicated role, TLS verification, RLS, and rotation.

### Private alternatives

- [Hyperdrive private-database integration over Cloudflare Tunnel and Access](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database/).
- Workers VPC where available.

These remove the public database listener and are preferable if the locked public-endpoint decision
changes. A normal `tcp://` cloudflared ingress entry alone is not the full Hyperdrive private
database integration.

### Verify Hyperdrive

After deployment, inspect the created Hyperdrive configuration, issue the Worker health request,
and query:

```sql
SELECT DISTINCT usename, application_name
FROM pg_stat_activity
WHERE application_name = 'Cloudflare Hyperdrive';
```

The role must be the dedicated relay identity. A `postgres` Hyperdrive session is a configuration
failure.

## Clerk wiring

Use one Clerk production instance for released clients and the relay.

1. In **JWT templates**, create:

   | Setting | Value                        |
   | ------- | ---------------------------- |
   | Name    | `t3-relay`                   |
   | Claims  | `{ "aud": "t3-code-relay" }` |

2. Set the relay's `CLERK_JWT_AUDIENCE` to `t3-code-relay`.
3. Set the clients' `CLERK_JWT_TEMPLATE`/`T3CODE_CLERK_JWT_TEMPLATE` to `t3-relay`.
4. Store `CLERK_PUBLISHABLE_KEY` as public configuration and `CLERK_SECRET_KEY` only as a Worker or
   GitHub environment secret.
5. Create a public Clerk OAuth application for the CLI with PKCE, `openid`, `profile`, and `email`.
6. Allow:
   - `http://127.0.0.1:34338/callback`
   - `https://app.t3turbo.pro/connect/callback`
7. Put its public client ID in `CLERK_CLI_OAUTH_CLIENT_ID`.
8. Configure the production Android/native application and restrict origins/sign-ups to intended
   users.

The relay first verifies Clerk template/session tokens and then accepts Clerk OAuth tokens for the
headless CLI. The CLI stores no client secret. Cloudflare Access is the outer network gate and
Clerk remains the relay's application identity layer. Do not enable Access Managed OAuth on this
hostname because the relay publishes its own OAuth discovery and authorization flow.

## Workflow usage

`.github/workflows/deploy-relay.yml` has two triggers:

- push to `main`;
- manual `workflow_dispatch`.

This infrastructure branch does not auto-deploy because it is not `main`. After the target
variables/secrets are configured and the SQL is applied, a maintainer can dispatch it explicitly:

```sh
gh workflow run deploy-relay.yml --ref infra/t3turbo-relay
gh run list --workflow deploy-relay.yml --limit 5
```

Watch the selected run without printing environment values:

```sh
gh run watch <RUN_ID> --exit-status
```

The workflow deploys Alchemy stage `prod` with `--yes`. Before the first apply, review a local
deployment plan with the same source and no secret output. The production plan must create the
Worker and external-database Hyperdrive, must not create PlanetScale or Axiom resources, and must
not create APNs queues.

Required public configuration for the target:

- `CLOUDFLARE_ACCOUNT_ID`
- `RELAY_API_ZONE_NAME=t3turbo.pro`
- `RELAY_DOMAIN=relay.t3turbo.pro`
- `RELAY_TUNNEL_ZONE_NAME`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE=t3-code-relay`
- `CLERK_JWT_TEMPLATE=t3-relay`
- `CLERK_CLI_OAUTH_CLIENT_ID`
- `DATABASE_HOST=db.t3turbo.pro`
- `DATABASE_PORT=15432`
- `DATABASE_NAME=postgres`
- `DATABASE_USER=relay_runtime`

Required target secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLERK_SECRET_KEY`
- `DATABASE_PASSWORD`

Leave `PLANETSCALE_*`, `AXIOM_*`, and `APNS_*` unset. The workflow's report step must emit notices
that hosted tracing and mobile push are disabled. `DATABASE_PASSWORD` is consumed during Hyperdrive
reconciliation; Actions and Alchemy output must never print it.

## Post-deploy verification

### Public readiness and documentation

```sh
cloudflared access curl https://relay.t3turbo.pro/health
cloudflared access curl https://relay.t3turbo.pro/openapi.json >/dev/null
cloudflared access curl https://relay.t3turbo.pro/docs >/dev/null
```

Expected health response:

```json
{ "ok": true, "service": "relay" }
```

`/health` executes `SELECT 1`; it proves both Worker readiness and database connectivity.

### OAuth/DPoP discovery

```sh
cloudflared access curl \
  https://relay.t3turbo.pro/.well-known/oauth-authorization-server
cloudflared access curl \
  https://relay.t3turbo.pro/.well-known/oauth-protected-resource
```

Confirm the issuer/resource is `https://relay.t3turbo.pro`, the token endpoint is under that origin,
and DPoP ES256 support is advertised.

### End-to-end

1. Build a client with the four public T3 Connect values.
2. From an enrolled Android device, pass the Cloudflare Access policy and sign in through Clerk.
3. Link an environment with `t3 connect link`.
4. Run `t3 connect status --json` and confirm the environment is linked and its endpoint is ready.
5. Connect from Android and exercise API and WebSocket traffic.
6. Confirm normal environment traffic reaches the managed environment hostname directly; it must
   not transit the relay Worker.
7. Confirm the database contains the expected link/allocation rows without exposing tokens or
   credential hashes in logs.
8. Confirm an unmanaged device is denied by Access before any relay response is returned.

## Troubleshooting

### Workflow says deployment was skipped

Both `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` must be non-empty. Check repository versus
`production` environment scope and environment protection. Do not print the secret.

### Deployment requests PlanetScale

At least one required `DATABASE_*` value is absent or empty, so the stack selected its legacy
fallback. Stop and correct the complete external database group; do not supply PlanetScale
credentials for the locked deployment.

### Axiom or APNs resources appear in the plan

One or more excluded optional values are still defined at repository or `production` environment
scope. Remove the complete optional group, rerun the plan, and confirm the report says the service
is disabled.

### Worker custom domain fails

Remove conflicting `relay.t3turbo.pro` A/AAAA/CNAME or tunnel routes, confirm the zone is active in
the selected account, and verify Zone/DNS/Workers token permissions. Do not delete unrelated zone
records.

### `/health` returns `database_unavailable`

Check, in order:

1. Supabase container health and `pg_isready`.
2. database TLS certificate/SAN and expiry.
3. Cloudflare IP allowlist completeness for IPv4 and IPv6.
4. Hyperdrive hostname, port, database, TLS mode, and credential generation.
5. `relay_runtime` login, `service_role` membership, grants, and connection limits.
6. whether the direct listener accepts `relay_runtime` and requires SSL.

### Clerk requests return 401

Confirm the client used template `t3-relay`, `aud` is exactly `t3-code-relay`, the Worker uses the
matching production publishable/secret pair, the issuer is the production instance, clocks are
synchronized, and the token is unexpired. Never paste a bearer token into an issue or workflow log.
An Access redirect or `403` occurs before the Worker and must be diagnosed in Zero Trust policy;
it is not a Clerk `401`.

### Managed endpoint provisioning fails

Confirm `RELAY_TUNNEL_ZONE_NAME`, Cloudflare Tunnel/DNS runtime permissions, zone ownership, tunnel
quota, and the per-user default limit of three. `seed.sql` correctly contains no limit row;
`relay_managed_tunnel_limits` stores overrides only.

### App works but release artifacts do not show Connect

`release.yml` statically injects public configuration at build time. Confirm
`CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, `CLERK_CLI_OAUTH_CLIENT_ID`, relay domain variables,
and the Cloudflare enablement pair were present in the selected GitHub scope before the build.

## Rollback

1. Redeploy the last known-good Worker version or detach `relay.t3turbo.pro` to stop new requests.
2. Keep Hyperdrive and PostgreSQL intact while in-flight sessions drain.
3. Revert only backward-compatible code first.
4. Restore the database only when a tested backup exists and the last-good Worker cannot read the
   current schema.
5. Revoke newly introduced credentials after the rollback is verified.

Never use `alchemy destroy`, delete the Cloudflare zone, reset Supabase, or drop relay tables as an
ordinary application rollback.
