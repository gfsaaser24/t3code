# Host your own T3 Code

> For operators standing up a complete fork ("T3 Turbo"-style) from scratch. This is the ordering
> guide: it tells you what to build, in what order, and which steps break silently when skipped.
> Detail lives in the linked runbooks — [Self-host the T3 Connect relay](./self-host-relay.md),
> [Self-host the hosted web app](./self-host-hosted-app.md), and
> [T3 Connect](../internals/t3-connect.md).

## What you are assembling

Six pieces, with hard dependencies between them:

1. **The fork** — this repository, building desktop installers, the CLI, and web bundles.
2. **A Postgres database** — the relay's persistence (Supabase hosted or self-hosted).
3. **A Clerk application** — user auth for web, desktop, mobile, and CLI.
4. **The relay** — a Cloudflare Worker (control plane: links environments, mints credentials,
   provisions managed tunnels).
5. **Client builds** — desktop/CLI/web with the public Connect values baked in at build time.
6. **The hosted web app** — the browser entry point (`app.<your-domain>`).

The dependency chain is strict: clients need the relay URL at build time, the relay needs the
database and Clerk at deploy time, and Clerk needs your final origins. Follow the order below and
each step's output feeds the next; skip ahead and you get the failure modes in the table at the
end — every one of which was hit for real while assembling the first T3 Turbo deployment.

## Step 1 — Fork, domains, Cloudflare account

- Fork the repository. Decide your product name and (optionally) apply branding.
- Add your DNS zone(s) to a Cloudflare account and finish nameserver activation. You need an API
  zone (`relay.<zone>`) and a tunnel zone for per-environment endpoints; they may be the same
  zone. If you plan multiple TLDs, decide **now** which one actually hosts things — deploy
  nothing to the others or you will chase ghosts later.
