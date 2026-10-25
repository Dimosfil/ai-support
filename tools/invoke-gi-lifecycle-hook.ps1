[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

function Get-Digest {
    param([string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Invoke-GitRead {
    param([string[]]$Arguments)
    $text = (& git -C $root -c core.safecrlf=false @Arguments 2>$null | Out-String).Replace("`r`n", "`n")
    if ($LASTEXITCODE -ne 0) { throw 'Automatic Git verification failed; inspect the project locally.' }
    return $text
}

function Get-WorkFingerprint {
    $insideGit = & git -C $root rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -ne 0) { return 'no-git' }
    # Hash changes without copying source, prompts, or tool output into the audit.
    $parts = [System.Collections.Generic.List[string]]::new()
    # HEAD may not exist yet in a freshly installed project.
    $head = & git -C $root rev-parse --verify HEAD 2>$null
    $parts.Add($(if ($LASTEXITCODE -eq 0) { [string]$head } else { 'unborn' }))
    $parts.Add((Invoke-GitRead -Arguments @('diff', '--no-ext-diff', '--binary')))
    $parts.Add((Invoke-GitRead -Arguments @('diff', '--cached', '--no-ext-diff', '--binary')))
    $untracked = Invoke-GitRead -Arguments @('ls-files', '--others', '--exclude-standard', '-z')
    foreach ($relative in ($untracked.TrimEnd("`n") -split "`0")) {
        if (-not $relative) { continue }
        if ($relative.Replace('\', '/') -match '^\.(codex|opencode)/\.gi-hook-state/') { continue }
        $path = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
        if (-not $path.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Untracked file escaped the project root.' }
        $item = Get-Item -LiteralPath $path -Force
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $parts.Add($relative + ':link'); continue }
        $parts.Add($relative + ':' + (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash)
    }
    return Get-Digest ($parts -join "`n")
}

function Write-Audit {
    param([string]$Outcome, [bool]$ChecksPassed, [int]$ReviewCount, [string]$ServiceTool = '', [string]$Delivery = '')
    $entry = [ordered]@{
        time_utc = [DateTime]::UtcNow.ToString('o'); event = $eventName
        session = $sessionKey; turn = $turnId; outcome = $Outcome
        checks_passed = $ChecksPassed; review_count = $ReviewCount
    }
    if ($ServiceTool) { $entry['service_tool'] = $ServiceTool; $entry['delivery'] = $Delivery }
    [System.IO.File]::AppendAllText((Join-Path $stateRoot 'events.jsonl'), (($entry | ConvertTo-Json -Compress) + "`n"), $utf8)
}

try {
    $event = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $hostProperty = $event.PSObject.Properties['host']
    $hookHost = if ($hostProperty) { [string]$hostProperty.Value } else { 'codex' }
    if ($hookHost -notin @('codex', 'opencode')) { throw 'Unsupported GI hook host.' }
    $eventName = [string]$event.hook_event_name
    if ($eventName -notin @('UserPromptSubmit', 'SessionStart', 'PreToolUse', 'Stop')) { throw 'Unsupported GI hook event.' }
    if ($eventName -eq 'PreToolUse') {
        $isServiceTool = [string]$event.tool_name -match '^(?:mcp__codex_app__|codex_app[./])?(?:create_thread|send_message_to_thread)$'
        if ($hookHost -eq 'opencode') { $isServiceTool = [string]$event.tool_name -eq 'task' }
        if (-not $isServiceTool) { '{}'; exit 0 }
    }
    if ([string]::IsNullOrWhiteSpace([string]$event.session_id)) { throw 'Missing hook session identity.' }
    $cwd = [System.IO.Path]::GetFullPath([string]$event.cwd)
    if ($cwd -ne $root -and -not $cwd.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Hook cwd does not belong to this project.' }
    $turnProperty = $event.PSObject.Properties['turn_id']
    $turnId = if ($turnProperty) { [string]$turnProperty.Value } else { '' }
    $sessionKey = Get-Digest ([string]$event.session_id)
    $stateRoot = Join-Path $root ('.' + $hookHost + '/.gi-hook-state')
    [void][System.IO.Directory]::CreateDirectory($stateRoot)
    $receiptPath = Join-Path $stateRoot ($sessionKey + '.json')
    $phase = if ($eventName -eq 'Stop') { 'Complete' } else { 'Work' }
    $context = (& (Join-Path $root 'tools/get-gi-context.ps1') -Phase $phase -MandatoryOnly:($eventName -eq 'PreToolUse') -SkipUpdateCheck | Out-String).Replace("`r`n", "`n").TrimEnd()
    $budgets = [System.IO.File]::ReadAllText((Join-Path $root 'config/gi-context-budgets.json')) | ConvertFrom-Json
    if ($context.Length -gt [int]$budgets.section_max_chars) { throw 'Mandatory hook context exceeds the existing section cap.' }

    if ($eventName -eq 'PreToolUse') {
        $inputObject = $event.tool_input
        if ($inputObject.prompt -isnot [string] -or [string]::IsNullOrWhiteSpace($inputObject.prompt)) { throw 'Service message requires a nonempty prompt.' }
        # Preserve the original task and every routing/authorization field.
        # Only an identical generated prefix is reused; never strip user text.
        $prefix = "[GI automatic service context]`n$context`n[End GI automatic service context]`n`n"
        if ($prefix.Length -gt [int]$budgets.section_max_chars) { throw 'Service context exceeds the existing section cap.' }
        $delivery = if ($inputObject.prompt.StartsWith($prefix, [StringComparison]::Ordinal)) { 'reused' } else { 'added' }
        if ($delivery -eq 'added') { $inputObject.prompt = $prefix + $inputObject.prompt }
        Write-Audit -Outcome 'service_rules_forwarded' -ChecksPassed $true -ReviewCount 0 -ServiceTool ([string]$event.tool_name) -Delivery $delivery
        @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'allow'; updatedInput = $inputObject } } | ConvertTo-Json -Depth 100 -Compress
        exit 0
    }

    if ($eventName -ne 'Stop') {
        Write-Audit -Outcome 'rules_injected' -ChecksPassed $true -ReviewCount 0
        @{ hookSpecificOutput = @{ hookEventName = $eventName; additionalContext = $context } } | ConvertTo-Json -Depth 5 -Compress
        exit 0
    }

    $checksPassed = $true
    $insideGit = & git -C $root rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -eq 0) {
        & git -C $root -c core.safecrlf=false diff --check 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { $checksPassed = $false }
        & git -C $root -c core.safecrlf=false diff --cached --check 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { $checksPassed = $false }
    }
    $fingerprint = Get-Digest ($context + "`n" + (Get-WorkFingerprint))
    $receipt = if (Test-Path -LiteralPath $receiptPath) { [System.IO.File]::ReadAllText($receiptPath) | ConvertFrom-Json } else { $null }
    $continuedProperty = $event.PSObject.Properties['stop_hook_active']
    $continued = $continuedProperty -and $continuedProperty.Value -eq $true
    if ($continued -and $receipt -and $receipt.fingerprint -eq $fingerprint -and $checksPassed) {
        Write-Audit -Outcome 'completion_allowed' -ChecksPassed $true -ReviewCount ([int]$receipt.review_count)
        '{}'
        exit 0
    }
    $reviewCount = if ($continued -and $receipt) { [int]$receipt.review_count + 1 } else { 1 }
    if ($reviewCount -gt 3) {
        Write-Audit -Outcome 'completion_stopped' -ChecksPassed $checksPassed -ReviewCount $reviewCount
        @{ continue = $false; stopReason = 'GI automatic completion verification did not settle; task remains unverified.'; systemMessage = 'GI: completion verification stopped after repeated changes or failed checks. Do not treat this as verified completion.' } | ConvertTo-Json -Compress
        exit 0
    }
    @{ fingerprint = $fingerprint; review_count = $reviewCount; turn = $turnId } | ConvertTo-Json -Compress |
        ForEach-Object { [System.IO.File]::WriteAllText($receiptPath, $_, $utf8) }
    Write-Audit -Outcome 'completion_review_required' -ChecksPassed $checksPassed -ReviewCount $reviewCount
    $checkMessage = if ($checksPassed) { 'Automatic whitespace checks passed.' } else { 'Automatic whitespace checks failed. Inspect git diff --check and git diff --cached --check; fix only authorized task changes or report the blocker.' }
    # Work/compaction hooks already deliver the mandatory rules as context.
    # Stop.reason becomes a visible user continuation in Codex: keep it short.
    # Still load and fingerprint the full current Complete context above.
    $reason = "[GI automatic final review] $checkMessage Review the whole task under the loaded GI rules (current source: patterns/AGENTS_RUNTIME/03-rule-precedence.md; reread if needed). Report gaps, preserve unrelated work, and return the reviewed task answer without repeating this reminder."
    if ($reason.Length -gt [int]$budgets.section_max_chars) { throw 'Automatic review exceeds the existing section cap.' }
    @{ decision = 'block'; reason = $reason } | ConvertTo-Json -Compress
} catch {
    if ((Get-Variable -Name eventName -ErrorAction SilentlyContinue) -and $eventName -eq 'PreToolUse') {
        # PreToolUse does not support continue:false; explicitly deny forwarding.
        @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = 'GI mandatory service context is unavailable; message was not forwarded.' } } | ConvertTo-Json -Compress
        exit 0
    }
    # Hook failures must be visible; never print a successful completion receipt.
    @{ continue = $false; stopReason = 'GI mandatory lifecycle verification failed.'; systemMessage = 'GI hook failed: mandatory context or local verification is unavailable. Task completion remains unverified.' } | ConvertTo-Json -Compress
    exit 0
}
