#!/bin/bash

# =============================================================================
# Deploy Google Indexing Notifier — Lambda + DynamoDB + SSM Parameter
# 
# Usage:
#   ./deploy-google-indexing.sh <path-to-service-account.json>
#
# Example:
#   ./deploy-google-indexing.sh ~/Downloads/ageless-period-491209-s8-49244dd0a1f5.json
#
# Reusable for ALL your domains — one Lambda serves them all.
# =============================================================================

set -e

# =============================================================================
# CONFIG
# =============================================================================
REGION="eu-central-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
LAMBDA_NAME="google-indexing-notifier"
DYNAMODB_TABLE="sitemap-url-tracker"
SSM_PARAM="/google-indexing/service-account-key"
ROLE_NAME="google-indexing-lambda-role"
LAMBDA_BUCKET="google-indexing-lambda-deploy"
RUNTIME="nodejs22.x"

# =============================================================================
# VALIDATE INPUT
# =============================================================================
if [ -z "$1" ]; then
    echo "❌ Usage: ./deploy-google-indexing.sh <path-to-service-account.json>"
    echo "   Example: ./deploy-google-indexing.sh ~/Downloads/service-account.json"
    exit 1
fi

SA_KEY_FILE="$1"
if [ ! -f "$SA_KEY_FILE" ]; then
    echo "❌ File not found: $SA_KEY_FILE"
    exit 1
fi

echo "================================================"
echo "  Google Indexing Notifier — Deploy"
echo "  Region: $REGION"
echo "  Account: $ACCOUNT_ID"
echo "================================================"

# =============================================================================
# 1. Store Service Account key in SSM Parameter Store (encrypted, free)
# =============================================================================
echo ""
echo "[1/6] Storing Service Account key in SSM Parameter Store..."

aws ssm put-parameter \
    --name "$SSM_PARAM" \
    --type "SecureString" \
    --value "$(cat "$SA_KEY_FILE")" \
    --overwrite \
    --region "$REGION" \
    > /dev/null

echo "✅ Service Account key stored in SSM: $SSM_PARAM"

# =============================================================================
# 2. Create DynamoDB table (on-demand = pay per request, ~free for this use)
# =============================================================================
echo ""
echo "[2/6] Creating DynamoDB table..."

if ! aws dynamodb describe-table --table-name "$DYNAMODB_TABLE" --region "$REGION" 2>/dev/null; then
    aws dynamodb create-table \
        --table-name "$DYNAMODB_TABLE" \
        --attribute-definitions AttributeName=domain,AttributeType=S \
        --key-schema AttributeName=domain,KeyType=HASH \
        --billing-mode PAY_PER_REQUEST \
        --region "$REGION" \
        > /dev/null

    echo "Waiting for table to become active..."
    aws dynamodb wait table-exists --table-name "$DYNAMODB_TABLE" --region "$REGION"
    echo "✅ DynamoDB table created: $DYNAMODB_TABLE"
else
    echo "✅ DynamoDB table already exists: $DYNAMODB_TABLE"
fi

# =============================================================================
# 3. Create IAM Role
# =============================================================================
echo ""
echo "[3/6] Creating IAM role..."

TRUST_POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

if ! aws iam get-role --role-name "$ROLE_NAME" 2>/dev/null; then
    aws iam create-role \
        --role-name "$ROLE_NAME" \
        --assume-role-policy-document "$TRUST_POLICY" \
        > /dev/null
    echo "Waiting for role to propagate..."
    sleep 10
fi

# Policy: CloudWatch Logs + DynamoDB + SSM
POLICY_DOC="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\"],\"Resource\":\"arn:aws:logs:*:*:*\"},{\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:PutItem\"],\"Resource\":\"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${DYNAMODB_TABLE}\"},{\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParameter\"],\"Resource\":\"arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter${SSM_PARAM}\"}]}"

aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name "${ROLE_NAME}-policy" 2>/dev/null || true
aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "${ROLE_NAME}-policy" \
    --policy-document "$POLICY_DOC"

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
echo "✅ IAM role configured: $ROLE_ARN"

# =============================================================================
# 4. Create S3 bucket for Lambda deployment
# =============================================================================
echo ""
echo "[4/6] Creating deployment S3 bucket..."

