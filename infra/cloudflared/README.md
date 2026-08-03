# Cloudflare Tunnel on Ubuntu

This guide installs `cloudflared`, exposes the Ubuntu-hosted T3 surface behind Cloudflare Access at
`app.t3turbo.pro`, and documents optional protected SSH/PostgreSQL routes.

## Hostname ownership

The locked topology assigns:

- `relay.t3turbo.pro` to the Cloudflare Worker custom domain;
- `app.t3turbo.pro` to the Ubuntu `cloudflared` tunnel;
- `db.t3turbo.pro` to the DNS-only public TLS endpoint used by Hyperdrive.

A hostname cannot simultaneously be a Worker custom domain and a tunnel CNAME. Do not run
`cloudflared tunnel route dns` for `relay.t3turbo.pro` while the Worker owns it. The example config
contains a commented relay-origin rule only to document the mutually exclusive fallback if the
architecture later stops using a Worker.

Authoritative references:

- [Download `cloudflared`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
- [Create a locally managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)
- [Tunnel configuration files](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/)
- [Run a tunnel as a Linux service](https://developers.cloudflare.com/tunnel/advanced/local-management/as-a-service/linux/)

## Install `cloudflared`

Use Cloudflare's stable APT repository:

```sh
sudo install -d -m 0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
sudo apt-get update
sudo apt-get install cloudflared
cloudflared --version
```

Cloudflare supports `cloudflared` releases within one year of the current release. Apply package
updates deliberately; an upgrade restarts the connector and can drop long-lived WebSockets unless
another replica is serving the same tunnel.

## Choose one authentication model

### Remotely managed tunnel: token

Create the tunnel in **Cloudflare Dashboard > Zero Trust > Networks > Tunnels**, define public
hostnames there, and copy the connector token. The token is a runtime secret scoped to that tunnel.
Install the vendor service without placing the token in shell history by storing it in a
root-readable environment file and using a reviewed systemd unit, or use Cloudflare's generated
`service install` command from a private terminal:

```sh
sudo cloudflared service install <CLOUDFLARE_TUNNEL_TOKEN>
```

For the token model, ingress is managed in the dashboard/API. Do not also maintain a local ingress
file as a competing source of truth.

### Locally managed tunnel: `cert.pem` plus scoped JSON

`cloudflared tunnel login` opens an authorization flow and writes `cert.pem`. That certificate is
account-wide management authority: it creates/deletes tunnels and routes DNS. It is **not** the
credential a named tunnel uses at runtime.

```sh
cloudflared tunnel login
cloudflared tunnel create t3turbo-origin
cloudflared tunnel list
```

Creation writes `<TUNNEL_UUID>.json`, the scoped runtime credential. Copy only that JSON and the
rendered config to `/etc/cloudflared`, make them readable only by root and the dedicated service
group, and remove `cert.pem` from the production host when tunnel management occurs elsewhere.

```sh
id -u cloudflared >/dev/null 2>&1 \
  || sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin cloudflared
sudo install -d -o root -g cloudflared -m 0750 /etc/cloudflared
sudo install -o root -g cloudflared -m 0640 \
  "$HOME/.cloudflared/<TUNNEL_UUID>.json" \
  /etc/cloudflared/<TUNNEL_UUID>.json
sudo install -o root -g cloudflared -m 0640 \
  /path/to/t3code/infra/cloudflared/config.yml.example \
  /etc/cloudflared/config.yml
```

Replace the example markers in `/etc/cloudflared/config.yml`; never edit the checked-in example
with production values.

## DNS routing

For a locally managed tunnel, first create a self-hosted Cloudflare Access application for
`app.t3turbo.pro` with a deny-by-default operator policy. Then route the hosted application:

```sh
cloudflared tunnel route dns t3turbo-origin app.t3turbo.pro
```

This creates a proxied CNAME to the tunnel. Confirm it does not overwrite an existing record.

Do not route `relay.t3turbo.pro`; the relay Worker deployment creates its custom domain. Do not
route the locked public database endpoint through the normal HTTP tunnel. `db.t3turbo.pro` is
DNS-only and firewalled as described in `infra/supabase/SETUP-RULES.md`.

## Ingress and Access

The first matching ingress rule wins, and the final rule must be a catch-all. Validate and test the
rendered file before starting the service:

```sh
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule \
  https://app.t3turbo.pro
```

Requirements:

- Bind local web services to loopback when only the tunnel should reach them.
- Protect `app.t3turbo.pro` with a deny-by-default Access application and test both authorized and
  denied clients. The hostname is discoverable after certificate issuance.
- Put Cloudflare Access in front of optional SSH or TCP public hostnames before adding their DNS
  routes.
- Raw TCP ingress requires a compatible Cloudflare client path. It is not an unauthenticated public
  TCP proxy.
- For Hyperdrive's private-database Tunnel integration, follow Cloudflare's dedicated Hyperdrive
  setup rather than treating the optional example TCP rule as sufficient.
- Keep the catch-all `http_status:404` rule.

## Install as a systemd service

Cloudflare's package can install its own unit:

```sh
sudo cloudflared --config /etc/cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
```

Alternatively, install the reviewed template:

```sh
sudo install -o root -g root -m 0644 \
  /path/to/t3code/infra/cloudflared/cloudflared.service.example \
  /etc/systemd/system/cloudflared.service
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared
```

The template is for locally managed JSON credentials. Token-managed installations should use the
vendor-generated unit or a separate root-readable environment-file design.

## Verify

```sh
systemctl is-enabled cloudflared
systemctl is-active cloudflared
systemctl status cloudflared --no-pager
journalctl -u cloudflared --since '15 minutes ago' --no-pager
cloudflared access curl https://app.t3turbo.pro/
```

Also confirm:

- at least four edge connections are reported for one connector;
- the app response comes from the intended local service;
- an unmanaged client is denied by Access before it reaches the app;
- a nonexistent path/hostname does not expose another local service;
- WebSocket traffic survives normal use;
- `relay.t3turbo.pro` still resolves to the Worker custom domain, not the tunnel.

Run `cloudflared tunnel info t3turbo-origin` from the administrative workstation that retains
`cert.pem`; it is expected to fail on a hardened runtime host where that account credential was
removed.

## Update and rollback

For a single connector, package updates briefly interrupt traffic:

```sh
sudo apt-get update
sudo apt-get install --only-upgrade cloudflared
sudo systemctl restart cloudflared
```

For lower disruption, run a second connector replica with the same tunnel credential, update and
verify it, then update the first.

Rollback order:

1. Restore the last known-good `/etc/cloudflared/config.yml`.
2. Validate it.
3. Restart one connector and verify application/WebSocket traffic.
4. Roll back the package only when the configuration is known good.

To withdraw exposure without deleting state, remove the `app.t3turbo.pro` tunnel route or stop the
service. Deleting the tunnel invalidates all replicas and should be reserved for decommissioning.
