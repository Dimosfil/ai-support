[CmdletBinding()]
param(
    [string]$CommandText = "",
    [ValidateSet('Work', 'Complete')][string]$Phase = 'Work',
    [switch]$MandatoryOnly,
    [switch]$SkipUpdateCheck,
    [ValidateRange(1, 500)][int]$MaxSummaryLines = 80,
    [ValidateRange(1, 500)][int]$MaxStartupFileLines = 80,
    [ValidateRange(1, 200)][int]$MaxRunbookHintLines = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$resolverPath = Join-Path $projectRoot "tools/resolve-gi-command.ps1"
$metadataPath = Join-Path $projectRoot "tools/project-memory/instruction-kit.json"
$budgetPath = Join-Path $projectRoot "config/gi-context-budgets.json"
$mandatoryRulesPath = Join-Path $projectRoot 'patterns/AGENTS_RUNTIME/03-rule-precedence.md'
$checkerCandidates = @(
    (Join-Path $projectRoot "tools/check-instruction-kit-updates.ps1"),
    (Join-Path $projectRoot "templates/check-instruction-kit-updates.template.ps1")
)

$requiredPaths = @($budgetPath, $mandatoryRulesPath)
if (-not $MandatoryOnly -and $Phase -eq 'Work' -and -not [string]::IsNullOrWhiteSpace($CommandText)) { $requiredPaths += $resolverPath }
foreach ($requiredPath in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required GI context file is missing: $requiredPath"
    }
}

$budgets = Get-Content -LiteralPath $budgetPath -Raw | ConvertFrom-Json
$sectionMaxChars = [int]$budgets.section_max_chars
$gitSnapshotMaxChars = [int]$budgets.git_snapshot_max_chars

function Convert-ItemsToText {
    param([AllowEmptyCollection()][object[]]$Items)
    return (@($Items | ForEach-Object { [string]$_ }) -join [Environment]::NewLine).TrimEnd()
}

function Limit-ContextText {
    param(
        [AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][int]$Maximum,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $Text = $Text.Replace("`r`n", "`n")
    if ($Text.Length -le $Maximum) { return $Text }
    $marker = "`n[context truncated: $Label; original_chars=$($Text.Length); max_chars=$Maximum]"
    $prefixLength = [Math]::Max(0, $Maximum - $marker.Length)
    return $Text.Substring(0, $prefixLength) + $marker
}

function New-ContextSection {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [AllowEmptyString()][string]$Body
    )
    return "===== $Title =====`n$Body".TrimEnd()
}

function Write-BoundedContextPacket {
    param([AllowEmptyString()][string]$Body, [string]$RouteId)

    $Body = $Body.Replace("`r`n", "`n").TrimEnd()
    $packetLimit = [int]$budgets.route_packet_default_max_chars
    $overrideProperty = $budgets.route_packet_overrides.PSObject.Properties[$RouteId]
    if ($overrideProperty) { $packetLimit = [int]$overrideProperty.Value }
    if ($RouteId -eq 'start') { $packetLimit = [int]$budgets.start_packet_max_chars }
    $payloadLimit = [Math]::Max(0, $packetLimit - 1)
    $bodyLimit = $payloadLimit - $mandatoryPrefix.Length
    if ($bodyLimit -lt 0) { throw 'Context budget cannot fit mandatory task rules; no partial packet emitted.' }
    if ($Body.Length -gt $bodyLimit) {
        $tail = "`n[context packet truncated: route=$RouteId; original_chars=$($mandatoryPrefix.Length + $Body.Length); max_chars=$packetLimit]"
        if ($RouteId -eq 'start') { $tail += "`nStartup restore complete. Use targeted searches before reading large files." }
        if ($bodyLimit -lt $tail.Length) { throw 'Context budget cannot fit mandatory task rules and truncation notice; no partial packet emitted.' }
        $Body = $Body.Substring(0, $bodyLimit - $tail.Length) + $tail
    }
    Write-Output ($mandatoryPrefix + $Body)
}