if ! aws s3api head-bucket --bucket "$LAMBDA_BUCKET" 2>/dev/null; then
    aws s3api create-bucket \
        --bucket "$LAMBDA_BUCKET" \
        --region "$REGION" \
        --create-bucket-configuration LocationConstraint="$REGION" \
        > /dev/null
    echo "✅ S3 bucket created: $LAMBDA_BUCKET"
else
    echo "✅ S3 bucket already exists: $LAMBDA_BUCKET"
fi

# =============================================================================
# 5. Package and deploy Lambda
# =============================================================================
echo ""
echo "[5/6] Packaging Lambda..."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAMBDA_DIR="${SCRIPT_DIR}/aws-lambda/google-indexing"
TEMP_DIR="${SCRIPT_DIR}/.deploy-tmp-indexing"

mkdir -p "$TEMP_DIR"

cd "$LAMBDA_DIR"
npm install --production
zip -r "${TEMP_DIR}/google-indexing.zip" .
cd "$SCRIPT_DIR"

aws s3 cp "${TEMP_DIR}/google-indexing.zip" "s3://${LAMBDA_BUCKET}/google-indexing.zip"

echo ""
echo "[6/6] Deploying Lambda function..."

if aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" 2>/dev/null; then
    aws lambda update-function-code \
        --function-name "$LAMBDA_NAME" \
        --s3-bucket "$LAMBDA_BUCKET" \
        --s3-key "google-indexing.zip" \
        --region "$REGION" \
        > /dev/null
    
    # Wait for update to complete
    sleep 5

    aws lambda update-function-configuration \
        --function-name "$LAMBDA_NAME" \
        --environment "Variables={DYNAMODB_TABLE=${DYNAMODB_TABLE},SSM_PARAM_NAME=${SSM_PARAM}}" \
        --timeout 60 \
        --memory-size 256 \
        --region "$REGION" \
        > /dev/null
else
    aws lambda create-function \
        --function-name "$LAMBDA_NAME" \
        --runtime "$RUNTIME" \
        --role "$ROLE_ARN" \
        --handler "index.handler" \
        --code "S3Bucket=${LAMBDA_BUCKET},S3Key=google-indexing.zip" \
        --timeout 60 \
        --memory-size 256 \
        --environment "Variables={DYNAMODB_TABLE=${DYNAMODB_TABLE},SSM_PARAM_NAME=${SSM_PARAM}}" \
        --region "$REGION" \
        > /dev/null
fi

echo "✅ Lambda deployed: $LAMBDA_NAME"

# =============================================================================
# CLEANUP
# =============================================================================
rm -rf "$TEMP_DIR"

# =============================================================================
# SUMMARY
# =============================================================================
echo ""
echo "================================================"
echo "  ✅ DEPLOYMENT COMPLETE"
echo "================================================"
echo ""
echo "Infrastructure:"
echo "  Lambda:   $LAMBDA_NAME"
echo "  DynamoDB: $DYNAMODB_TABLE"
echo "  SSM:      $SSM_PARAM"
echo ""
echo "Usage — invoke for any domain:"
echo "  aws lambda invoke --function-name $LAMBDA_NAME \\"
echo "    --payload '{\"siteUrl\":\"https://www.praca-magisterska.pl\"}' \\"
echo "    --cli-binary-format raw-in-base64-out \\"
echo "    --region $REGION /dev/stdout"
echo ""
echo "Add to your deploy.sh (after s3 sync + cloudfront invalidation):"
echo ""
echo '  # Google Indexing notification'
echo '  echo "🔍 Notifying Google..."'
echo "  aws lambda invoke --function-name $LAMBDA_NAME \\"
echo '    --payload "{\"siteUrl\":\"https://www.YOUR-DOMAIN.pl\"}" \\'
echo "    --cli-binary-format raw-in-base64-out \\"
echo "    --region $REGION /tmp/indexing-result.json"
echo '  cat /tmp/indexing-result.json | python3 -m json.tool 2>/dev/null || cat /tmp/indexing-result.json'
echo ""
echo "Works for ALL your domains — just change siteUrl!"
echo ""
echo "Costs (monthly estimate for ~15 domains, ~30 deploys):"
echo "  Lambda:   \$0.00 (free tier: 1M requests)"
echo "  DynamoDB: \$0.00 (free tier: 25 RCU/WCU)"
echo "  SSM:      \$0.00 (standard params free)"
echo "  Total:    \$0.00"
echo ""
