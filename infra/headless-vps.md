# Headless VPS environment

Use this when you want agents to work on a remote Linux host (a VPS, a cloud VM, or a home
server), not on the laptop you type from.

After setup, that host is a full T3 Code **environment**: projects, files, git state, terminals,
provider CLIs, and thread history live there. Your desktop, web, or mobile client only connects
and directs the work.

This is different from opening a port so your **local** machine is reachable. Here the remote host
**is** the working machine.

For pairing details and LAN/desktop options, see [Remote access](../docs/user/remote-access.md). For the Linux
systemd unit, see [Background service](../docs/user/background-service.md).

## Mental model

| Piece | Lives where |
| --- | --- |
| T3 Code server | The VPS |
| Provider CLIs (`claude`, `codex`, …) and their logins | The VPS |
| Project directories and git checkouts | The VPS |
| Thread history and environment settings | The VPS (`~/.t3` by default) |
| Desktop / web / mobile UI | Your laptop or phone |

If a provider is only authenticated on your laptop, sessions on the VPS will fail. Log in on the
machine that runs the server.

## Requirements on the VPS

- Linux with **systemd** (needed for the background service)
- Node.js `^22.16 || ^23.11 || >=24.10` on `PATH` for non-interactive shells (`ssh user@host 'node -v'`)
- Outbound HTTPS (T3 Connect installs and runs a managed tunnel client)
- At least one [provider CLI](../docs/user/install.md#providers), installed and authenticated **on the VPS**
- Enough disk and RAM for the repos and agent work you plan to run

Optional but useful: `git`, your usual language toolchains, and either Tailscale or a private
network if you prefer not to use T3 Connect.

Recommended size for light agent use: **2+ vCPU, 4+ GB RAM, SSD**. Heavier multi-repo or
parallel-agent loads need more.

## Choose how clients reach the VPS

| Method | Best when | Inbound ports on the VPS |
| --- | --- | --- |
| **T3 Connect** (recommended) | You want phone + hosted web + desktop without opening the server to the internet | None on the VPS (outbound managed tunnel only; clients reach a tunnel hostname, not your public IP) |
| **Tailscale** (+ `t3 serve` / `t3 pair`) | You already mesh devices on a tailnet and want private HTTPS | None public; tailnet only |
| **Desktop SSH** | You only use the desktop app and already SSH to the host | SSH only |

Do not bind the T3 server to `0.0.0.0` on a public VPS IP unless you understand the exposure.
Prefer Connect, Tailscale, or SSH.

---

## Recommended path: T3 Connect + background service

This is the usual “always-on remote environment” setup.

### 1. SSH in and install Node

```bash
ssh user@your-vps
node -v   # must satisfy ^22.16 || ^23.11 || >=24.10
```

If `node` is missing from a non-interactive SSH session, fix that before continuing (install Node
system-wide, or set a version-manager default that non-interactive shells load).

### 2. Install and authenticate providers on the VPS

Example for Claude:

```bash
# install Claude Code per https://claude.com/product/claude-code
claude auth login
```

Repeat for each provider you use ([install guide](../docs/user/install.md#providers)). Finish browser or
device auth from a machine that can open the login page; the **credential must end up on the VPS**.

### 3. Put your code on the VPS

Agents edit files on this host. Clone or sync repos before you add projects in the UI:

```bash
mkdir -p ~/code
cd ~/code
git clone <your-repo-url>
```

### 4. Link the host with T3 Connect

From the same SSH session:

```bash
npx t3@latest connect
```

Over SSH, Connect uses **headless (out-of-band) OAuth** automatically: it prints a URL, you open
that URL on a device with a browser, sign in, and paste the code back into the SSH terminal. You
can force that flow with `npx t3@latest connect --headless`.

What this does:

1. Signs this host into your T3 Connect account (stores a CLI credential)
2. Records durable intent to expose it through T3 Connect’s managed tunnel on the next server start
3. May download the managed tunnel client (with a confirm prompt) if it is not already available
4. Offers to install the **background service** (Linux with systemd only) so the server survives
   logout and reboot

No running T3 server is required for steps 1–3. The environment link and tunnel are created when
the server starts with that intent recorded (background service, `npx t3@latest serve`, or
`npx t3@latest start`).

If you skip the service prompt, install it yourself:

```bash
npx t3@latest service install
npx t3@latest service status
```

Check Connect status:

```bash
npx t3@latest connect status
```

You want exposure **enabled**, a stored authorization, and an environment link that is
**provisioned** (or “pending server startup” until any T3 server process has started once with
Connect intent set). If the link is still pending, start or restart the server and check again:

```bash
npx t3@latest service update   # repairs/restarts the background service when needed
npx t3@latest connect status
```

Useful subcommands:

```bash
npx t3@latest connect link      # authorize + enable exposure (no service onboarding prompt)
npx t3@latest connect status
npx t3@latest connect unlink    # stop exposure; keep the stored login
npx t3@latest connect logout    # stop exposure and clear the CLI credential
```

`connect link` does not offer the background-service prompt; use `service install` separately if
you need always-on after a bare `link`.

### 5. Connect from a client

1. Open the desktop app, the hosted web app, or the mobile app.
2. Sign in to **T3 Connect** with the **same account** you used on the VPS.
3. Open the environment list and select the VPS environment (it appears after the link is
   provisioned).

No pairing token is required for the Connect path. Pairing tokens are for direct / Tailscale /
hosted-pairing links only.

### 6. Add a project on the VPS environment

1. Select the VPS environment (not “this machine” / local).
2. Command Palette → **Add Project**.
3. Choose a directory that exists **on the VPS** (for example `~/code/my-repo`).

Work you start in that project runs on the VPS: file edits, terminals, and provider sessions all
use the remote filesystem and remote provider logins.

---

## Alternative: Tailscale (no T3 Connect)

Use this when the VPS and your clients share a tailnet and you want a private HTTPS URL.

1. Install and log in Tailscale on the VPS and on each client device.
2. On the VPS, install the background service (or run `serve` in a long-lived session):

   ```bash
   npx t3@latest service install
   # or, foreground:
   npx t3@latest serve --tailscale-serve
   ```

3. Mint a pairing link that uses the Tailscale HTTPS endpoint:

   ```bash
   npx t3@latest pair --tailscale
   ```

4. Open the pairing URL from the desktop app, mobile app, or a client that can reach the tailnet.
   For the hosted web app, the backend URL must be **HTTPS** (Tailscale Serve provides that).

Details: [Remote access → Headless server](../docs/user/remote-access.md#option-2-headless-server-cli) and
[Tailscale endpoints](../docs/user/remote-access.md#tailscale-endpoints).

---

## Alternative: Desktop-managed SSH launch

Use this when you only need the desktop app and already SSH to the host.

1. Desktop → **Settings** → **Connections** → **Add environment** → **SSH**.
2. Enter `user@your-vps` (or an SSH config host).
3. Desktop starts or reuses a remote T3 server and port-forwards it locally.

The VPS still owns files and providers. SSH is an access helper, not a second product mode. If the
background service is already running on the host, desktop reuses that server rather than fighting
it. For an always-on host you control from phone or browser, prefer Connect + the background
service instead of depending on the desktop to keep the SSH tunnel open.

Details and Node/`PATH` troubleshooting: [Remote access → SSH](../docs/user/remote-access.md#option-3-desktop-managed-ssh).

---

## Day-to-day operations

### Keep the server running

```bash
npx t3@latest service status
```

Logs for the systemd unit are printed by `service install` / `service status`. Signing out of T3
Connect does **not** remove the service; use `npx t3@latest service uninstall` for that.

### Update the server

When the client and server versions differ, T3 Code shows a warning. For a background-service host,
prefer **Update server** in the UI, or on the VPS:

```bash
npx t3@<client-version> service update
```

Use the exact version from the warning when possible. See [Keeping T3 Code in sync](../docs/user/updating.md).

### Pair another device without Connect

If the service is already running:

```bash
npx t3@latest pair
# or over Tailscale HTTPS:
npx t3@latest pair --tailscale
```

### Confirm which machine is active

In the client, check the environment name and that **Add Project** paths match the VPS layout. If
you add a project under a local Windows path while the VPS environment is selected, it will not
match files on the remote host.

---

## Security checklist

- Prefer **T3 Connect** or **Tailscale** over opening the T3 HTTP port on a public IP.
- Treat pairing URLs and tokens like passwords; they create sessions until they expire or you revoke
  them (`t3 auth`).
- Provider API credentials and git SSH keys on the VPS can act on your behalf — lock down SSH and
  keep the host patched.
- Use a dedicated OS user for T3 if the host is shared; the background service is per-user.
- Revoke access you no longer trust: `npx t3@latest connect unlink` / `logout`, and `t3 auth` for
  pairing sessions.

---

## Self-hosted / fork builds (T3 Turbo and similar)

The VPS steps above are the same. What changes is **which** client and CLI builds you run:

- Official releases talk to the official T3 Connect stack (`app.t3.codes` and the official relay)
  by default.
- A fork that hosts its own relay and hosted app (for example T3 Turbo’s `app.t3turbo.pro`) needs
  **clients and a CLI whose Connect public config points at that stack** (baked at build time, or
  the matching runtime `T3CODE_*` overrides). A stock `npx t3@latest` from the public registry
  targets the official stack unless you deliberately reconfigure it.
- On this fork the CLI may label the systemd unit “T3 Turbo service”; the commands are still
  `t3 service …` and default data still lives under `~/.t3` unless you set `T3CODE_HOME`.

Operators standing up the shared Connect infrastructure (relay, Clerk, database, hosted app)
should follow [Host your own T3 Code](../docs/operations/host-your-own.md). That guide is not for
installing an individual agent host. Each VPS or laptop that should appear as an environment still
runs the headless steps in this document against that stack.

---

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Environment never appears after Connect | Same Connect account on client and VPS; `connect status` shows provisioned link; a T3 server process is running with Connect intent set |
| Provider fails at session start | Provider CLI on VPS `PATH`; login was run **on the VPS**; binary path in Settings if needed |
| `node: command not found` over SSH | Non-interactive `PATH` / version-manager default on the VPS |
| Hosted web cannot connect | Backend must be HTTPS/WSS (Connect or Tailscale Serve). Plain `http://` LAN URLs are blocked from HTTPS pages |
| Works until you disconnect SSH | Background service not installed; run `service install` so the process outlives the session |
| “Invalid pairing token” while using Connect | Connect does not use pairing tokens; sign in and pick the environment instead |
| `connect` complains about missing config | CLI/build lacks Connect public values (common on unconfigured source builds); use a release built for your stack |

---

## Related docs

- [Install](../docs/user/install.md) — Node and provider CLIs
- [Remote access](../docs/user/remote-access.md) — pairing, Tailscale, SSH launch
- [Background service](../docs/user/background-service.md) — systemd install / update / uninstall
- [Keeping T3 Code in sync](../docs/user/updating.md) — version skew and remote updates
- [Infra master runbook](./README.md) — control-plane bring-up for this fork
