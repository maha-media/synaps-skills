<#
.SYNOPSIS
  Install or prepare synaps-vm-agent inside a Windows guest.

.SECURITY
  - Generates token locally and never prints it unless -PrintToken is explicitly set.
  - Stores config/token under LocalAppData by default.
  - Restricts ACLs to current user and Administrators.
  - Default localhost bind creates no inbound firewall rule.
  - Non-local bind requires -AllowNonLocalBind and prints a firewall warning.
#>
[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [string]$InstallRoot = "$env:LOCALAPPDATA\SynapsVmAgent",
  [string]$HostAddress = "127.0.0.1",
  [int]$Port = 8765,
  [switch]$AllowNonLocalBind,
  [switch]$PrintToken,
  [switch]$SkipService
)

$ErrorActionPreference = "Stop"

if ($HostAddress -ne "127.0.0.1" -and -not $AllowNonLocalBind) {
  throw "Refusing non-local bind '$HostAddress' without -AllowNonLocalBind. Create firewall rules intentionally after reviewing exposure."
}

$ahk = Get-Command AutoHotkey64.exe, AutoHotkey.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $ahk) {
  Write-Warning "AutoHotkey v2 not found on PATH. Install AutoHotkey v2 before Windows UIA automation."
}

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
$configPath = Join-Path $InstallRoot "config.json"
$tokenPath = Join-Path $InstallRoot "token.txt"

$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = [Convert]::ToBase64String($bytes)
Set-Content -Path $tokenPath -Value $token -NoNewline -Encoding UTF8

$config = [ordered]@{
  host = $HostAddress
  port = $Port
  token = $token
  auth_required = $true
  allow_exec = $false
  max_plan_runtime_ms = 120000
  max_steps = 1000
  max_subprocess_runtime_ms = 30000
}
$config | ConvertTo-Json | Set-Content -Path $configPath -Encoding UTF8

# Restrict ACLs to current user and Administrators.
$acl = Get-Acl $InstallRoot
$acl.SetAccessRuleProtection($true, $false)
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$rules = @(
  New-Object System.Security.AccessControl.FileSystemAccessRule($current, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"),
  New-Object System.Security.AccessControl.FileSystemAccessRule("Administrators", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
)
foreach ($rule in $rules) { $acl.AddAccessRule($rule) }
Set-Acl -Path $InstallRoot -AclObject $acl

if ($HostAddress -eq "127.0.0.1") {
  Write-Host "No inbound firewall rule created for localhost-only bind."
} else {
  Write-Warning "Non-local bind selected. Create a narrowly scoped firewall rule intentionally, for example limiting host subnet/source."
}

if (-not $SkipService) {
  Write-Host "Service installation is environment-specific for interactive UI automation. Use a least-privileged user session/scheduled task where UI access is required."
  Write-Host "Example run command: python -m synaps_vm_agent.server --config `"$configPath`""
}

Write-Host "Config written to $configPath"
Write-Host "Token written to protected file $tokenPath"
Write-Host "Verify unauthenticated request fails: curl.exe -i http://127.0.0.1:$Port/capabilities"
Write-Host "Verify health locally: curl.exe http://127.0.0.1:$Port/health"
Write-Host "Rotate token: stop agent, generate a new token, update config.json and token.txt ACLs, restart agent."
if ($PrintToken) { Write-Host "TOKEN=$token" }
