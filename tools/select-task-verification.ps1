[CmdletBinding()]
param(
    [string]$OutputPath = "tools/project-memory/verification-preferences.json",
    [string]$Selection = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$config = [pscustomobject]@{}
$enabled = $true
if (Test-Path -LiteralPath $OutputPath) {
    $config = Get-Content -LiteralPath $OutputPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $config -or $config -isnot [pscustomobject]) {
        throw "Verification preferences must be a JSON object: $OutputPath"
    }
    $review = $config.PSObject.Properties['task_completion_review']
    if ($review) {
        if ($null -eq $review.Value -or $review.Value -isnot [pscustomobject]) {
            throw "task_completion_review must be a JSON object."
        }
        $setting = $review.Value.PSObject.Properties['enabled']
        if ($setting) {
            if ($setting.Value -isnot [bool]) { throw "task_completion_review.enabled must be a JSON boolean." }
            $enabled = $setting.Value
        }
    }
}

Write-Host "Task completion review: $(if ($enabled) { 'On' } else { 'Off' })"
Write-Host "$(if ($enabled) { '[x]' } else { '[ ]' }) 1. Вкл / On"
Write-Host "$(if (-not $enabled) { '[x]' } else { '[ ]' }) 2. Выкл / Off"
Write-Host "[ ] 3. Отмена / Cancel"
if ([string]::IsNullOrWhiteSpace($Selection)) { $Selection = Read-Host "Selection" }

switch -Regex ($Selection.Trim().ToLowerInvariant()) {
    '^(3|отмена|cancel)$' { Write-Host "Cancelled; preferences unchanged."; return }
    '^(1|вкл|on)$' { $enabled = $true; break }
    '^(2|выкл|off)$' { $enabled = $false; break }
    default { throw "Choose exactly one option: 1/on, 2/off, or 3/cancel. Preferences unchanged." }
}

if (-not $config.PSObject.Properties['task_completion_review']) {
    $config | Add-Member -NotePropertyName task_completion_review -NotePropertyValue ([pscustomobject]@{})
}
$config.task_completion_review | Add-Member -NotePropertyName enabled -NotePropertyValue $enabled -Force
$directory = Split-Path -Parent $OutputPath
if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    [void](New-Item -ItemType Directory -Path $directory -Force)
}
$json = $config | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath), $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
$saved = Get-Content -LiteralPath $OutputPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($saved.task_completion_review.enabled -isnot [bool] -or $saved.task_completion_review.enabled -ne $enabled) {
    throw "Saved verification preference did not match the selected value."
}
Write-Host "Saved task completion review: $(if ($saved.task_completion_review.enabled) { 'On' } else { 'Off' })"
