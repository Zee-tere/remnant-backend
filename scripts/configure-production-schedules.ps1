param(
  [string]$Region = 'us-east-1',
  [string]$FunctionName = 'remnant-api'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  throw 'AWS CLI is required.'
}

$functionArn = aws lambda get-function-configuration `
  --region $Region `
  --function-name $FunctionName `
  --query 'FunctionArn' `
  --output text

if (-not $functionArn -or $functionArn -eq 'None') {
  throw "Could not resolve Lambda ARN for $FunctionName."
}

$rules = @(
  @{
    Name = 'remnant-matching-worker'
    Schedule = 'rate(1 minute)'
    DetailType = 'RemnantMatchingWorker'
  },
  @{
    Name = 'remnant-outbox-relay'
    Schedule = 'rate(1 minute)'
    DetailType = 'RemnantOutboxRelay'
  },
  @{
    Name = 'remnant-guest-listing-cleanup'
    Schedule = 'rate(1 hour)'
    DetailType = 'RemnantGuestListingCleanup'
  },
  @{
    Name = 'remnant-daily-maintenance'
    Schedule = 'rate(1 day)'
    DetailType = 'RemnantMaintenance'
  }
)

foreach ($rule in $rules) {
  $ruleArn = aws events put-rule `
    --region $Region `
    --name $rule.Name `
    --schedule-expression $rule.Schedule `
    --state ENABLED `
    --description "Remnant scheduled $($rule.DetailType) invocation" `
    --query 'RuleArn' `
    --output text

  $statementId = "events-$($rule.Name)"
  aws lambda add-permission `
    --region $Region `
    --function-name $FunctionName `
    --statement-id $statementId `
    --action lambda:InvokeFunction `
    --principal events.amazonaws.com `
    --source-arn $ruleArn 2>$null

  if ($LASTEXITCODE -ne 0) {
    $policy = aws lambda get-policy --region $Region --function-name $FunctionName --query 'Policy' --output text | ConvertFrom-Json
    $existing = $policy.Statement | Where-Object { $_.Sid -eq $statementId }
    if (-not $existing) { throw "Could not grant EventBridge permission for $($rule.Name)." }
  }

  $target = @(
    @{
      Id = $FunctionName
      Arn = $functionArn
      Input = (@{
        source = 'aws.events'
        'detail-type' = $rule.DetailType
        detail = @{}
      } | ConvertTo-Json -Compress)
    }
  ) | ConvertTo-Json -Compress

  aws events put-targets `
    --region $Region `
    --rule $rule.Name `
    --targets $target | Out-Null

  Write-Host "Configured $($rule.Name) ($($rule.Schedule))." -ForegroundColor Green
}
