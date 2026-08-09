param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^arn:aws:sns:')]
  [string]$NotificationTopicArn,

  [string]$Region = 'us-east-1',
  [string]$FunctionName = 'remnant-api',
  [string]$ApiId = '36yevvooae',
  [string]$ApiStage = '$default'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  throw 'AWS CLI is required.'
}

$common = @(
  '--region', $Region,
  '--comparison-operator', 'GreaterThanOrEqualToThreshold',
  '--evaluation-periods', '1',
  '--treat-missing-data', 'notBreaching',
  '--alarm-actions', $NotificationTopicArn,
  '--ok-actions', $NotificationTopicArn
)

aws cloudwatch put-metric-alarm @common `
  --alarm-name "$FunctionName-errors" `
  --alarm-description 'Remnant API returned a Lambda function error.' `
  --namespace AWS/Lambda `
  --metric-name Errors `
  --dimensions "Name=FunctionName,Value=$FunctionName" `
  --statistic Sum `
  --period 300 `
  --threshold 1

aws cloudwatch put-metric-alarm @common `
  --alarm-name "$FunctionName-throttles" `
  --alarm-description 'Remnant API Lambda was throttled.' `
  --namespace AWS/Lambda `
  --metric-name Throttles `
  --dimensions "Name=FunctionName,Value=$FunctionName" `
  --statistic Sum `
  --period 300 `
  --threshold 1

aws cloudwatch put-metric-alarm @common `
  --alarm-name "$FunctionName-duration" `
  --alarm-description 'Remnant API p95 duration exceeded 80 percent of the 30 second timeout.' `
  --namespace AWS/Lambda `
  --metric-name Duration `
  --dimensions "Name=FunctionName,Value=$FunctionName" `
  --extended-statistic p95 `
  --period 300 `
  --threshold 24000

aws cloudwatch put-metric-alarm @common `
  --alarm-name 'remnant-api-gateway-5xx' `
  --alarm-description 'Remnant HTTP API returned a server error.' `
  --namespace AWS/ApiGateway `
  --metric-name 5xx `
  --dimensions "Name=ApiId,Value=$ApiId" "Name=Stage,Value=$ApiStage" `
  --statistic Sum `
  --period 300 `
  --threshold 1

aws logs put-retention-policy `
  --region $Region `
  --log-group-name "/aws/lambda/$FunctionName" `
  --retention-in-days 30

Write-Host 'Configured Lambda/API alarms and 30-day application-log retention.' -ForegroundColor Green
