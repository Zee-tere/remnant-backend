param(
  [string] $FunctionName = "remnant-api",
  [string] $Region = "us-east-1",
  [string] $EnvFile = ".\lambda-env.production.json"
)

$ErrorActionPreference = "Stop"

$requiredKeys = @(
  "NODE_ENV",
  "DATABASE_URL",
  "FRONTEND_URL",
  "ALLOWED_ORIGINS",
  "COGNITO_USER_POOL_ID",
  "COGNITO_CLIENT_ID",
  "COGNITO_HOSTED_UI_DOMAIN",
  "AWS_REGION",
  "AWS_S3_BUCKET",
  "GUEST_ACCESS_SECRET",
  "AWS_SES_REGION",
  "EMAIL_FROM",
  "OPENAI_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_JWT_SECRET",
  "ESCROW_ENABLED",
  "PAYSTACK_ENABLED"
)

if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw "Environment file not found: $EnvFile. Copy lambda-env.production.example.json to lambda-env.production.json and fill the real values."
}

$incoming = Get-Content -Raw -LiteralPath $EnvFile | ConvertFrom-Json
if (-not $incoming.Variables) {
  throw "$EnvFile must contain a top-level Variables object."
}

$variables = @{}
$incoming.Variables.PSObject.Properties | ForEach-Object {
  $value = [string] $_.Value
  if (-not [string]::IsNullOrWhiteSpace($value)) {
    $variables[$_.Name] = $value
  }
}

$missing = @()
foreach ($key in $requiredKeys) {
  if (-not $variables.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($variables[$key])) {
    $missing += $key
  }
}

if ($missing.Count -gt 0) {
  throw "Missing required Lambda environment variables: $($missing -join ', ')"
}

if ($variables["GUEST_ACCESS_SECRET"].Length -lt 32) {
  throw "GUEST_ACCESS_SECRET must contain at least 32 characters"
}

if ($variables["PAYSTACK_ENABLED"] -eq "true") {
  foreach ($key in @("PAYSTACK_SECRET_KEY")) {
    if (-not $variables.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($variables[$key])) {
      throw "$key is required when PAYSTACK_ENABLED=true"
    }
  }
}

$placeholders = $variables.GetEnumerator() |
  Where-Object { $_.Value -like "REPLACE_WITH_*" -or $_.Value -like "your_*" } |
  ForEach-Object { $_.Key }

if ($placeholders.Count -gt 0) {
  throw "Replace placeholder values before updating Lambda: $($placeholders -join ', ')"
}

if ($variables["AWS_S3_BUCKET"] -ne "remnant-uploads-prod") {
  throw "AWS_S3_BUCKET must be remnant-uploads-prod for production uploads."
}

$payload = @{ Variables = $variables } | ConvertTo-Json -Depth 4 -Compress
$tempFile = Join-Path $env:TEMP "remnant-lambda-env.json"
[System.IO.File]::WriteAllText($tempFile, $payload, [System.Text.UTF8Encoding]::new($false))

aws lambda update-function-configuration `
  --region $Region `
  --function-name $FunctionName `
  --environment "file://$tempFile"

aws lambda wait function-updated `
  --region $Region `
  --function-name $FunctionName

aws lambda get-function-configuration `
  --region $Region `
  --function-name $FunctionName `
  --query "{State:State,Status:LastUpdateStatus,Reason:LastUpdateStatusReason}"
