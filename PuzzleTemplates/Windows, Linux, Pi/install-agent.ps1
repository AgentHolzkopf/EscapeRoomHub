param(
    [string]$HubHost = "",
    [string]$PuzzleName = "",
    [int]$Port = 5001,
    [switch]$InstallNode,
    [switch]$Start
)

$ErrorActionPreference = "Stop"

function Write-Step($message) {
    Write-Host ""
    Write-Host "==> $message" -ForegroundColor Cyan
}

function Require-Command($name, $installHint) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "$name was not found. $installHint"
    }
    return $cmd
}

function Read-Default($prompt, $defaultValue) {
    if ([string]::IsNullOrWhiteSpace($defaultValue)) {
        $value = Read-Host $prompt
    } else {
        $value = Read-Host "$prompt [$defaultValue]"
        if ([string]::IsNullOrWhiteSpace($value)) {
            $value = $defaultValue
        }
    }
    return $value
}

function Write-Utf8NoBom($path, $content) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $content, $encoding)
}

function Is-TemplateHubDefault($value) {
    $safe = ([string]$value).Trim().ToLowerInvariant()
    return [string]::IsNullOrWhiteSpace($safe) -or $safe -eq "escapehub.local"
}

function Is-TemplatePuzzleNameDefault($value) {
    $safe = ([string]$value).Trim()
    return [string]::IsNullOrWhiteSpace($safe) -or $safe -eq "TestPuzzle"
}

function Ensure-NodeJs {
    $node = Get-Command "node" -ErrorAction SilentlyContinue
    $npm = Get-Command "npm" -ErrorAction SilentlyContinue
    if ($node -and $npm) {
        return
    }

    $winget = Get-Command "winget" -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw "Node.js was not found and winget is not available. Install Node.js LTS from https://nodejs.org, reopen PowerShell, then run this installer again."
    }

    $shouldInstall = $InstallNode
    if (-not $shouldInstall) {
        $answer = Read-Host "Node.js was not found. Install Node.js LTS now using winget? (y/N)"
        $shouldInstall = $answer -match "^(y|yes|j|ja)$"
    }

    if (-not $shouldInstall) {
        throw "Node.js is required. Install Node.js LTS from https://nodejs.org or rerun with -InstallNode."
    }

    Write-Step "Installing Node.js LTS with winget"
    winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "winget failed to install Node.js LTS. Install Node.js manually from https://nodejs.org and run this installer again."
    }

    Write-Host ""
    Write-Host "Node.js installation finished." -ForegroundColor Green
    Write-Host "Close this PowerShell window, open a new one, and run this installer again."
    Write-Host "Reason: Windows updates PATH only for new terminal sessions."
    exit 0
}

