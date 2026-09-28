# Builds podium-deploy.zip (next to the podium folder) for uploading to the
# Hostinger server — see docs/deploy-hostinger.md, step 3 option B.
#
# Includes every project file except what .gitignore excludes: no
# node_modules, build output, .env secrets or uploaded documents. Works
# whether or not the changes are committed.
#
# Usage (PowerShell, from the podium folder):
#   powershell -ExecutionPolicy Bypass -File scripts\make-deploy-zip.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$list = Join-Path $env:TEMP "podium-deploy-files.txt"
$zip = Join-Path (Split-Path -Parent $root) "podium-deploy.zip"

git ls-files --cached --others --exclude-standard | Set-Content -Encoding ascii $list
if (Test-Path $zip) { Remove-Item $zip -Confirm:$false }
& "$env:SystemRoot\System32\tar.exe" -a -c -f $zip -T $list
if ($LASTEXITCODE -ne 0) { throw "tar failed ($LASTEXITCODE)" }
Remove-Item $list -Confirm:$false

$size = [math]::Round((Get-Item $zip).Length / 1MB, 2)
Write-Host "Created $zip ($size MB)"
