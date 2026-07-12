$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$deploy = Join-Path $root "lambda-deploy"
$zipPath = Join-Path $root "function.zip"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string] $FilePath,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $CommandArgs
  )

  & $FilePath @CommandArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($CommandArgs -join ' ')"
  }
}

Set-Location $root

Write-Host "Building backend..."
Invoke-Checked npm.cmd run build

Write-Host "Preparing clean deployment folder..."
Remove-Item -LiteralPath $deploy -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $deploy | Out-Null

Copy-Item -LiteralPath (Join-Path $root "dist") -Destination (Join-Path $deploy "dist") -Recurse
Copy-Item -LiteralPath (Join-Path $root "package.json") -Destination (Join-Path $deploy "package.json")
Copy-Item -LiteralPath (Join-Path $root "package-lock.json") -Destination (Join-Path $deploy "package-lock.json")

$prismaSource = Join-Path $root "prisma"
if (Test-Path $prismaSource) {
  Copy-Item -LiteralPath $prismaSource -Destination (Join-Path $deploy "prisma") -Recurse
}

$templatesSource = Join-Path $root "templates"
if (Test-Path $templatesSource) {
  Copy-Item -LiteralPath $templatesSource -Destination (Join-Path $deploy "templates") -Recurse
}

Push-Location $deploy
try {
  $npmCache = Join-Path $deploy ".npm-cache"
  $env:npm_config_cache = $npmCache

  Write-Host "Installing production dependencies..."
  Invoke-Checked npm.cmd ci --omit=dev --ignore-scripts --cache $npmCache

  Write-Host "Generating Prisma client with Lambda binary target..."
  $packageJson = Get-Content -Raw -LiteralPath (Join-Path $deploy "package.json") | ConvertFrom-Json
  $prismaClientVersion = $packageJson.dependencies."@prisma/client"
  if (-not $prismaClientVersion) {
    throw "@prisma/client must be listed in dependencies."
  }
  $prismaCliVersion = $prismaClientVersion -replace "^[\^~]", ""

  Invoke-Checked npm.cmd install "prisma@$prismaCliVersion" --no-save --omit=dev --ignore-scripts --cache $npmCache
  Invoke-Checked npx.cmd prisma generate
  Invoke-Checked npm.cmd prune --omit=dev --ignore-scripts --cache $npmCache

  $engine = Get-ChildItem -Path ".\node_modules\.prisma\client" -Filter "*.node" -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*rhel-openssl-3.0.x*" } |
    Select-Object -First 1

  if (-not $engine) {
    throw "Missing Prisma rhel-openssl-3.0.x query engine. Check prisma/schema.prisma binaryTargets."
  }

  Get-ChildItem -Path ".\node_modules\.prisma\client" -Filter "*.node" -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike "*rhel-openssl-3.0.x*" } |
    Remove-Item -Force -ErrorAction SilentlyContinue

  Write-Host "Removing build-time Prisma tooling..."
  @(
    ".\node_modules\prisma",
    ".\node_modules\typescript",
    ".\node_modules\@prisma\engines",
    ".\node_modules\@prisma\fetch-engine",
    ".\node_modules\@prisma\get-platform"
  ) | ForEach-Object {
    Remove-Item -LiteralPath $_ -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Host "Removing unnecessary files..."
  Remove-Item -LiteralPath $npmCache -Recurse -Force -ErrorAction SilentlyContinue

  Get-ChildItem -Path . -Recurse -Directory |
    Where-Object { $_.Name -in @("test", "tests", "__tests__", "docs", "example", "examples", ".cache", ".npm-cache") } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  Get-ChildItem -Path . -Recurse -File -Include *.map,*.md |
    Remove-Item -Force -ErrorAction SilentlyContinue

  $size = (Get-ChildItem . -Recurse -File | Measure-Object Length -Sum).Sum
  $sizeMb = [math]::Round($size / 1MB, 2)
  Write-Host "$sizeMb MB uncompressed"

  if ($size -gt 250MB) {
    throw "Deployment package is above Lambda's 250 MB uncompressed limit."
  }

  Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  Write-Host "Creating function.zip..."
  Invoke-Checked tar -a -cf $zipPath *

  Write-Host "Verifying ZIP root..."
  tar -tf $zipPath | Select-Object -First 20
} finally {
  Pop-Location
}

Write-Host "Lambda package created: $zipPath"
