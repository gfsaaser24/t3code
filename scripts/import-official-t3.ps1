<#
.SYNOPSIS
  Import official T3 Code projects and chats into T3 Turbo from outside the app.

.DESCRIPTION
  Reusable wrapper around T3 Turbo's bundled importer CLI. No `t3` command on
  PATH is required: the script locates the installed T3 Turbo and runs its
  bundled server entry with ELECTRON_RUN_AS_NODE.

  Flow: stop T3 Turbo -> plan (non-mutating, prints a summary) -> apply
  (creates a recovery backup first) -> restart T3 Turbo. The official
  database is never modified.

.EXAMPLE
  # Review what would be imported (no changes):
  .\import-official-t3.ps1 -PlanOnly

.EXAMPLE
  # Full import, tolerating a stale "active session" left by an uninstalled
  # official T3 Code:
  .\import-official-t3.ps1 -AllowActive

.EXAMPLE
  # Re-run with reviewed collision choices:
  .\import-official-t3.ps1 -AllowActive -ChoicesPath "$env:USERPROFILE\.t3-turbo\official-import\choices.json"
#>
[CmdletBinding()]
param(
  [string]$SourceBaseDir = (Join-Path $env:USERPROFILE ".t3"),
  [string]$TargetBaseDir = (Join-Path $env:USERPROFILE ".t3-turbo"),
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA "Programs\t3-turbo"),
  [string]$BinPath = "",
  # Stop after printing the plan summary; makes no changes to the Turbo database.
  [switch]$PlanOnly,
  # Proceed even when a database still records an active session/turn. Only
  # safe because both apps are stopped by this script; required when official
  # T3 Code was uninstalled mid-session and its DB permanently records activity.
  [switch]$AllowActive,
  [string]$ChoicesPath = "",
  [switch]$NoRestart,
  # Leave a running T3 Turbo alone. Only safe when -TargetBaseDir is NOT the
  # live app's data directory (e.g. testing against copies).
  [switch]$SkipAppStop
)

$ErrorActionPreference = "Stop"

$exePath = Join-Path $AppDir "T3 Turbo.exe"
if ($BinPath -eq "") {
  $BinPath = Join-Path $AppDir "resources\app.asar.unpacked\apps\server\dist\bin.mjs"
}
foreach ($required in @($exePath, $BinPath)) {
  if (-not (Test-Path $required)) { throw "Not found: $required (pass -AppDir or -BinPath)" }
}
$exePath = (Resolve-Path $exePath).Path
$BinPath = (Resolve-Path $BinPath).Path
$SourceBaseDir = (Resolve-Path $SourceBaseDir).Path
$TargetBaseDir = (Resolve-Path $TargetBaseDir).Path
foreach ($pair in @(@("source", $SourceBaseDir), @("target", $TargetBaseDir))) {
  $db = Join-Path $pair[1] "userdata\state.sqlite"
  if (-not (Test-Path $db)) { throw "No $($pair[0]) database at $db" }
}

$workDir = Join-Path $TargetBaseDir "official-import"
New-Item -ItemType Directory -Force $workDir | Out-Null
$stamp = Get-Date -Format "yyyyMMddTHHmmss"
$planPath = Join-Path $workDir "external-plan-$stamp.json"
$resultPath = Join-Path $workDir "external-result-$stamp.json"

