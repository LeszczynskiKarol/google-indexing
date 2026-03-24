#!/bin/bash

# =============================================================================
# Deploy Google Indexing Dashboard — API Gateway + Lambda + DynamoDB + EventBridge
#
# Usage:
#   MSYS_NO_PATHCONV=1 ./deploy-dashboard.sh
#
# Prerequisites: google-indexing-notifier already deployed
# =============================================================================

set -e

REGION="eu-central-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
LAMBDA_NAME="google-indexing-dashboard"
STATUS_TABLE="indexing-url-status"
TRACKER_TABLE="sitemap-url-tracker"
SSM_PARAM="/google-indexing/service-account-key"
ROLE_NAME="google-indexing-dashboard-role"
LAMBDA_BUCKET="google-indexing-lambda-deploy"
API_NAME="google-indexing-dashboard-api"
RUNTIME="nodejs22.x"

echo "================================================"
echo "  Google Indexing Dashboard — Deploy"
echo "  Region: $REGION"
echo "  Account: $ACCOUNT_ID"
echo "================================================"

# =============================================================================
# 1. DynamoDB table for URL inspection status
# =============================================================================
echo ""
echo "[1/6] Creating DynamoDB status table..."

if ! aws dynamodb describe-table --table-name "$STATUS_TABLE" --region "$REGION" 2>/dev/null; then
    aws dynamodb create-table \
        --table-name "$STATUS_TABLE" \
        --attribute-definitions \
            AttributeName=domain,AttributeType=S \
            AttributeName=url,AttributeType=S \
        --key-schema \
            AttributeName=domain,KeyType=HASH \
            AttributeName=url,KeyType=RANGE \
        --billing-mode PAY_PER_REQUEST \
        --region "$REGION" \
        > /dev/null

    echo "Waiting for table..."
    aws dynamodb wait table-exists --table-name "$STATUS_TABLE" --region "$REGION"
    echo "✅ DynamoDB table created: $STATUS_TABLE"
else
    echo "✅ DynamoDB table already exists: $STATUS_TABLE"
fi

# =============================================================================
# 2. IAM Role
# =============================================================================
echo ""
echo "[2/6] Creating IAM role..."

TRUST_POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

if ! aws iam get-role --role-name "$ROLE_NAME" 2>/dev/null; then
    aws iam create-role \
        --role-name "$ROLE_NAME" \
        --assume-role-policy-document "$TRUST_POLICY" \
        > /dev/null
    echo "Waiting for role..."
    sleep 10
fi

POLICY_DOC="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\"],\"Resource\":\"arn:aws:logs:*:*:*\"},{\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:PutItem\",\"dynamodb:Query\",\"dynamodb:Scan\",\"dynamodb:BatchWriteItem\"],\"Resource\":[\"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TRACKER_TABLE}\",\"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${STATUS_TABLE}\"]},{\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParameter\"],\"Resource\":\"arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter${SSM_PARAM}\"}]}"

aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name "${ROLE_NAME}-policy" 2>/dev/null || true
aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "${ROLE_NAME}-policy" \
    --policy-document "$POLICY_DOC"

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
echo "✅ IAM role configured"

# =============================================================================
# 3. Package and deploy Lambda
# =============================================================================
echo ""
echo "[3/6] Packaging Lambda..."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAMBDA_DIR="${SCRIPT_DIR}/aws-lambda/dashboard-api"

mkdir -p "${SCRIPT_DIR}/.deploy-tmp-dashboard"

cd "$LAMBDA_DIR"
npm install --production
zip -r "../../.deploy-tmp-dashboard/dashboard-api.zip" .
cd "$SCRIPT_DIR"

aws s3 cp ".deploy-tmp-dashboard/dashboard-api.zip" "s3://${LAMBDA_BUCKET}/dashboard-api.zip"

echo ""
echo "[4/6] Deploying Lambda..."

if aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" 2>/dev/null; then
    aws lambda update-function-code \
        --function-name "$LAMBDA_NAME" \
        --s3-bucket "$LAMBDA_BUCKET" \
        --s3-key "dashboard-api.zip" \
        --region "$REGION" > /dev/null
    sleep 5
    aws lambda update-function-configuration \
        --function-name "$LAMBDA_NAME" \
        --timeout 120 \
        --memory-size 256 \
        --environment "Variables={TRACKER_TABLE=${TRACKER_TABLE},STATUS_TABLE=${STATUS_TABLE},SSM_PARAM_NAME=${SSM_PARAM}}" \
        --region "$REGION" > /dev/null
