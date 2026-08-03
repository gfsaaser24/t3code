# Self-host the T3 Connect relay

> For operators of a T3 Code or T3 Turbo fork.

This runbook deploys the existing T3 Connect relay into infrastructure owned by the fork operator
and explains how release builds consume it. T3 Connect remains optional: a repository without both
Cloudflare credentials produces release artifacts with Connect disabled.

## Architecture

The relay is a Cloudflare Worker that acts as the T3 Connect control plane. It authenticates users,
records linked environments, issues short-lived connection credentials, provisions managed
Cloudflare Tunnel endpoints and DNS records, and coordinates optional mobile notifications.

The relay is not the data path for a connected environment. It helps a client discover and
authorize a connection; normal API and WebSocket traffic then flows directly between the client and
the environment's managed `cloudflared` endpoint. The relay therefore does not proxy terminal,
filesystem, or agent traffic.

`infra/relay/alchemy.run.ts` provisions the Worker, queues, Hyperdrive connection, retained DNS
zones, runtime-scoped Cloudflare tokens, and Alchemy's Cloudflare state store. APNs queues and Axiom
tracing resources are provisioned only when their complete optional credentials are present. The
production stage also owns the relay resources described in
[the relay README](../../infra/relay/README.md).

## Minimum stack

The recommended minimum self-hosted deployment is:

- **Cloudflare** for the relay Worker, Hyperdrive, managed Tunnel endpoints, DNS, and state.
- **Clerk** for user, client, and CLI authentication.
- **Supabase** for a hosted Postgres database reached through Hyperdrive.

Axiom is optional; omit its variables and secret to run without hosted trace export. APNs is also
optional. Android-only operators should omit every `APNS_*` value because APNs only serves Apple
push notifications and Live Activities.

## Prerequisites

Before configuring GitHub, prepare:

- A Cloudflare account with Workers, Queues, Hyperdrive, Secrets Store, and Cloudflare Tunnel
  available.
- One or two active Cloudflare DNS zones. The relay API and managed tunnel endpoints may share a
  zone, but the deployment still needs both `RELAY_API_ZONE_NAME` and
  `RELAY_TUNNEL_ZONE_NAME`.
- A Clerk application for web, desktop, mobile, and CLI authentication.
- A Supabase project for the relay's Postgres database.
- A GitHub `production` Actions environment. The values in this runbook can be repository-level
  variables and secrets; avoid defining stale values with the same names on the environment because
  environment values take precedence.

## Prepare Cloudflare

### DNS zones

Add the API zone and managed-tunnel zone to the target Cloudflare account and finish nameserver
activation before the first deploy. Production adopts these existing zones as retained Alchemy
resources; it does not own the registrar setup.

- `RELAY_API_ZONE_NAME=example.com` produces `https://relay.example.com` by default.
- `RELAY_TUNNEL_ZONE_NAME=tunnels.example.com` produces per-environment hostnames below that
  zone.
- `RELAY_DOMAIN` overrides only the relay API hostname. Leave it unset to use
  `relay.<RELAY_API_ZONE_NAME>`.

The API hostname must not already have a conflicting CNAME. Cloudflare creates the Worker custom
domain and certificate during deployment.

### Cloudflare API token

Create one account-scoped token for GitHub Actions and restrict it to the selected Cloudflare
account and the API/tunnel zones. The minimum permission groups implied by the resources in
`infra/relay/alchemy.run.ts` are:

Account permissions:

- `Workers Scripts Write`
- `Queues Write`
- `Hyperdrive Write`
- `Secrets Store Write`
- `Account API Tokens Write`
- `Cloudflare Tunnel Read`
- `Cloudflare Tunnel Write`

Zone permissions, restricted to the API and tunnel zones:

- `Zone Read`
- `DNS Read`
- `DNS Write`

Cloudflare's dashboard may display `Edit` where its API permission group uses
`Write`. `Account API Tokens Write` is required because Alchemy mints narrower tokens
for the Worker's runtime tunnel and DNS bindings. `Secrets Store Write` is also required on
read-state runs because Alchemy binds state-store secrets through a short-lived Worker preview.

