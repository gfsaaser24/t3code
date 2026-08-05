# Self-host the hosted web app on Cloudflare

> For operators running a fork. The upstream hosted app (`app.t3.codes`) deploys to Vercel via
> `apps/web/vercel.ts`; this runbook is the Cloudflare Workers equivalent for forks that keep
> their infrastructure on Cloudflare.

The hosted app is a static build of `apps/web` with hosted-mode flags baked in at build time.
Hosted mode makes the client show the multi-environment T3 Connect experience (sign in, pick a
linked environment, connect through its managed tunnel) instead of treating its own origin as a
single environment and demanding pairing.

## Prerequisites

- A deployed relay and Clerk application ([Self-host the T3 Connect relay](./self-host-relay.md)).
- Repository-root `.env` or `.env.local` with the Connect public values
  (`T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`,
  `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`, `T3CODE_RELAY_URL`).
- A Cloudflare API token that can upload Workers scripts and manage the target zone's DNS.

## Build

From the repository root:

```sh
VITE_HOSTED_APP_CHANNEL=latest \
VITE_HOSTED_APP_URL=https://app.example.com \
pnpm --filter @t3tools/web run build
node scripts/apply-web-brand-assets.ts --channel latest
```

`VITE_HOSTED_APP_CHANNEL` switches the bundle into hosted mode; `VITE_HOSTED_APP_URL` must be the
final origin so origin detection and CLI OAuth callbacks resolve correctly. Both are baked at
build time — a rebuild is required to change them.

## Deploy

`apps/web/wrangler.hosted.jsonc` deploys `dist/` as an assets-only Worker with SPA routing and a
custom domain:

```sh
cd apps/web
npx wrangler deploy --config wrangler.hosted.jsonc
```

If the token cannot manage zone-level Worker routes, the asset upload still succeeds; attach the
custom domain through the account-scoped API instead:

```sh
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/domains" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"zone_id":"<zone-id>","hostname":"app.example.com","service":"t3turbo-hosted-app","environment":"production"}'
```

An existing DNS record on the hostname blocks custom-domain attachment — delete it first.

## Clerk origin

Add the hosted origin to the Clerk instance's `allowed_origins` (Backend API only, no dashboard
UI — preserve existing entries, the PATCH replaces the whole array):

```sh
curl -X PATCH https://api.clerk.com/v1/instance \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"allowed_origins":["t3code://app","https://app.example.com"]}'
```

## Pitfalls

- **Do not put Cloudflare Access in front of the hosted app.** The app authenticates with Clerk;
  an Access wall breaks OAuth redirects and the CLI's out-of-band connect flow.
- A bundle built **without** the hosted flags served on this hostname falls back to
  single-environment mode and gates on `/pair` — if users report a pairing prompt on the hosted
  origin, the deployed bundle is wrong, not their tokens.
- Connecting from the hosted app to a linked environment never uses pairing tokens; pairing
  tokens are one-time, short-lived, and only for direct (LAN/tailnet) backends.
- This deploy is manual. Rebuild and redeploy after web changes you want reflected on the hosted
  origin, or wire the two commands above into the release workflow.
