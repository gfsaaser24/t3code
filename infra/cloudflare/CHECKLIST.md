# Cloudflare and GitHub Actions checklist

This file is generated from the names referenced by `.github/workflows/deploy-relay.yml` and
`.github/workflows/release.yml` at this branch point. The lists contain names only so the file can
be shared safely. Values belong in GitHub repository settings or the `production` environment,
never in Git.

## Locked-stack selection

The current relay supports external PostgreSQL and makes Axiom/APNs optional. For T3 Turbo, set the
complete `DATABASE_*` group below and leave every PlanetScale, Axiom, and APNs setting unset. The
legacy and optional names remain in the exact workflow inventory because the workflow references
them; they are not required for this deployment.

## `.github/workflows/deploy-relay.yml`

Variables:

- `APNS_BUNDLE_ID`
- `APNS_ENVIRONMENT`
- `APNS_KEY_ID`
- `APNS_TEAM_ID`
- `AXIOM_ORG_ID`
- `CLERK_JWT_AUDIENCE`
- `CLERK_PUBLISHABLE_KEY`
- `CLOUDFLARE_ACCOUNT_ID`
- `DATABASE_HOST`
- `DATABASE_NAME`
- `DATABASE_PORT`
- `DATABASE_USER`
- `PLANETSCALE_ORGANIZATION`
- `RELAY_API_ZONE_NAME`
- `RELAY_DOMAIN`
- `RELAY_TUNNEL_ZONE_NAME`

Secrets:

- `APNS_PRIVATE_KEY`
- `AXIOM_TOKEN`
- `CLERK_SECRET_KEY`
- `CLOUDFLARE_API_TOKEN`
- `DATABASE_PASSWORD`
- `PLANETSCALE_API_TOKEN`
- `PLANETSCALE_API_TOKEN_ID`

## `.github/workflows/release.yml`

Variables:

- `APPLE_TEAM_ID`
- `CLERK_CLI_OAUTH_CLIENT_ID`
- `CLERK_JWT_TEMPLATE`
- `CLERK_PASSKEY_RP_DOMAINS`
- `CLERK_PUBLISHABLE_KEY`
- `CLOUDFLARE_ACCOUNT_ID`
- `RELAY_API_ZONE_NAME`
- `RELAY_DOMAIN`
- `T3CODE_WEB_LATEST_DOMAIN`
- `T3CODE_WEB_NIGHTLY_DOMAIN`
- `T3CODE_WEB_ROUTER_URL`
- `VERCEL_TEAM_SLUG`

Secrets:

