# Cloudflare production status

Last public audit: **2026-08-04 10:11 America/New_York**.

This page records externally observable state only. It contains no account IDs, tokens, tunnel IDs,
database addresses, or generated Alchemy state. Re-run the checks after every deployment; do not
treat this snapshot as configuration.

## Confirmed

- `relay.t3turbo.pro` resolves through Cloudflare and `GET /health` returns
  `{"ok":true,"service":"relay"}` with HTTP 200.
- The relay OAuth authorization-server and protected-resource metadata endpoints return HTTP 200
  and identify `https://relay.t3turbo.pro` as the issuer/resource.
- `app.t3turbo.pro` resolves through Cloudflare and an unauthenticated request is redirected to the
  configured Cloudflare Access login. The app hostname is therefore Access-protected.
- GitHub Actions run `30911343426` successfully evaluated the production relay deployment for
  commit `a3f2e2282` on `main`; its published commit status says the deployment was a no-op.
- The preceding successful relay runs for `7ba69c78d` and `37ea1bdd5` reported applied
  infrastructure changes.

## Not confirmed or incomplete

- `db.t3turbo.pro` returns NXDOMAIN. The documented public PostgreSQL endpoint is not currently
  published under that hostname. Do not assume the live Hyperdrive origin from public DNS.
- The relay health and OAuth metadata endpoints are publicly reachable rather than intercepted by
  Cloudflare Access. Account-level inspection is still required to determine whether another Access
  policy protects non-public relay routes and whether that matches the intended client design.
- Public checks cannot identify the Worker script name, Hyperdrive configuration, tunnel UUID,
  connector health, DNS record ownership, or active Alchemy state.
- No authenticated Cloudflare CLI session or `CLOUDFLARE_*` environment credentials were available
  in the audit workspace. Finish the account inventory from Cloudflare using a read-only token; do
  not copy credentials into this repository or command output.

## Account-level follow-up

With a read-only Cloudflare session, record only non-secret identifiers and status:

1. Worker custom domain and active version for `relay.t3turbo.pro`.
2. Hyperdrive name, origin hostname (redacted if private), health, and cache settings.
3. Tunnel name, connector health, and ingress ownership for `app.t3turbo.pro`.
4. Access applications/policies for both public hostnames.
5. DNS ownership for `relay`, `app`, and the intended database endpoint.
6. Whether production deployment should remain triggered from `main` or be deliberately moved to
   `infra/t3turbo-relay` after branch protection is configured.
