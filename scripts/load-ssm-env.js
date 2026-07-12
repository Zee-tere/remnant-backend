#!/usr/bin/env node

const AWS = require('aws-sdk');

const path = process.env.SSM_PARAMETER_PATH || process.argv[2];
const region = process.env.AWS_SSM_REGION || process.env.AWS_REGION || 'eu-north-1';
const required = process.env.SSM_REQUIRE_PARAMETERS === 'true';

function toEnvKey(parameterName) {
  const base = parameterName.split('/').filter(Boolean).pop() || parameterName;
  return base.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function getAllParameters(ssm, parameterPath) {
  const parameters = [];
  let NextToken;

  do {
    const response = await ssm
      .getParametersByPath({
        Path: parameterPath,
        Recursive: true,
        WithDecryption: true,
        NextToken,
      })
      .promise();

    parameters.push(...(response.Parameters || []));
    NextToken = response.NextToken;
  } while (NextToken);

  return parameters;
}

async function main() {
  if (!path) {
    process.exit(0);
  }

  const ssm = new AWS.SSM({ region });
  const parameters = await getAllParameters(ssm, path);

  if (required && parameters.length === 0) {
    throw new Error(`No SSM parameters found under ${path}`);
  }

  for (const parameter of parameters) {
    if (!parameter.Name || typeof parameter.Value !== 'string') continue;
    const key = toEnvKey(parameter.Name);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    process.stdout.write(`export ${key}=${shellQuote(parameter.Value)}\n`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
