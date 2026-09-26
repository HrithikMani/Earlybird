# Earlybird setup for Windows. Makes sure Node 22+ exists, then runs `npm run setup`.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Get-NodeMajor {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return 0 }
  return [int](& node -p "process.versions.node.split('.')[0]")
}

if ((Get-NodeMajor) -lt 22) {
  Write-Host 'Node.js 22+ is required.'
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    $ans = Read-Host 'Install Node.js 22 LTS with winget now? [Y/n]'
    if ($ans -ne 'n' -and $ans -ne 'N') {
      winget install --id OpenJS.NodeJS.22 -e --accept-package-agreements --accept-source-agreements
      # Pick up the new PATH in this session.
      $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
    }
  }
  if ((Get-NodeMajor) -lt 22) {
    Write-Host 'Please install Node.js 22 LTS from https://nodejs.org and re-run .\setup.ps1'
    exit 1
  }
}

Write-Host "Using Node $(node -v)"
npm run setup -- @args
exit $LASTEXITCODE