function Get-BoundedFileSection {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][int]$LineLimit
    )

    $fullPath = Join-Path $projectRoot $RelativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { return $null }
    $lines = @(Get-Content -LiteralPath $fullPath -TotalCount $LineLimit)
    $lineCount = (Get-Content -LiteralPath $fullPath | Measure-Object -Line).Lines
    $body = Convert-ItemsToText -Items $lines
    if ($lineCount -gt $LineLimit) {
        $body = "$RelativePath has $lineCount lines; showing first $LineLimit lines only.`n$body"
    }
    $body = Limit-ContextText -Text $body -Maximum $sectionMaxChars -Label $RelativePath
    return New-ContextSection -Title $Title -Body $body
}

function Get-GitCommitPreferencesSection {
    $relativePath = "tools/project-memory/git-preferences.json"
    $fullPath = Join-Path $projectRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        return New-ContextSection -Title "GIT COMMIT PREFERENCES" -Body "No git commit language preferences found.`nDefault: English; configure with tools/select-git-commit-languages.ps1"
    }
    try {
        $preferences = Get-Content -LiteralPath $fullPath -Raw | ConvertFrom-Json
        $primary = [string]$preferences.commit_message_languages.primary
        $additional = @($preferences.commit_message_languages.additional | ForEach-Object { [string]$_ })
        if (-not $primary) { $primary = "English" }
        $additionalText = if ($additional.Count) { $additional -join ", " } else { "none" }
        return New-ContextSection -Title "GIT COMMIT PREFERENCES" -Body "Primary: $primary`nAdditional: $additionalText`nChange with: tools/select-git-commit-languages.ps1"
    }
    catch {
        return New-ContextSection -Title "GIT COMMIT PREFERENCES" -Body "Could not read $relativePath; reconfigure with tools/select-git-commit-languages.ps1"
    }
}

function Get-SystemLanguagePreferencesSection {
    $relativePath = "tools/project-memory/system-preferences.json"
    $fullPath = Join-Path $projectRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        return New-ContextSection -Title "AGENT SYSTEM LANGUAGE" -Body "Agent working language: match the user's language`nConfigure with: tools/select-system-language.ps1"
    }
    try {
        $preferences = Get-Content -LiteralPath $fullPath -Raw | ConvertFrom-Json
        $response = $preferences.agent_response_language
        $mode = [string]$response.mode
        $language = [string]$response.language
        $languages = @($response.project_environment_languages | ForEach-Object { [string]$_ })
        if ($languages.Count -eq 0) { $languages = @($response.languages | ForEach-Object { [string]$_ }) }
        $taskLanguages = @($response.task_languages | ForEach-Object { [string]$_ })
        $lines = [System.Collections.Generic.List[string]]::new()
        if ($mode -eq "fixed" -and $languages.Count -gt 0) {
            $lines.Add("Project working environment: $($languages -join ', ')")
            if ($taskLanguages.Count -gt 0) { $lines.Add("Tasks: $($taskLanguages -join ', ')") }
        }
        elseif ($mode -eq "fixed" -and $language) { $lines.Add("Agent working language: $language") }
        else { $lines.Add("Agent working language: match the user's language") }
        $lines.Add("Change with: tools/select-system-language.ps1")
        return New-ContextSection -Title "AGENT SYSTEM LANGUAGE" -Body (Convert-ItemsToText -Items $lines)
    }
    catch {
        return New-ContextSection -Title "AGENT SYSTEM LANGUAGE" -Body "Could not read $relativePath; reconfigure with tools/select-system-language.ps1"
    }
}

function Get-TaskVerificationPreferencesSection {
    $relativePath = 'tools/project-memory/verification-preferences.json'
    $fullPath = Join-Path $projectRoot $relativePath
    $enabled = $true
    try {
        if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            $preferences = Get-Content -LiteralPath $fullPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -eq $preferences -or $preferences -isnot [pscustomobject]) { throw 'Expected a JSON object.' }
            $review = $preferences.PSObject.Properties['task_completion_review']
            if ($review) {
                if ($null -eq $review.Value -or $review.Value -isnot [pscustomobject]) { throw 'Expected a review object.' }
                $setting = $review.Value.PSObject.Properties['enabled']
                if ($setting) {
                    if ($setting.Value -isnot [bool]) { throw 'Expected a JSON boolean.' }
                    $enabled = $setting.Value
                }
            }
        }
        $state = if ($enabled) { 'On' } else { 'Off' }
        $body = "Task completion review: $state`nApply only after task execution, before the final response; follow patterns/AGENTS_RUNTIME/15-final-review.md. Required project checks remain mandatory.`nConfigure with: gi verification / ги проверка"
    }
    catch {
        $body = "Invalid verification preferences at $relativePath; report the configuration gap and do not overwrite it. Required checks and truthful reporting remain mandatory."
    }
    return New-ContextSection -Title 'TASK COMPLETION REVIEW' -Body $body
}