- Create the Cloudflare API token with the exact permission groups listed in
  [Prepare Cloudflare](./self-host-relay.md#prepare-cloudflare).

## Step 2 — Database

- Hosted Supabase: follow [Prepare Supabase](./self-host-relay.md#prepare-supabase).
- Self-hosted (Docker Supabase or plain Postgres): the origin must be **publicly reachable** for
  Hyperdrive, with TLS enabled. Restrict the exposed Postgres port to
  [Cloudflare's IP ranges](https://www.cloudflare.com/ips/) in your provider's cloud firewall —
  and remember a hypervisor-level firewall (Hetzner Cloud Firewall, AWS SG) is invisible from
  inside the VM when debugging reachability.
- **Apply the migrations before the first deploy** —
  [Apply database migrations](./self-host-relay.md#apply-database-migrations). The deploy
  workflow does not do this for external databases. An unmigrated database is the single most
  confusing failure in the stack: the relay deploys green, auth works, and then every real
  request 500s with `replay_persistence_failed`.

## Step 3 — Clerk

Follow [Prepare Clerk](./self-host-relay.md#prepare-clerk) plus the redirect and native-auth
detail in [T3 Connect](../internals/t3-connect.md). Every sub-step here is load-bearing:

1. Create the application; enable your sign-in methods.
2. **Create the JWT template `t3-relay` with claims `{ "aud": "t3-code-relay" }`.** Without it,
   sign-in works everywhere but T3 Connect stays locked: token minting 404s and clients report
   "Could not obtain the T3 Connect session token."
3. Create the public (PKCE) OAuth application for the CLI with both redirect URIs.
4. Enable the **Native API** and add `t3code://app/` (and `t3code-dev://app/` for dev builds) to
   the mobile SSO redirect allowlist.
5. Set **`allowed_origins`** through the Backend API — there is no dashboard UI for it, and the
   PATCH replaces the whole array, so send every origin at once: the desktop scheme(s), your
   hosted app origin, and any LAN origin you open the web client from:

   ```sh
   curl -X PATCH https://api.clerk.com/v1/instance \
     -H "Authorization: Bearer $CLERK_SECRET_KEY" -H "Content-Type: application/json" \
     -d '{"allowed_origins":["t3code://app","t3code-dev://app","https://app.example.com"]}'
   ```

   Skipping this is invisible in a browser at `localhost` and fatal in the packaged desktop app:
   Clerk never finishes loading, so the sign-in entry point simply does not render. Do **not**
   work around origin rejections by stripping the `Origin` header in the desktop shell — Clerk's
   API needs the CORS preflight to succeed, and header surgery kills every request instead.

## Step 4 — GitHub configuration and relay deploy

- Set the repository variables and secrets from the
  [Activation checklist](./self-host-relay.md#activation-checklist).
- Run the deploy per [First deploy and later deploys](./self-host-relay.md#first-deploy-and-later-deploys).
- **Verify before moving on:** `curl https://relay.<zone>/v1/environments` must return
  `401 {"code":"auth_invalid"}`. A `500` here means database (reachability or migrations) — fix
  it now, nothing downstream works until this is a 401.

## Step 5 — Client builds

- Put the four public values in the repository-root `.env` or `.env.local`
  (`T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`,
  `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`, `T3CODE_RELAY_URL`). A successful relay deploy writes
  `T3CODE_RELAY_URL` for you.
- Build installers (`vp run dist:desktop:win:x64` etc.). All Connect values are **baked at build
  time** — a build made before the `.env` existed is permanently Connect-free, and no runtime
  configuration will revive it. When in doubt whether an installed build has the values, grep the
  packaged client bundle for your relay hostname.
- CI releases inject the same values automatically once Step 4's variables exist.

## Step 6 — Hosted web app

Follow [Self-host the hosted web app](./self-host-hosted-app.md). Deploy it to the hostname you
chose in Step 1, and confirm that hostname carries **nothing else** — no leftover tunnels, no
Cloudflare Access in front. Then add that origin to Clerk `allowed_origins` (Step 3.5) if you
have not already.

## Step 7 — Verify the whole chain

In order, each proving one layer:

1. Relay: `curl https://relay.<zone>/v1/environments` → `401 auth_invalid`.
2. Desktop app: sidebar shows **Sign in to T3 Connect**; sign-in completes.
3. Settings → Connections: **T3 Connect** toggle is enabled after sign-in; flip it →
   "T3 Connect linked".
4. Tunnel: the environment's endpoint (visible in the relay's `environment_links` row or the
   client UI) serves `/.well-known/t3/environment` with your environment's descriptor.
5. Hosted app: sign in at `https://app.<zone>`, your environment appears, connect — **no pairing
   token is involved anywhere in this flow**.

## Failure-mode index

Symptoms observed while standing up the first fork deployment, and what each actually means:

| Symptom | Actual cause |
| --- | --- |
| Sign-in works, Connect toggle stays disabled, Clerk returns 404 on `.../tokens/t3-relay` | JWT template `t3-relay` missing (Step 3.2) |
| Desktop app shows no sign-in entry at all; web at `127.0.0.1` works | Desktop scheme absent from Clerk `allowed_origins` (Step 3.5), or the build predates the `.env` (Step 5) |
| CORS preflight failures on every Clerk request from `t3code://app` | Origin not allowed (Step 3.5). Never fix by stripping the `Origin` header |
| Relay 500s: `replay_persistence_failed`, environments list fails | Migrations never applied, or Hyperdrive cannot reach the database (Step 2) |
| Enabling Connect fails with "Could not check relay client availability" | Same as above — the relay's database layer is down |
| Hosted origin gates on `/pair` | The deployed bundle was built without hosted flags, or the hostname serves something older (Step 6) |
| "Invalid pairing token" in a browser | Pairing tokens are one-time and expire in minutes; the Connect flow never needs one. Generate fresh, or sign in to T3 Connect instead |
| OAuth completes in the browser but never returns to the Windows app | Installer built before `t3code://` protocol registration existed on Windows — rebuild with a current `scripts/build-desktop-artifact.ts` |
