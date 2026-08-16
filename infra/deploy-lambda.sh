#!/usr/bin/env bash
#
# Build and deploy the ingestion Lambda, and wire S3 -> Lambda.
#
# No VPC configuration: CockroachDB Cloud is publicly reachable over TLS, so the
# function needs plain internet egress and nothing else. Putting it in a VPC
# would require a NAT gateway to reach Bedrock and buy nothing.
#
# Usage:  ./infra/deploy-lambda.sh
# Needs:  aws configure; DATABASE_URL exported (see infra/provision.sh)

set -euo pipefail

FN="${REWIND_FN:-rewind-ingest}"
BUCKET="${REWIND_BUCKET:-rewind-demo}"
REGION="${AWS_REGION:-us-east-1}"
ROLE_NAME="${FN}-role"

command -v aws >/dev/null || { echo "aws cli not found: brew install awscli"; exit 1; }
: "${DATABASE_URL:?export DATABASE_URL first — see infra/provision.sh}"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}"

echo "==> bundle"
rm -rf .build && mkdir -p .build
# The @aws-sdk glob is quoted: unquoted it is a shell glob, and zsh aborts the
# whole command when it matches nothing. The AWS SDK ships in the Lambda runtime,
# so bundling it would only inflate the artifact.
pnpm exec esbuild lambda/ingest.ts \
  --bundle --platform=node --target=node22 --format=cjs \
  --outfile=.build/index.js \
  '--external:@aws-sdk/*'
(cd .build && zip -qr ../ingest.zip .)

echo "==> IAM role"
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]
    }' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  # Scoped to the one bucket it reads and the two models it calls — a wildcard
  # here would let a compromised extractor reach anything in the account.
  aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name rewind-ingest \
    --policy-document "{
      \"Version\":\"2012-10-17\",
      \"Statement\":[
        {\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\"],\"Resource\":\"arn:aws:s3:::${BUCKET}/*\"},
        {\"Effect\":\"Allow\",\"Action\":[\"bedrock:InvokeModel\"],\"Resource\":[
          \"arn:aws:bedrock:${REGION}::foundation-model/*\",
          \"arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/*\"
        ]}
      ]
    }"
  echo "    waiting for role propagation"
  sleep 12
fi

echo "==> bucket"
aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null || \
  aws s3 mb "s3://${BUCKET}" --region "$REGION"

ENV_VARS="Variables={DATABASE_URL=${DATABASE_URL},AWS_REGION_OVERRIDE=${REGION}}"

echo "==> function"
if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" --zip-file fileb://ingest.zip >/dev/null
  aws lambda wait function-updated --function-name "$FN"
  aws lambda update-function-configuration --function-name "$FN" \
    --timeout 300 --memory-size 1024 --environment "$ENV_VARS" >/dev/null
else
  aws lambda create-function --function-name "$FN" \
    --runtime nodejs22.x --handler index.handler --role "$ROLE_ARN" \
    --zip-file fileb://ingest.zip \
    --timeout 300 --memory-size 1024 --environment "$ENV_VARS" >/dev/null
fi
aws lambda wait function-updated --function-name "$FN"

echo "==> S3 trigger"
aws lambda add-permission --function-name "$FN" \
  --statement-id s3-invoke --action lambda:InvokeFunction \
  --principal s3.amazonaws.com --source-arn "arn:aws:s3:::${BUCKET}" >/dev/null 2>&1 || true

aws s3api put-bucket-notification-configuration --bucket "$BUCKET" \
  --notification-configuration "{
    \"LambdaFunctionConfigurations\":[{
      \"LambdaFunctionArn\":\"arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FN}\",
      \"Events\":[\"s3:ObjectCreated:*\"]
    }]
  }"

rm -f ingest.zip

cat <<EOF

Deployed. Trigger the incident by dropping the document into the inbound channel:

  aws s3 cp docs/inbound/q3-vendor-policy-update.md s3://${BUCKET}/inbound/

Then watch the belief change:

  aws logs tail /aws/lambda/${FN} --follow
EOF