$mandatoryRules = [System.IO.File]::ReadAllText($mandatoryRulesPath).Replace("`r`n", "`n").TrimEnd()
foreach ($heading in @('## Simplicity And Material Complexity', '## Whole-Task Completion Gate')) {
    if (-not $mandatoryRules.Contains($heading)) { throw "Mandatory task rules section missing: $heading" }
}
$mandatoryPrefix = (New-ContextSection -Title "MANDATORY TASK RULES ($Phase)" -Body $mandatoryRules) + "`n`n"
if ($MandatoryOnly) {
    Write-BoundedContextPacket -RouteId 'work' -Body ''
    exit 0
}
if ($Phase -eq 'Complete') {
    Write-BoundedContextPacket -RouteId 'complete' -Body 'Apply the loaded whole-task gate to the actual result before the final response. Report remaining gaps explicitly.'
    exit 0
}

$routeId = 'work'
if (-not [string]::IsNullOrWhiteSpace($CommandText)) {
    $routeHeaderItems = @(& $resolverPath -CommandText $CommandText -PathsOnly *>&1)
    if ($LASTEXITCODE -ne 0) { throw (Convert-ItemsToText -Items $routeHeaderItems) }
    $routeHeader = Convert-ItemsToText -Items $routeHeaderItems
    $routeMatch = [regex]::Match($routeHeader, '(?m)^GI route:\s*(?<id>[^\r\n]+)')
    if (-not $routeMatch.Success) { throw "GI resolver did not return a route id." }
    $routeId = $routeMatch.Groups['id'].Value.Trim()
}
$parts = [System.Collections.Generic.List[string]]::new()

$updateBody = if ($SkipUpdateCheck) {
    "Instruction update check: skipped by caller"
}
elseif (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
    "Instruction update check: metadata missing at tools/project-memory/instruction-kit.json"
}
else {
    # The checker owns policy defaults, validation, evidence, and next action.
    # Do not duplicate its decision here or discard the application directive.
    & {
        $checkerPath = $checkerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
        if (-not $checkerPath) { throw "Instruction update checker is missing." }
        Push-Location $projectRoot
        try {
            $checkerItems = @(& $checkerPath -InstructionKitPath $metadataPath *>&1)
            $checkerExitCode = $LASTEXITCODE
        }
        finally { Pop-Location }
        $checkerText = Convert-ItemsToText -Items $checkerItems
        if ($checkerExitCode -ne 0) { throw "Instruction update check failed.`n$checkerText" }
        $checkerText
    }
}
$parts.Add((New-ContextSection -Title "GI UPDATE STATUS" -Body $updateBody))
$parts.Add((Get-TaskVerificationPreferencesSection))

# Host setup is separate from the zero-pending migration fast path. A copied
# Unity project on a new host still needs the client configured once.
if ($routeId -in @('start', 'update') -and
    (Test-Path -LiteralPath (Join-Path $projectRoot 'Assets') -PathType Container) -and
    (Test-Path -LiteralPath (Join-Path $projectRoot 'ProjectSettings/ProjectVersion.txt') -PathType Leaf)) {
    $unitySetup = Join-Path $projectRoot 'tools/ensure-unity-mcp.ps1'
    if (-not (Test-Path -LiteralPath $unitySetup -PathType Leaf)) { throw 'Unity MCP setup helper is missing: tools/ensure-unity-mcp.ps1' }
    $unityStatus = & $unitySetup -ProjectPath $projectRoot
    $parts.Add((New-ContextSection -Title 'UNITY MCP SETUP' -Body ($unityStatus | ConvertTo-Json -Depth 8 -Compress)))
}

