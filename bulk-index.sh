#!/bin/bash

# =============================================================================
# Bulk Google Indexing — submit ALL URLs from a domain (one-time initial run)
# 
# Use this ONCE per domain to submit all existing URLs to Google Indexing API.
# After that, deploy.sh handles incremental updates automatically.
#
# Usage:
#   ./bulk-index.sh https://www.praca-magisterska.pl
#   ./bulk-index.sh https://www.licencjackie.pl
# =============================================================================

set -e

REGION="eu-central-1"

if [ -z "$1" ]; then
    echo "Usage: ./bulk-index.sh <site-url>"
    echo "Example: ./bulk-index.sh https://www.praca-magisterska.pl"
    exit 1
fi

SITE_URL="$1"
echo "================================================"
echo "  Bulk Index: $SITE_URL"
echo "================================================"
echo ""

# Force Lambda to treat all URLs as new by clearing DynamoDB entry
DOMAIN=$(echo "$SITE_URL" | sed 's|https\?://||' | sed 's|/.*||')
echo "Clearing previous URL cache for ${DOMAIN}..."
aws dynamodb delete-item \
    --table-name sitemap-url-tracker \
    --key "{\"domain\":{\"S\":\"${DOMAIN}\"}}" \
    --region "$REGION" 2>/dev/null || true

echo "Invoking Lambda (all URLs will be treated as new)..."
echo ""

aws lambda invoke \
    --function-name google-indexing-notifier \
    --payload "{\"siteUrl\":\"${SITE_URL}\"}" \
    --cli-binary-format raw-in-base64-out \
    --region "$REGION" \
    --log-type Tail \
    --query 'LogResult' \
    --output text /tmp/bulk-index-result.json | base64 --decode

echo ""
echo "================================================"
echo "Result:"
echo "================================================"
cat /tmp/bulk-index-result.json | python3 -m json.tool 2>/dev/null || cat /tmp/bulk-index-result.json
echo ""
