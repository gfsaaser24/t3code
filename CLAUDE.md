# T3 Turbo

This is the `turbo` branch of the `gfsaaser24/t3code` fork — a downstream operator build of
T3 Code with its own self-hosted Connect relay, isolated desktop identity and state home
(`~/.t3-turbo`), and a daily automated ingestion of all upstream code from `pingdotgg/t3code`.

The complete operating model and hard rules live at the top of `AGENTS.md`. Read that first.
The two rules that matter most:

- **Never push to `pingdotgg/t3code`.** Upstream is read-only; `gfsaaser24/t3code` is the only
  push target.
- **Fork changes to upstream-owned files must be registered** in `SEAM.md` and
  `.t3-turbo/customizations.json` so they survive the nightly rebase.

@AGENTS.md
