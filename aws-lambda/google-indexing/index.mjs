// =============================================================================
// Google Indexing Notifier Lambda v2
// Fetches sitemap, diffs with previous version, notifies Google of changes,
// and records submission dates in indexing-url-status table.
// =============================================================================

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const REGION = process.env.AWS_REGION || "eu-central-1";
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || "sitemap-url-tracker";
const STATUS_TABLE = process.env.STATUS_TABLE || "indexing-url-status";
const SSM_PARAM_NAME =
  process.env.SSM_PARAM_NAME || "/google-indexing/service-account-key";
const SCOPES = [
  "https://www.googleapis.com/auth/indexing",
  "https://www.googleapis.com/auth/webmasters",
];

const ssm = new SSMClient({ region: REGION });
const dynamodb = new DynamoDBClient({ region: REGION });

// -----------------------------------------------------------------------------
// JWT / OAuth2 for Google Service Account (no external deps)
// -----------------------------------------------------------------------------

function base64url(data) {
  return Buffer.from(data).toString("base64url");
}

async function createJwt(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: SCOPES.join(" "),
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );

  const signInput = `${header}.${payload}`;
  const crypto = await import("crypto");
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signInput);
  const signature = sign.sign(serviceAccount.private_key, "base64url");

  return `${signInput}.${signature}`;
}

async function getAccessToken(serviceAccount) {
  const jwt = await createJwt(serviceAccount);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OAuth token error: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.access_token;
}

// -----------------------------------------------------------------------------
// Google Indexing API
// -----------------------------------------------------------------------------

async function notifyUrl(accessToken, url, type = "URL_UPDATED") {
  const res = await fetch(
    "https://indexing.googleapis.com/v3/urlNotifications:publish",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, type }),
    },
  );

  const data = await res.json();
  return { url, type, status: res.status, response: data };
}

// -----------------------------------------------------------------------------
// Google Search Console API — submit sitemap
// -----------------------------------------------------------------------------

async function submitSitemap(accessToken, siteUrl, sitemapUrl) {
  const encodedSite = encodeURIComponent(siteUrl);
  const encodedSitemap = encodeURIComponent(sitemapUrl);
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/sitemaps/${encodedSitemap}`;

  const res = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  return { sitemapUrl, status: res.status, ok: res.ok };
}

// -----------------------------------------------------------------------------
// Sitemap parsing
// -----------------------------------------------------------------------------

async function fetchSitemapUrls(siteUrl) {
  const indexUrl = `${siteUrl}/sitemap-index.xml`;
  const indexRes = await fetch(indexUrl);
  const indexXml = await indexRes.text();

  const sitemapLocs = [...indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (m) => m[1],
  );

  const allUrls = [];

  for (const sitemapLoc of sitemapLocs) {
    const res = await fetch(sitemapLoc);
    const xml = await res.text();
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    allUrls.push(...urls);
  }

  return [...new Set(allUrls)];
}

// -----------------------------------------------------------------------------
// DynamoDB — store/retrieve previous URLs
// -----------------------------------------------------------------------------

async function getPreviousUrls(domain) {
  const res = await dynamodb.send(
    new GetItemCommand({
      TableName: DYNAMODB_TABLE,
      Key: { domain: { S: domain } },
    }),
  );

  if (!res.Item || !res.Item.urls) return [];
  return res.Item.urls.SS || [];
}

async function storeCurrentUrls(domain, urls) {
  await dynamodb.send(
    new PutItemCommand({
      TableName: DYNAMODB_TABLE,
      Item: {
        domain: { S: domain },
        urls: { SS: urls.length > 0 ? urls : ["__empty__"] },
        lastUpdated: { S: new Date().toISOString() },
        urlCount: { N: String(urls.length) },
      },
    }),
  );
}

// -----------------------------------------------------------------------------
// Record submission date — only sets firstSubmitted if not already set
// -----------------------------------------------------------------------------

async function recordSubmission(domain, url, type) {
  const now = new Date().toISOString();
  try {
    // Use UpdateItem with condition to only set firstSubmitted if it doesn't exist
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: STATUS_TABLE,
        Key: {
          domain: { S: domain },
          url: { S: url },
        },
        UpdateExpression:
          "SET firstSubmitted = if_not_exists(firstSubmitted, :now), lastSubmitted = :now, submissionType = :type",
        ExpressionAttributeValues: {
          ":now": { S: now },
          ":type": { S: type },
        },
      }),
    );
  } catch (err) {
    console.error(`Failed to record submission for ${url}: ${err.message}`);
  }
}

// -----------------------------------------------------------------------------
// Ping sitemap (free, no auth)
// -----------------------------------------------------------------------------

async function pingSitemap(sitemapUrl) {
  const pingUrl = `https://www.google.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`;
  const res = await fetch(pingUrl);
  return { pingUrl, status: res.status, ok: res.ok };
}

// -----------------------------------------------------------------------------
// Main handler
// -----------------------------------------------------------------------------