function Invoke-Importer {
  param([string[]]$CliArgs)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exePath
  $quoted = @("`"$BinPath`"") + ($CliArgs | ForEach-Object { if ($_ -match "\s") { "`"$_`"" } else { $_ } })
  $psi.Arguments = $quoted -join " "
  $psi.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1"
  if ($psi.EnvironmentVariables.ContainsKey("T3CODE_HOME")) { $psi.EnvironmentVariables.Remove("T3CODE_HOME") }
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $stdout = $p.StandardOutput.ReadToEnd()
  $stderr = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  return @{ ExitCode = $p.ExitCode; StdOut = $stdout; StdErr = $stderr }
}

# --- Stop T3 Turbo (the running backend holds the import lock for its lifetime).
$turboProcs = @()
if (-not $SkipAppStop) { $turboProcs = @(Get-Process "T3 Turbo" -ErrorAction SilentlyContinue) }
$wasRunning = $turboProcs.Count -gt 0
if ($wasRunning) {
  Write-Host "Stopping T3 Turbo ($($turboProcs.Count) processes)..."
  foreach ($proc in $turboProcs) { try { $proc.CloseMainWindow() | Out-Null } catch {} }
  Start-Sleep -Seconds 3
  foreach ($proc in @(Get-Process "T3 Turbo" -ErrorAction SilentlyContinue)) {
    try { $proc.Kill() } catch {}
  }
  Start-Sleep -Seconds 2
}

function Restart-Turbo {
  if ($wasRunning -and -not $NoRestart) {
    Write-Host "Restarting T3 Turbo..."
    Start-Process -FilePath $exePath | Out-Null
  }
}

try {
  # --- Plan (non-mutating).
  Write-Host "Planning import: $SourceBaseDir -> $TargetBaseDir"
  $planArgs = @("import", "official", "plan",
    "--source-base-dir", $SourceBaseDir,
    "--target-base-dir", $TargetBaseDir,
    "--out", $planPath, "--json")
  if ($ChoicesPath -ne "") { $planArgs += @("--choices", $ChoicesPath) }
  $plan = Invoke-Importer $planArgs
  if ($plan.ExitCode -ne 0 -or -not (Test-Path $planPath)) {
    Write-Host $plan.StdOut
    Write-Host $plan.StdErr
    throw "Plan failed with exit code $($plan.ExitCode)."
  }
  $planDoc = Get-Content $planPath -Raw | ConvertFrom-Json

  $actions = @{}
  foreach ($thread in $planDoc.plan.threads) {
    if ($actions.ContainsKey($thread.action)) { $actions[$thread.action] += 1 } else { $actions[$thread.action] = 1 }
  }
  Write-Host ""
  Write-Host "=== Import plan ==="
  Write-Host "Official projects: $($planDoc.plan.projects.Count)"
  Write-Host ("Official chats:    {0}  ({1})" -f $planDoc.plan.threads.Count, (($actions.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ", "))
  Write-Host ("Source activity:   sessions={0} turns={1} approvals={2}" -f $planDoc.workspace.sourceActivity.activeProviderSessions, $planDoc.workspace.sourceActivity.activeTurns, $planDoc.workspace.sourceActivity.pendingApprovals)
  Write-Host ("Target activity:   sessions={0} turns={1} approvals={2}" -f $planDoc.workspace.targetActivity.activeProviderSessions, $planDoc.workspace.targetActivity.activeTurns, $planDoc.workspace.targetActivity.pendingApprovals)
  Write-Host "Plan file:         $planPath"

  $needsChoice = @($planDoc.plan.threads | Where-Object { $_.action -eq "needs-choice" })
  if ($needsChoice.Count -gt 0 -and $ChoicesPath -eq "") {
    $template = Join-Path $workDir "choices-$stamp.json"
    $choiceMap = [ordered]@{}
    foreach ($thread in $needsChoice) { $choiceMap[$thread.sourceThreadId] = "clone" }
    ($choiceMap | ConvertTo-Json) | Out-File -FilePath $template -Encoding utf8
    Write-Host ""
    Write-Host "These chats exist in both databases with different history:"
    foreach ($thread in $needsChoice) { Write-Host "  $($thread.sourceThreadId)" }
    Write-Host "A choices template (every chat set to 'clone' = keep both) was written to:"
    Write-Host "  $template"
    Write-Host "Edit values to clone/replace/skip, then re-run with: -ChoicesPath `"$template`""
    return
  }

  if ($PlanOnly) {
    Write-Host ""
    Write-Host "-PlanOnly: no changes made."
    return
  }

  # --- Apply (backs up the Turbo database first; official DB is untouched).
  Write-Host ""
  Write-Host "Applying import..."
  $applyArgs = @("import", "official", "apply", "--plan", $planPath, "--out", $resultPath, "--json")
  if ($AllowActive) { $applyArgs += "--allow-active" }
  $apply = Invoke-Importer $applyArgs
  if ($apply.ExitCode -ne 0 -or -not (Test-Path $resultPath)) {
    Write-Host $apply.StdOut
    Write-Host $apply.StdErr
    if ($apply.StdOut -match "ActiveState") {
      Write-Host ""
      Write-Host "A database still records an active session or turn. If both apps are"
      Write-Host "really closed (e.g. official T3 Code was uninstalled), re-run with -AllowActive."
    }
    throw "Apply failed with exit code $($apply.ExitCode)."
  }
  $result = Get-Content $resultPath -Raw | ConvertFrom-Json
  Write-Host ""
  Write-Host "=== Import complete ==="
  Write-Host "Imported events:      $($result.importedEventCount)"
  Write-Host "Copied attachments:   $($result.copiedAttachmentCount)"
  Write-Host "Recovery receipt:     $($result.receiptPath)"
  Write-Host "To undo, close Turbo and run the importer's restore command with that receipt."
} finally {
  Restart-Turbo
}