function New-StableAgentId($name) {
    $base = ([string]$name).ToLowerInvariant() -replace "[^a-z0-9]+", "-"
    $base = $base.Trim("-")
    if ([string]::IsNullOrWhiteSpace($base)) {
        $base = "agent"
    }
    $suffix = [System.Guid]::NewGuid().ToString("N").Substring(0, 6)
    return "$base-$suffix"
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Step "Checking Node.js"
Ensure-NodeJs
Require-Command "node" "Install Node.js LTS from https://nodejs.org and run this installer again." | Out-Null
Require-Command "npm" "Install Node.js LTS from https://nodejs.org and run this installer again." | Out-Null
Write-Host "Node: $(node -v)"
Write-Host "npm : $(npm -v)"

$configPath = Join-Path $ScriptDir "CommunikationAgent.config.json"
$config = $null
if (Test-Path $configPath) {
    try {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
    } catch {
        throw "CommunikationAgent.config.json is not valid JSON. Fix it or delete it and run this installer again. $($_.Exception.Message)"
    }
}
if (-not $config) {
    $config = [pscustomobject]@{}
}

Write-Step "Configuring Communication Agent"
if ([string]::IsNullOrWhiteSpace($HubHost)) {
    $existingHubHost = $config.hubHost -as [string]
    $HubHost = if (Is-TemplateHubDefault $existingHubHost) {
        Read-Default "Hub IP/hostname" ""
    } else {
        Read-Default "Hub IP/hostname" $existingHubHost
    }
}
if ([string]::IsNullOrWhiteSpace($PuzzleName)) {
    $existingPuzzleName = $config.puzzleName -as [string]
    $PuzzleName = if (Is-TemplatePuzzleNameDefault $existingPuzzleName) {
        Read-Default "Puzzle name" ""
    } else {
        Read-Default "Puzzle name" $existingPuzzleName
    }
}

if (Is-TemplateHubDefault $HubHost) {
    throw "HubHost is required. Enter the real hub IP address or hostname, for example 192.168.101.96."
}
if ([string]::IsNullOrWhiteSpace($PuzzleName)) {
    $PuzzleName = "Puzzle"
}

$agentIdPath = Join-Path $ScriptDir ".agent-device-id"
$AgentId = ""
if (Test-Path $agentIdPath) {
    $AgentId = (Get-Content $agentIdPath -Raw).Trim()
}
if ([string]::IsNullOrWhiteSpace($AgentId)) {
    $AgentId = New-StableAgentId $PuzzleName
    Write-Host "Generated stable agent ID: $AgentId"
}
Set-Content -Path $agentIdPath -Value $AgentId -Encoding ASCII

$nextConfig = [ordered]@{
    hubHost = $HubHost
    mqttBroker = $HubHost
    mqttPort = 1883
    puzzleName = $PuzzleName
    heartbeatIntervalMs = if ($config.heartbeatIntervalMs) { [int]$config.heartbeatIntervalMs } else { 2000 }
    debug = if ($null -ne $config.debug) { [bool]$config.debug } else { $false }
    mediaServer = if ($HubHost -match "^https?://") { $HubHost } else { "http://$HubHost" }
    mediaLocalDir = if ($config.mediaLocalDir) { [string]$config.mediaLocalDir } else { "MediaStorage" }
    printData = if ($null -ne $config.printData) { [bool]$config.printData } else { $true }
    needRestart = if ($null -ne $config.needRestart) { [bool]$config.needRestart } else { $false }
}

Write-Utf8NoBom $configPath ($nextConfig | ConvertTo-Json -Depth 8)
Write-Host "Wrote $configPath"
Write-Host "HubHost : $HubHost"
Write-Host "MQTT    : $HubHost`:1883"
Write-Host "Puzzle  : $PuzzleName"
Write-Host "Agent ID: $AgentId"

$mediaDir = Join-Path $ScriptDir $nextConfig.mediaLocalDir
if (-not (Test-Path $mediaDir)) {
    New-Item -ItemType Directory -Path $mediaDir | Out-Null
}

Write-Step "Installing npm dependency"
if (-not (Test-Path (Join-Path $ScriptDir "package.json"))) {
    $packageJson = [ordered]@{
        private = $true
        scripts = [ordered]@{
            start = "node CommunikationAgent.js --port $Port"
        }
        dependencies = [ordered]@{
            mqtt = "^5.10.4"
        }
    }
    Write-Utf8NoBom (Join-Path $ScriptDir "package.json") ($packageJson | ConvertTo-Json -Depth 8)
}
npm install

Write-Step "Validating startup"
node --check .\CommunikationAgent.js

Write-Host ""
Write-Host "Installation complete." -ForegroundColor Green
Write-Host "Start manually with:"
Write-Host "  cd `"$ScriptDir`""
Write-Host "  node CommunikationAgent.js --port $Port"
Write-Host ""
Write-Host "Agent URL:"
Write-Host "  http://127.0.0.1:$Port"
Write-Host ""
Write-Host "Hub MQTT target:"
Write-Host "  $HubHost`:1883"

if ($Start) {
    Write-Step "Starting agent"
    node .\CommunikationAgent.js --port $Port
}
