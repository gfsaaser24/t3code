# T3-Turbo nightly source sync

For a plain-English walkthrough of the complete inbound update flow, see
[`docs/internals/t3-turbo-nightly-inbound.md`](../docs/internals/t3-turbo-nightly-inbound.md).

`turbo-nightly-sync.yml` rebases the commits on the fork's `turbo` branch onto upstream `main`,
using the newest published Nightly source tag from `pingdotgg/t3code` as a deterministic version
anchor. It therefore receives both normal main commits and official Nightly releases. It never
downloads or republishes an official installer.

The branch must be bootstrapped once by creating `turbo` from the commit recorded in
`upstream.json`, applying the Turbo customization commits, and pushing it to the fork. Keep
Turbo-only work as a small reviewable commit stack above that recorded SHA; the workflow
rewrites that stack during each successful rebase.

The Windows build is intentionally self-contained and unsigned. It does not use official T3
signing, Clerk, relay, or deployment credentials. Windows may show a SmartScreen warning for
the resulting installer. `T3CODE_DESKTOP_UPDATE_REPOSITORY` makes the packaging script generate
`release/nightly.yml` for this fork, and the workflow refuses to publish without that manifest.

The scheduled sync is gated by the repository variable `TURBO_NIGHTLY_ENABLED`. Set it to `true`
after the `turbo` branch and default-branch scheduler are bootstrapped. Checkout credentials are
not persisted in source-sync or build jobs; only the final publish job receives a write token.

On a Git rebase conflict, automation aborts the rebase, uploads a Markdown collision report,
and opens or updates an issue. A maintainer must reproduce the rebase, resolve and review the
conflict, update `upstream.json`, and push the resulting stack to `turbo`. The workflow never
chooses a conflict resolution.

GitHub failure email works through normal account notification settings. Optional Telegram
alerts use the `TURBO_TELEGRAM_ENABLED` variable plus the `TURBO_TELEGRAM_BOT_TOKEN` and
`TURBO_TELEGRAM_CHAT_ID` secrets; the direct API notification is non-blocking and sends links to
the failed run, review issue, and manual workflow page.
