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
zones, runtime-scoped Cloudflare tokens, and Alchemy's Cloudflare state store. The production stage
also owns the relay database and tracing resources described in
[the relay README](../../infra/relay/README.md).

## Prerequisites

Before configuring GitHub, prepare:

- A Cloudflare account with Workers, Queues, Hyperdrive, Secrets Store, and Cloudflare Tunnel
  available.
- One or two active Cloudflare DNS zones. The relay API and managed tunnel endpoints may share a
  zone, but the deployment still needs both `RELAY_API_ZONE_NAME` and
  `RELAY_TUNNEL_ZONE_NAME`.
- A Clerk application for web, desktop, mobile, and CLI authentication.
- The current upstream relay's backing services: a PlanetScale Postgres organization, an Axiom
  organization, and APNs credentials. These are not optional in the current
  `infra/relay` stack even if a fork does not plan to use mobile notifications.
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

## Configure GitHub

Set these repository variables. The first six are the public self-host/release configuration:

| Variable | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account ID. This and the API token enable Connect in Release. |
| `RELAY_DOMAIN` | Optional explicit API hostname, for example `relay.example.com`. |
| `RELAY_API_ZONE_NAME` | Active Cloudflare zone containing the relay API hostname. |
| `CLERK_PUBLISHABLE_KEY` | Clerk application's public key. |
| `CLERK_JWT_TEMPLATE` | `t3-relay`, or the matching template name chosen by the operator. |
| `CLERK_CLI_OAUTH_CLIENT_ID` | Public client ID of the Clerk CLI OAuth application. |

The unmodified upstream deployment also requires these repository variables:

| Variable | Value |
| --- | --- |
| `RELAY_TUNNEL_ZONE_NAME` | Active zone used for managed environment endpoints; it may equal `RELAY_API_ZONE_NAME`. |
| `CLERK_JWT_AUDIENCE` | Audience from the JWT template, normally `t3-code-relay`. |
| `PLANETSCALE_ORGANIZATION` | PlanetScale organization containing the production relay database. |
| `AXIOM_ORG_ID` | Axiom organization for relay/client tracing. |
| `APNS_ENVIRONMENT` | `sandbox` or `production`. |
| `APNS_TEAM_ID` | Apple Developer team ID. |
| `APNS_KEY_ID` | APNs key ID. |
| `APNS_BUNDLE_ID` | App bundle ID used for notifications. |

Set `CLOUDFLARE_API_TOKEN` as a repository secret. It is the only secret used as the
Release enablement gate. The deployment additionally requires these repository secrets:

- `PLANETSCALE_API_TOKEN_ID`
- `PLANETSCALE_API_TOKEN`
- `AXIOM_TOKEN`
- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`

Example commands for the public release inputs:

```sh
gh variable set CLOUDFLARE_ACCOUNT_ID --repo OWNER/REPO --body "<account-id>"
gh variable set RELAY_API_ZONE_NAME --repo OWNER/REPO --body "example.com"
gh variable set RELAY_DOMAIN --repo OWNER/REPO --body "relay.example.com"
gh variable set CLERK_PUBLISHABLE_KEY --repo OWNER/REPO --body "pk_live_..."
gh variable set CLERK_JWT_TEMPLATE --repo OWNER/REPO --body "t3-relay"
gh variable set CLERK_CLI_OAUTH_CLIENT_ID --repo OWNER/REPO --body "<oauth-client-id>"
gh secret set CLOUDFLARE_API_TOKEN --repo OWNER/REPO
```

Omit the `RELAY_DOMAIN` command when using the derived hostname. Set the deploy-only values
the same way before running the production deployment.

## First deploy and later deploys

The workflow [`deploy-relay.yml`](../../.github/workflows/deploy-relay.yml) supports both pushes
to `main` and manual dispatch:

1. Merge the workflow to the default branch and add all variables and secrets above.
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
  short-lived relay client tracing configuration, derives the public relay URL, and injects
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
   {"ok":true,"service":"relay"}
   ```

2. In Cloudflare, confirm the relay Worker has its custom domain, two relay queues exist,
   Hyperdrive points to the production database, and the Alchemy state-store Worker exists.
3. Inspect the next Release run:
   - **Resolve T3 Connect public config** succeeds rather than skips.
   - Desktop, CLI, and hosted-web jobs download the relay tracing artifact.
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
