<#
.SYNOPSIS
  Build the Windows T3 Turbo installer with the T3 Connect public config baked in.

.DESCRIPTION
  Mirrors what the release workflow injects from the repository's Actions
  variables. These are public client-side values (they ship inside every
  release binary): the Clerk publishable key, JWT template, CLI OAuth client
  id, and the relay URL. Keeping them in this build wrapper - rather than in
  .env/.env.local - keeps the vitest suite green, because the web vite config
  compiles env-file values into the test bundle and breaks not-configured
  test cases.

  Secrets never belong here.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$env:T3CODE_CLERK_PUBLISHABLE_KEY = "pk_test_aWRlYWwtYnVmZmFsby00My5jbGVyay5hY2NvdW50cy5kZXYk"
$env:T3CODE_CLERK_JWT_TEMPLATE = "t3-relay"
$env:T3CODE_CLERK_CLI_OAUTH_CLIENT_ID = "ARXuuQgu9MQ3PjcI"
$env:T3CODE_RELAY_URL = "https://relay.t3turbo.pro"

Set-Location (Join-Path $PSScriptRoot "..")
pnpm dist:desktop:win
exit $LASTEXITCODE
