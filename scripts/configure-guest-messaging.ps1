param(
  [string] $FunctionName = "remnant-api",
  [string] $Region = "us-east-1"
)

$ErrorActionPreference = "Stop"

$configJson = aws lambda get-function-configuration `
  --region $Region `
  --function-name $FunctionName

if ($LASTEXITCODE -ne 0) {
  throw "Could not read Lambda configuration. Run aws login, then try again."
}

$config = $configJson | ConvertFrom-Json
$variables = @{}
$config.Environment.Variables.PSObject.Properties | ForEach-Object {
  $variables[$_.Name] = [string] $_.Value
}

$currentSecret = [string] $variables["GUEST_ACCESS_SECRET"]
$generated = $false
if ($currentSecret.Length -lt 32) {
  $bytes = New-Object byte[] 48
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  $variables["GUEST_ACCESS_SECRET"] = [Convert]::ToBase64String($bytes)
  $generated = $true
}

$variables["PLATFORM_PAYMENTS_ENABLED"] = "false"
$payload = @{ Variables = $variables } | ConvertTo-Json -Depth 4 -Compress
$tempFile = Join-Path $env:TEMP "remnant-guest-messaging-$([guid]::NewGuid()).json"

try {
  [System.IO.File]::WriteAllText(
    $tempFile,
    $payload,
    [System.Text.UTF8Encoding]::new($false)
  )

  aws lambda update-function-configuration `
    --region $Region `
    --function-name $FunctionName `
    --environment "file://$tempFile"

  if ($LASTEXITCODE -ne 0) {
    throw "Lambda environment update failed."
  }

  aws lambda wait function-updated `
    --region $Region `
    --function-name $FunctionName

  $status = aws lambda get-function-configuration `
    --region $Region `
    --function-name $FunctionName `
    --query "{State:State,Status:LastUpdateStatus,Reason:LastUpdateStatusReason}" `
    --output json

  Write-Host "Guest messaging configuration is ready. New secret generated: $generated"
  Write-Output $status
} finally {
  Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
}