- `APPLE_API_ISSUER`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TENANT_ID`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`
- `CLOUDFLARE_API_TOKEN`
- `CSC_KEY_PASSWORD`
- `CSC_LINK`
- `DISCORD_RELEASE_LATEST_ROLE_ID`
- `DISCORD_RELEASE_NIGHTLY_ROLE_ID`
- `DISCORD_RELEASE_WEBHOOK_URL`
- `MACOS_PROVISIONING_PROFILE`
- `RELEASE_APP_ID`
- `RELEASE_APP_PRIVATE_KEY`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`
- `VERCEL_TOKEN`

## Locked relay/release configuration

Required variables:

- `CLERK_CLI_OAUTH_CLIENT_ID`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `CLERK_PUBLISHABLE_KEY`
- `CLOUDFLARE_ACCOUNT_ID`
- `DATABASE_HOST`
- `DATABASE_NAME`
- `DATABASE_PORT`
- `DATABASE_USER`
- `RELAY_API_ZONE_NAME`
- `RELAY_DOMAIN`
- `RELAY_TUNNEL_ZONE_NAME`

Required secrets:

- `CLERK_SECRET_KEY`
- `CLOUDFLARE_API_TOKEN`
- `DATABASE_PASSWORD`

Keep these optional/legacy groups entirely unset:

- `AXIOM_ORG_ID` and `AXIOM_TOKEN`
- `APNS_ENVIRONMENT`, `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_BUNDLE_ID`, and `APNS_PRIVATE_KEY`
- `PLANETSCALE_ORGANIZATION`, `PLANETSCALE_API_TOKEN_ID`, and `PLANETSCALE_API_TOKEN`

An incomplete `DATABASE_*` group causes the relay to select its PlanetScale fallback. Treat all
five database settings as one atomic configuration.

## Cloudflare API token permissions

Restrict the token to the one Cloudflare account and the `t3turbo.pro` API/managed-endpoint zones.
The resources currently created by `infra/relay` require these permission groups.

Account permissions:

- `Workers Scripts Write`
- `Hyperdrive Write`
- `Secrets Store Write`
- `Account API Tokens Write`
- `Cloudflare Tunnel Read`
- `Cloudflare Tunnel Write`

Zone permissions:

- `Zone Read`
- `DNS Read`
- `DNS Write`

Cloudflare's dashboard may display `Edit` where the API permission group is named `Write`.
`Account API Tokens Write` is needed because the current Alchemy deployment mints narrower runtime
tokens for managed tunnel and DNS bindings. Revalidate these permissions against the actual
deployment plan after every upstream rebase. Add `Queues Write` only when APNs is enabled; the
locked Android-only deployment does not create APNs queues.

Do not use a Global API Key. Set an expiration date, rotate the token, and avoid granting access to
unrelated accounts or zones.

## Zero Trust Access

Certificate Transparency and DNS make the production hostnames discoverable. Before production
traffic, create self-hosted Access applications for both `relay.t3turbo.pro` and
`app.t3turbo.pro` and attach deny-by-default policies.

- Restrict the app to intended operator identities and require enrolled-device posture where
  available.
- Restrict the relay to an Access mode every shipped web, CLI, and Android client can satisfy.
  Prefer enrolled Cloudflare One/Gateway devices for this operator deployment. Do not embed a
  service-token secret in a public client.
- Test an authorized request and a denied request from an unmanaged client for each hostname.
- Configure Access with an operator identity or a separate narrowly scoped token. The relay
  deployment token above intentionally does not need `Access: Apps and Policies Write` because the
  Alchemy stack does not reconcile Access policy.

## Zone notes for `t3turbo.pro`

- The zone must be active before production deploy. Alchemy adopts it as retained state; it does not
  configure registrar nameservers.
- `RELAY_API_ZONE_NAME` is `t3turbo.pro`.
- `RELAY_DOMAIN` is `relay.t3turbo.pro`.
- `RELAY_TUNNEL_ZONE_NAME` may be `t3turbo.pro` or a separately activated/delegated child zone.
- `relay.t3turbo.pro` must not have a conflicting CNAME when the Worker custom domain is created.
- `app.t3turbo.pro` is a proxied CNAME created by `cloudflared tunnel route dns` or the Zero Trust
  dashboard.
- `db.t3turbo.pro` is DNS-only for the locked public PostgreSQL TLS endpoint. Cloudflare's normal
  HTTP proxy does not proxy PostgreSQL.
- Do not create both a Worker custom domain and a tunnel route for `relay.t3turbo.pro`.
- Keep SSL/TLS mode `Full (strict)` for HTTP origins. The PostgreSQL endpoint has separate TLS and
  Hyperdrive certificate verification.
- If a separate managed-endpoint zone is used, restrict the deployment token to both zones and
  document delegation/renewal ownership.

## Preflight

- [ ] `t3turbo.pro` is active in the intended Cloudflare account.
- [ ] `relay.t3turbo.pro`, `app.t3turbo.pro`, and `db.t3turbo.pro` have non-conflicting ownership.
- [ ] Deny-by-default Access applications protect both relay and app hostnames.
- [ ] Intended clients pass the relay Access policy; unmanaged clients are denied.
- [ ] The deployment token is scoped and stored as `CLOUDFLARE_API_TOKEN`.
- [ ] The GitHub `production` environment has required reviewers and branch protection.
- [ ] Public Clerk values are variables; `CLERK_SECRET_KEY` is a secret.
- [ ] All four database variables are set and `DATABASE_PASSWORD` is a secret.
- [ ] No PlanetScale, Axiom, or APNs value has been added for the locked target.
- [ ] Relay schema, seed contract, and RLS have been applied before workflow dispatch.