export const handler = async (event) => {
  const siteUrl = event.siteUrl || "https://www.praca-magisterska.pl";
  const domain = new URL(siteUrl).hostname;
  const sitemapIndexUrl = `${siteUrl}/sitemap-index.xml`;

  console.log(`=== Google Indexing Notifier v2 ===`);
  console.log(`Site: ${siteUrl}`);
  console.log(`Domain: ${domain}`);

  const results = {
    domain,
    siteUrl,
    timestamp: new Date().toISOString(),
    sitemapPing: null,
    sitemapSubmit: null,
    newUrls: [],
    removedUrls: [],
    indexingResults: [],
    errors: [],
  };

  try {
    // 1. Ping sitemap
    console.log("\n[1] Pinging sitemap...");
    results.sitemapPing = await pingSitemap(sitemapIndexUrl);
    console.log(`Ping status: ${results.sitemapPing.status}`);

    // 2. Fetch current sitemap URLs
    console.log("\n[2] Fetching current sitemap...");
    const currentUrls = await fetchSitemapUrls(siteUrl);
    console.log(`Found ${currentUrls.length} URLs in sitemap`);

    // 3. Get previous URLs from DynamoDB
    console.log("\n[3] Fetching previous URLs from DynamoDB...");
    const previousUrls = await getPreviousUrls(domain);
    const prevSet = new Set(previousUrls.filter((u) => u !== "__empty__"));
    const currSet = new Set(currentUrls);
    console.log(`Previous: ${prevSet.size} URLs`);

    // 4. Calculate diff
    const newUrls = currentUrls.filter((u) => !prevSet.has(u));
    const removedUrls = [...prevSet].filter((u) => !currSet.has(u));
    results.newUrls = newUrls;
    results.removedUrls = removedUrls;

    console.log(
      `\n[4] Diff: +${newUrls.length} new, -${removedUrls.length} removed`,
    );

    // 5. If there are changes, use Google APIs
    if (newUrls.length > 0 || removedUrls.length > 0) {
      console.log("\n[5] Authenticating with Google...");
      const ssmRes = await ssm.send(
        new GetParameterCommand({
          Name: SSM_PARAM_NAME,
          WithDecryption: true,
        }),
      );
      const serviceAccount = JSON.parse(ssmRes.Parameter.Value);
      const accessToken = await getAccessToken(serviceAccount);
      console.log("Authenticated successfully");

      // Submit sitemap via Search Console API
      console.log("\n[6] Submitting sitemap to Search Console...");
      results.sitemapSubmit = await submitSitemap(
        accessToken,
        siteUrl,
        sitemapIndexUrl,
      );
      console.log(`Sitemap submit status: ${results.sitemapSubmit.status}`);

      // Notify new URLs (URL_UPDATED) + record submission
      console.log(`\n[7] Notifying ${newUrls.length} new URLs...`);
      for (const url of newUrls) {
        try {
          const result = await notifyUrl(accessToken, url, "URL_UPDATED");
          results.indexingResults.push(result);

          // Record submission date
          if (result.status === 200) {
            await recordSubmission(domain, url, "URL_UPDATED");
          }

          console.log(`  ✅ ${url} → ${result.status}`);
          if (newUrls.length > 10) await sleep(200);
        } catch (err) {
          const errMsg = `Failed to notify ${url}: ${err.message}`;
          results.errors.push(errMsg);
          console.error(`  ❌ ${errMsg}`);
        }
      }

      // Notify removed URLs (URL_DELETED)
      console.log(`\n[8] Notifying ${removedUrls.length} removed URLs...`);
      for (const url of removedUrls) {
        try {
          const result = await notifyUrl(accessToken, url, "URL_DELETED");
          results.indexingResults.push(result);

          if (result.status === 200) {
            await recordSubmission(domain, url, "URL_DELETED");
          }

          console.log(`  ✅ ${url} → ${result.status} (deleted)`);
        } catch (err) {
          const errMsg = `Failed to notify removal ${url}: ${err.message}`;
          results.errors.push(errMsg);
          console.error(`  ❌ ${errMsg}`);
        }
      }
    } else {
      console.log("\n[5-8] No changes detected, skipping Google API calls");

      // Still submit sitemap
      console.log("Submitting sitemap anyway...");
      const ssmRes = await ssm.send(
        new GetParameterCommand({
          Name: SSM_PARAM_NAME,
          WithDecryption: true,
        }),
      );
      const serviceAccount = JSON.parse(ssmRes.Parameter.Value);
      const accessToken = await getAccessToken(serviceAccount);
      results.sitemapSubmit = await submitSitemap(
        accessToken,
        siteUrl,
        sitemapIndexUrl,
      );
      console.log(`Sitemap submit status: ${results.sitemapSubmit.status}`);
    }

    // 9. Store current URLs in DynamoDB
    console.log("\n[9] Storing current URLs in DynamoDB...");
    await storeCurrentUrls(domain, currentUrls);
    console.log("Stored successfully");
  } catch (err) {
    results.errors.push(err.message);
    console.error("Fatal error:", err);
  }

  // Summary
  console.log("\n=== Summary ===");
  console.log(`New URLs notified: ${results.newUrls.length}`);
  console.log(`Removed URLs notified: ${results.removedUrls.length}`);
  console.log(`Errors: ${results.errors.length}`);

  return {
    statusCode: 200,
    body: results,
  };
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