if (-not [string]::IsNullOrWhiteSpace($CommandText)) {
    $routeItems = @(& $resolverPath -CommandText $CommandText *>&1)
    if ($LASTEXITCODE -ne 0) { throw (Convert-ItemsToText -Items $routeItems) }
    $parts.Add((New-ContextSection -Title "GI ROUTE PACKET" -Body (Convert-ItemsToText -Items $routeItems)))
}

if ($routeId -eq "start") {
    foreach ($section in @(
        (Get-BoundedFileSection -RelativePath "AGENTS.md" -Title "PROJECT ENTRYPOINT" -LineLimit $MaxStartupFileLines),
        (Get-BoundedFileSection -RelativePath "tools/AGENT_WORKING_AGREEMENTS.md" -Title "WORKING AGREEMENTS" -LineLimit $MaxStartupFileLines),
        (Get-GitCommitPreferencesSection),
        (Get-SystemLanguagePreferencesSection)
    )) { if ($section) { $parts.Add($section) } }

    $summaryDirectory = Join-Path $projectRoot "tools/summary"
    $latestSummary = if (Test-Path -LiteralPath $summaryDirectory -PathType Container) {
        Get-ChildItem -LiteralPath $summaryDirectory -File -Filter "*_AGENT_WORK_SUMMARY.md" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    } else { $null }
    if ($latestSummary) {
        $summaryText = Convert-ItemsToText -Items @(Get-Content -LiteralPath $latestSummary.FullName -TotalCount $MaxSummaryLines)
        $summaryText = Limit-ContextText -Text $summaryText -Maximum $sectionMaxChars -Label ("tools/summary/" + $latestSummary.Name)
        $parts.Add((New-ContextSection -Title "LATEST HANDOFF SUMMARY" -Body "Summary file: tools/summary/$($latestSummary.Name)`n$summaryText"))
    }
    else { $parts.Add((New-ContextSection -Title "LATEST HANDOFF SUMMARY" -Body "No handoff summary found.")) }

    if (Test-Path -LiteralPath (Join-Path $projectRoot ".git")) {
        $statusItems = @(git -C $projectRoot status --short --branch 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "Git status failed: $(Convert-ItemsToText -Items $statusItems)" }
        $diffItems = @(git -C $projectRoot diff --stat 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "Git diff stat failed: $(Convert-ItemsToText -Items $diffItems)" }
        $gitText = Convert-ItemsToText -Items @($statusItems + $diffItems)
        $gitText = Limit-ContextText -Text $gitText -Maximum $gitSnapshotMaxChars -Label "git snapshot"
        $parts.Add((New-ContextSection -Title "GIT SNAPSHOT" -Body $gitText))
    }
    else { $parts.Add((New-ContextSection -Title "GIT SNAPSHOT" -Body "No Git worktree found at the project root.")) }

    $runbookPath = Join-Path $projectRoot "tools/AGENT_RUNBOOK.md"
    if (Test-Path -LiteralPath $runbookPath -PathType Leaf) {
        $hints = @(Select-String -Path $runbookPath -Pattern "```|Install|Run|Test|Build|Smoke|Logs|powershell|npm|pnpm|yarn|dotnet|pytest|cargo|go test" -CaseSensitive:$false | Select-Object -First $MaxRunbookHintLines | ForEach-Object { $_.Line })
        $hintText = Limit-ContextText -Text (Convert-ItemsToText -Items $hints) -Maximum $sectionMaxChars -Label "runbook hints"
        $parts.Add((New-ContextSection -Title "RUNBOOK COMMAND HINTS" -Body $hintText))
    }

    if (Test-Path -LiteralPath (Join-Path $projectRoot "tools/project-memory/index_project.py") -PathType Leaf) {
        $parts.Add((New-ContextSection -Title "PROJECT MEMORY" -Body ("Search memory with:`n" + 'python .\tools\project-memory\index_project.py search "query" --limit 10')))
    }
    $parts.Add("Startup restore complete. Use targeted searches before reading large files.")
}

Write-BoundedContextPacket -RouteId $routeId -Body ($parts -join "`n`n")
