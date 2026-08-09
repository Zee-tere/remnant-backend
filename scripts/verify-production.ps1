param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https://')]
  [string]$ApiUrl,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https://')]
  [string]$FrontendUrl,

  [string]$Region = 'us-east-1',
  [string]$FunctionName = 'remnant-api',
  [string]$UploadBucket = 'remnant-uploads-prod',
  [string]$UserPoolId,
  [string]$UserPoolClientId
)

$ErrorActionPreference = 'Stop'
$failures = [System.Collections.Generic.List[string]]::new()

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' is not installed or not on PATH."
  }
}

function Invoke-Check([string]$Name, [scriptblock]$Check) {
  try {
    & $Check
    Write-Host "PASS $Name" -ForegroundColor Green
  } catch {
    $failures.Add("$Name`: $($_.Exception.Message)")
    Write-Host "FAIL $Name" -ForegroundColor Red
  }
}

$curlCommand = if (Get-Command 'curl.exe' -ErrorAction SilentlyContinue) { 'curl.exe' } else { 'curl' }
Assert-Command $curlCommand
Assert-Command 'aws'

$api = $ApiUrl.TrimEnd('/')
$web = $FrontendUrl.TrimEnd('/')

Invoke-Check 'API health' {
  & $curlCommand --fail --silent --show-error --max-time 20 "$api/health" | Out-Null
}

Invoke-Check 'Public listing feed' {
  & $curlCommand --fail --silent --show-error --max-time 20 "$api/listings?limit=1" | Out-Null
}

Invoke-Check 'Frontend marketplace' {
  & $curlCommand --fail --silent --show-error --max-time 20 "$web/marketplace" | Out-Null
}

Invoke-Check 'Controlled disallowed-origin response' {
  $nullTarget = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'NUL' } else { '/dev/null' }
  $status = & $curlCommand --silent --output $nullTarget --write-out '%{http_code}' --request OPTIONS "$api/listings" --header 'Origin: https://not-remnant.invalid' --header 'Access-Control-Request-Method: GET'
  if ($status -ne '403') { throw "expected 403, received $status" }
}

Invoke-Check 'Credentialed production CORS preflight' {
  $nullTarget = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'NUL' } else { '/dev/null' }
  $headers = & $curlCommand --silent --dump-header - --output $nullTarget --request OPTIONS "$api/auth/guest-session" --header 'Origin: https://remnantmarket.co' --header 'Access-Control-Request-Method: POST' --header 'Access-Control-Request-Headers: content-type,x-guest-token,x-request-id'
  $headerText = $headers -join "`n"
  if ($headerText -notmatch '(?im)^access-control-allow-origin:\s*https://remnantmarket\.co\s*$') { throw 'production origin is not allowed' }
  if ($headerText -notmatch '(?im)^access-control-allow-credentials:\s*true\s*$') { throw 'credentialed requests are not allowed' }
  foreach ($requiredHeader in @('content-type', 'x-guest-token', 'x-request-id')) {
    if ($headerText -notmatch "(?im)^access-control-allow-headers:.*$requiredHeader") { throw "$requiredHeader is not allowed" }
  }
}

Invoke-Check 'Lambda configuration exists' {
  aws lambda get-function-configuration --region $Region --function-name $FunctionName --query 'FunctionName' --output text | Out-Null
}

Invoke-Check 'At least one Lambda alarm exists' {
  $count = aws cloudwatch describe-alarms --region $Region --query "length(MetricAlarms[?contains(Dimensions[].Value, '$FunctionName')])" --output text
  if ([int]$count -lt 1) { throw 'no CloudWatch metric alarm targets the Lambda function' }
}

Invoke-Check 'Required schedules are enabled' {
  foreach ($ruleName in @('remnant-matching-worker', 'remnant-outbox-relay', 'remnant-daily-maintenance')) {
    $state = aws events describe-rule --region $Region --name $ruleName --query 'State' --output text
    if ($state -ne 'ENABLED') { throw "$ruleName is not enabled" }
    $targets = aws events list-targets-by-rule --region $Region --rule $ruleName --query "length(Targets[?contains(Arn, '$FunctionName')])" --output text
    if ([int]$targets -lt 1) { throw "$ruleName does not target $FunctionName" }
  }
}

Invoke-Check 'S3 public access is fully blocked' {
  $values = aws s3api get-public-access-block --region $Region --bucket $UploadBucket --query 'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]' --output text
  if (($values -split '\s+') -contains 'False') { throw 'one or more S3 public-access block settings are false' }
}

Invoke-Check 'S3 default encryption is configured' {
  aws s3api get-bucket-encryption --region $Region --bucket $UploadBucket --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' --output text | Out-Null
}

if ($UserPoolId -and $UserPoolClientId) {
  Invoke-Check 'Cognito public client auth flow' {
    $client = aws cognito-idp describe-user-pool-client --region $Region --user-pool-id $UserPoolId --client-id $UserPoolClientId --output json | ConvertFrom-Json
    if ($client.UserPoolClient.ClientSecret) { throw 'browser app client has a client secret' }
    if ($client.UserPoolClient.ExplicitAuthFlows -notcontains 'ALLOW_USER_PASSWORD_AUTH') { throw 'ALLOW_USER_PASSWORD_AUTH is missing' }
    if (-not $client.UserPoolClient.EnableTokenRevocation) { throw 'token revocation is disabled' }
  }
} else {
  Write-Host 'SKIP Cognito check (provide UserPoolId and UserPoolClientId)' -ForegroundColor Yellow
}

if ($failures.Count -gt 0) {
  Write-Host "`nProduction verification failed:" -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "- $_" }
  exit 1
}

Write-Host "`nAutomated production checks passed. Complete the manual backup/restore and user-flow gates in PRODUCTION_RUNBOOK.md." -ForegroundColor Green