These permissions map to the Cloudflare APIs used by the stack:
[Workers scripts](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/),
[Queues](https://developers.cloudflare.com/api/resources/queues/),
[Hyperdrive](https://developers.cloudflare.com/api/resources/hyperdrive/),
[Secrets Store](https://developers.cloudflare.com/api/resources/secrets_store/),
[account-owned API tokens](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/),
[Cloudflare Tunnel](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/),
and [DNS records](https://developers.cloudflare.com/api/resources/dns/subresources/records/).

## Prepare Supabase

1. In the [Supabase dashboard](https://supabase.com/dashboard), create a project, choose the
   appropriate region for the fork's users and data, and save the database password.
2. Open the project and select **Connect**. Choose **Session pooler**, then expand
   **View parameters**. Use the pooled connection on port `5432`; it is the IPv4-compatible option
   intended for persistent clients. Do not use transaction mode on port `6543`, because it does not
   support prepared statements.
3. Record the five displayed connection fields and map them to GitHub as follows:

   | Supabase connection field | GitHub setting             | Example                                          |
   | ------------------------- | -------------------------- | ------------------------------------------------ |
   | Host                      | Variable `DATABASE_HOST`   | `aws-0-us-east-1.pooler.supabase.com`            |
   | Port                      | Variable `DATABASE_PORT`   | `5432`                                           |
   | Database                  | Variable `DATABASE_NAME`   | `postgres`                                       |
   | User                      | Variable `DATABASE_USER`   | `postgres.<project-ref>`                         |
   | Password                  | Secret `DATABASE_PASSWORD` | The password chosen when the project was created |

   See [Supabase's connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres)
   for the current dashboard location and pooler formats.

4. Before the first relay deploy, open **SQL Editor** in Supabase and run every
   `infra/relay/migrations/postgres/*/migration.sql` file in directory-name order. Run each file as
   a separate query, stop on the first error, and apply future migration files before deploying
   relay code that depends on them.

`DATABASE_*` takes precedence over the upstream managed-PlanetScale deployment. The legacy
`PLANETSCALE_ORGANIZATION`, `PLANETSCALE_API_TOKEN_ID`, and `PLANETSCALE_API_TOKEN` settings do not
map to Supabase connection fields; they remain only as a fallback for operators who still use the
original Alchemy-managed PlanetScale path. Leave them unset for Supabase.

A local Docker Postgres was rejected for this minimum stack because Hyperdrive must be able to
reach its database origin through a public endpoint. A private local database can be exposed with
additional Cloudflare networking, but that adds another always-on tunnel and host; Supabase's
hosted pooler is already publicly reachable. See [Hyperdrive networking](https://developers.cloudflare.com/hyperdrive/configuration/firewall-and-networking-configuration/).

## Prepare Clerk

Use a single Clerk application for the relay and released clients.

1. Copy its publishable key and secret key.
2. Create a JWT template named `t3-relay` with:

   ```json
   { "aud": "t3-code-relay" }
   ```

3. Create a public OAuth application for the CLI with PKCE. Enable
   `openid`, `profile`, and `email` and allow:

   - `http://127.0.0.1:34338/callback`
   - `<hosted-app-origin>/connect/callback`

4. Enable Clerk's Native API and allow `t3code://app/` for packaged desktop builds. Add
   development/mobile origins as needed for the surfaces the fork ships.

Use `t3-relay` for `CLERK_JWT_TEMPLATE` and `t3-code-relay` for
`CLERK_JWT_AUDIENCE`. The OAuth application's public client ID becomes
`CLERK_CLI_OAUTH_CLIENT_ID`. Never expose `CLERK_SECRET_KEY` to a client build.

See [T3 Connect](../internals/t3-connect.md) for the full Clerk redirect, native-auth, and passkey
configuration.

## Activation checklist

Add these values as repository settings, or to the GitHub `production` environment if that is where
the fork keeps production configuration. Environment values take precedence over repository
values.

### Required variables

| Variable                    | Where the value comes from                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `CLOUDFLARE_ACCOUNT_ID`     | Cloudflare dashboard account overview. This and the API token enable Connect in Release.                     |
| `RELAY_API_ZONE_NAME`       | Cloudflare **Websites** / DNS: the active zone containing the relay API hostname.                            |
| `RELAY_TUNNEL_ZONE_NAME`    | Cloudflare **Websites** / DNS: the active zone for managed environment endpoints; it may equal the API zone. |
| `CLERK_PUBLISHABLE_KEY`     | Clerk dashboard **API keys**.                                                                                |
| `CLERK_JWT_AUDIENCE`        | The `aud` claim in the Clerk JWT template, normally `t3-code-relay`.                                         |
| `CLERK_JWT_TEMPLATE`        | The Clerk JWT template name, normally `t3-relay`.                                                            |
| `CLERK_CLI_OAUTH_CLIENT_ID` | Clerk dashboard public OAuth application client ID.                                                          |
| `DATABASE_HOST`             | Supabase **Connect > Session pooler > View parameters** host.                                                |
| `DATABASE_PORT`             | Supabase Session pooler port, normally `5432`.                                                               |
| `DATABASE_NAME`             | Supabase Session pooler database, normally `postgres`.                                                       |
| `DATABASE_USER`             | Supabase Session pooler user, normally `postgres.<project-ref>`.                                             |

### Required secrets

| Secret                 | Where the value comes from                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard **My Profile > API Tokens**, using the permissions above.                      |
| `CLERK_SECRET_KEY`     | Clerk dashboard **API keys**.                                                                       |
| `DATABASE_PASSWORD`    | Supabase project database password chosen during project creation or reset under database settings. |

### Optional variables and secrets

- `RELAY_DOMAIN` optionally overrides the derived `relay.<RELAY_API_ZONE_NAME>` hostname.
- Axiom tracing requires both variable `AXIOM_ORG_ID` and secret `AXIOM_TOKEN`. Omit both to skip
  Axiom dataset/token provisioning and all hosted trace export.
- APNs requires variables `APNS_ENVIRONMENT`, `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_BUNDLE_ID`, and
  secret `APNS_PRIVATE_KEY`. Omit the entire set to disable mobile push cleanly; Android-only
  operators should leave them unset.
- The legacy managed-PlanetScale fallback requires variable `PLANETSCALE_ORGANIZATION` and secrets
  `PLANETSCALE_API_TOKEN_ID` and `PLANETSCALE_API_TOKEN`. They are not used when the complete
  `DATABASE_*` set is present.

Example commands for the required minimum stack:

```sh
gh variable set CLOUDFLARE_ACCOUNT_ID --repo OWNER/REPO --body "<account-id>"
gh variable set RELAY_API_ZONE_NAME --repo OWNER/REPO --body "example.com"
gh variable set RELAY_TUNNEL_ZONE_NAME --repo OWNER/REPO --body "tunnels.example.com"
gh variable set CLERK_PUBLISHABLE_KEY --repo OWNER/REPO --body "pk_live_..."
gh variable set CLERK_JWT_AUDIENCE --repo OWNER/REPO --body "t3-code-relay"
gh variable set CLERK_JWT_TEMPLATE --repo OWNER/REPO --body "t3-relay"
gh variable set CLERK_CLI_OAUTH_CLIENT_ID --repo OWNER/REPO --body "<oauth-client-id>"
gh variable set DATABASE_HOST --repo OWNER/REPO --body "<session-pooler-host>"
gh variable set DATABASE_PORT --repo OWNER/REPO --body "5432"
gh variable set DATABASE_NAME --repo OWNER/REPO --body "postgres"
gh variable set DATABASE_USER --repo OWNER/REPO --body "postgres.<project-ref>"
gh secret set CLOUDFLARE_API_TOKEN --repo OWNER/REPO
gh secret set CLERK_SECRET_KEY --repo OWNER/REPO
gh secret set DATABASE_PASSWORD --repo OWNER/REPO
```

## First deploy and later deploys

The workflow [`deploy-relay.yml`](../../.github/workflows/deploy-relay.yml) supports both pushes
to `main` and manual dispatch:

1. Apply the relay SQL migrations and add all **Required** variables and secrets above.
2. Open **Actions > Deploy T3 Connect relay > Run workflow** and select `main`.
3. Confirm **Detect Cloudflare configuration** reports enabled.
4. Confirm **Deploy production relay stage** completes and reports an HTTPS `relay_url`.

The workflow uses `--stage prod --yes`. On a fresh Cloudflare account, `--yes`
non-interactively bootstraps Alchemy's `alchemy-state-store` Worker and Secrets Store before
deploying the relay. No separate local bootstrap command is required. The fork-specific repository
guard has been removed, so any fork with credentials can deploy. A repository without both
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` gets a successful no-op workflow
instead of a failed deploy.

After bootstrap, every push to `main` reconciles the `prod` stage. Re-running a failed
first deploy is safe because Alchemy adopts the retained zones and state-store resources.

## How Release consumes the relay

[`release.yml`](../../.github/workflows/release.yml) checks only
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` to decide whether this repository
has enabled Connect.

- If either is absent, **Resolve T3 Connect public config** is skipped. Desktop, CLI, and hosted-web
  jobs receive empty Connect build variables and skip the relay tracing artifact, so installers can
  still be built without Connect.
- If both are present, Release reads the deployed `prod` Alchemy state, uploads the
  relay client tracing configuration (empty when Axiom is disabled), derives the public relay URL,
  and injects
  `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`,
  `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`, and `T3CODE_RELAY_URL` into desktop, CLI, and
  hosted-web builds.
- Once credentials enable the happy path, missing public variables, invalid credentials, or missing
  production state remain hard failures. Release does not silently ship a Connect-free build when
  an operator intended to enable it.

Deploy the relay successfully before the first Connect-enabled release.

## Verify

1. Check readiness, including database connectivity:

   ```sh
   curl --fail --show-error --silent "https://<relay-domain>/health"
   ```

   Expected response:

   ```json
   { "ok": true, "service": "relay" }
   ```

2. In Cloudflare, confirm the relay Worker has its custom domain, Hyperdrive points to the Supabase
   session-pooler host, and the Alchemy state-store Worker exists. Two relay queues should exist
   only when APNs is configured.
3. Inspect the next Release run:
   - **Resolve T3 Connect public config** succeeds rather than skips.
   - Desktop, CLI, and hosted-web jobs download the relay tracing artifact; without Axiom, it
     contains empty tracing values and clients do not export traces.
4. Install a resulting build, sign in under **Settings > Connections**, and link an environment.
   `t3 connect status --json` should report the link and managed endpoint.
5. Connect from another client, then confirm ordinary API/WebSocket requests reach the managed
   environment hostname directly rather than passing through the relay Worker.

## Rebase safety

Operator-owned state lives outside the fork: the Cloudflare account (including Alchemy state,
Workers, tunnels, DNS, queues, and Hyperdrive) and GitHub variables/secrets. Rebasing the fork cannot
delete that state. After resolving an upstream workflow conflict, confirm the credential gate,
manual relay dispatch, and fork-safe deployment behavior are still present before merging. Never
commit exported credentials or Alchemy state to make a rebase easier.