else
    aws lambda create-function \
        --function-name "$LAMBDA_NAME" \
        --runtime "$RUNTIME" \
        --role "$ROLE_ARN" \
        --handler "index.handler" \
        --code "S3Bucket=${LAMBDA_BUCKET},S3Key=dashboard-api.zip" \
        --timeout 120 \
        --memory-size 256 \
        --environment "Variables={TRACKER_TABLE=${TRACKER_TABLE},STATUS_TABLE=${STATUS_TABLE},SSM_PARAM_NAME=${SSM_PARAM}}" \
        --region "$REGION" > /dev/null
fi

echo "✅ Lambda deployed: $LAMBDA_NAME"

# =============================================================================
# 5. API Gateway
# =============================================================================
echo ""
echo "[5/6] Creating API Gateway..."

API_ID=$(aws apigatewayv2 get-apis --region "$REGION" \
    --query "Items[?Name=='${API_NAME}'].ApiId" --output text)

if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
    API_ID=$(aws apigatewayv2 create-api \
        --name "$API_NAME" \
        --protocol-type HTTP \
        --cors-configuration "AllowOrigins=*,AllowMethods=GET,POST,OPTIONS,AllowHeaders=Content-Type" \
        --region "$REGION" \
        --query "ApiId" --output text)
fi

# Integration
INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id "$API_ID" --region "$REGION" \
    --query "Items[?contains(IntegrationUri, '${LAMBDA_NAME}')].IntegrationId" --output text)

if [ -z "$INTEGRATION_ID" ] || [ "$INTEGRATION_ID" = "None" ]; then
    INTEGRATION_ID=$(aws apigatewayv2 create-integration \
        --api-id "$API_ID" \
        --integration-type AWS_PROXY \
        --integration-uri "arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${LAMBDA_NAME}" \
        --payload-format-version "2.0" \
        --region "$REGION" \
        --query "IntegrationId" --output text)
fi

# Routes
for ROUTE in "GET /domains" "GET /urls" "POST /check" "POST /check-all"; do
    aws apigatewayv2 create-route \
        --api-id "$API_ID" \
        --route-key "$ROUTE" \
        --target "integrations/${INTEGRATION_ID}" \
        --region "$REGION" 2>/dev/null || true
done

# Stage
if ! aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name "prod" --region "$REGION" 2>/dev/null; then
    aws apigatewayv2 create-stage \
        --api-id "$API_ID" \
        --stage-name "prod" \
        --auto-deploy \
        --region "$REGION" > /dev/null
fi

# Lambda permission
aws lambda add-permission \
    --function-name "$LAMBDA_NAME" \
    --statement-id "apigateway-dashboard" \
    --action "lambda:InvokeFunction" \
    --principal "apigateway.amazonaws.com" \
    --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*" \
    --region "$REGION" 2>/dev/null || true

API_URL="https://${API_ID}.execute-api.${REGION}.amazonaws.com/prod"
echo "✅ API Gateway: $API_URL"

# =============================================================================
# 6. EventBridge — daily check at 6:00 UTC
# =============================================================================
echo ""
echo "[6/6] Creating EventBridge daily schedule..."

RULE_NAME="google-indexing-daily-check"

aws events put-rule \
    --name "$RULE_NAME" \
    --schedule-expression "cron(0 6 * * ? *)" \
    --state ENABLED \
    --region "$REGION" > /dev/null

aws lambda add-permission \
    --function-name "$LAMBDA_NAME" \
    --statement-id "eventbridge-daily-check" \
    --action "lambda:InvokeFunction" \
    --principal "events.amazonaws.com" \
    --source-arn "arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${RULE_NAME}" \
    --region "$REGION" 2>/dev/null || true

aws events put-targets \
    --rule "$RULE_NAME" \
    --targets "Id=dashboard-lambda,Arn=arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${LAMBDA_NAME}" \
    --region "$REGION" > /dev/null

echo "✅ EventBridge rule: daily at 06:00 UTC"

# =============================================================================
# Cleanup & Summary
# =============================================================================
rm -rf ".deploy-tmp-dashboard"

echo ""
echo "================================================"
echo "  ✅ DASHBOARD DEPLOYED"
echo "================================================"
echo ""
echo "API URL: $API_URL"
echo ""
echo "Endpoints:"
echo "  GET  ${API_URL}/domains"
echo "  GET  ${API_URL}/urls?domain=www.praca-magisterska.pl"
echo "  POST ${API_URL}/check     (body: {\"domain\":\"www.praca-magisterska.pl\"})"
echo "  POST ${API_URL}/check-all"
echo ""
echo "Daily auto-check: 06:00 UTC via EventBridge"
echo ""
echo "Test:"
echo "  curl ${API_URL}/domains"
echo ""
echo "⚡ IMPORTANT: Save this API URL — you need it for the dashboard UI:"
echo "   $API_URL"
echo ""

# Save config
cat > .dashboard-config << EOF
API_URL=${API_URL}
API_ID=${API_ID}
EOF
echo "Config saved to .dashboard-config"
