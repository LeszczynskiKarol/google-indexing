// =============================================================================
// Google Indexing Dashboard API Lambda v3
// Tracks: firstSubmitted (from notifier), statusChangedAt, previousVerdict
// =============================================================================

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const REGION = process.env.AWS_REGION || "eu-central-1";
const TRACKER_TABLE = process.env.TRACKER_TABLE || "sitemap-url-tracker";
const STATUS_TABLE = process.env.STATUS_TABLE || "indexing-url-status";
const SSM_PARAM =
  process.env.SSM_PARAM_NAME || "/google-indexing/service-account-key";
const FUNCTION_NAME =
  process.env.AWS_LAMBDA_FUNCTION_NAME || "google-indexing-dashboard";

const ssm = new SSMClient({ region: REGION });
const dynamodb = new DynamoDBClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });

let cachedToken = null;
let tokenExpiry = 0;

// =============================================================================
// Google Auth
// =============================================================================

function base64url(data) {
  return Buffer.from(data).toString("base64url");
}

async function createJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: [
        "https://www.googleapis.com/auth/indexing",
        "https://www.googleapis.com/auth/webmasters",
        "https://www.googleapis.com/auth/webmasters.readonly",
      ].join(" "),
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signInput = `${header}.${payload}`;
  const crypto = await import("crypto");
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signInput);
  const signature = sign.sign(sa.private_key, "base64url");
  return `${signInput}.${signature}`;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const ssmRes = await ssm.send(
    new GetParameterCommand({ Name: SSM_PARAM, WithDecryption: true }),
  );
  const sa = JSON.parse(ssmRes.Parameter.Value);
  const jwt = await createJwt(sa);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + 3500 * 1000;
  return cachedToken;
}

// =============================================================================
// URL Inspection API
// =============================================================================

function toScDomain(domain) {
  const bare = domain.replace(/^www\./, "");
  return `sc-domain:${bare}`;
}

async function inspectUrl(token, inspectionUrl, siteUrl) {
  const res = await fetch(
    "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inspectionUrl, siteUrl }),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    return { error: true, status: res.status, message: err };
  }
  const data = await res.json();
  const idx = data.inspectionResult?.indexStatusResult || {};
  return {
    error: false,
    verdict: idx.verdict || "UNKNOWN",
    coverageState: idx.coverageState || "Unknown",
    robotsTxtState: idx.robotsTxtState || "UNKNOWN",
    indexingState: idx.indexingState || "UNKNOWN",
    lastCrawlTime: idx.lastCrawlTime || null,
    pageFetchState: idx.pageFetchState || "UNKNOWN",
    crawledAs: idx.crawledAs || "UNKNOWN",
  };
}

// =============================================================================
// DynamoDB
// =============================================================================

async function getAllDomains() {
  const res = await dynamodb.send(
    new ScanCommand({ TableName: TRACKER_TABLE }),
  );
  return (res.Items || []).map((item) => ({
    domain: item.domain?.S,
    urlCount: parseInt(item.urlCount?.N || "0"),
    lastUpdated: item.lastUpdated?.S,
    urls: (item.urls?.SS || []).filter((u) => u !== "__empty__"),
  }));
}

async function getUrlStatuses(domain) {
  const res = await dynamodb.send(
    new QueryCommand({
      TableName: STATUS_TABLE,
      KeyConditionExpression: "#d = :domain",
      ExpressionAttributeNames: { "#d": "domain" },
      ExpressionAttributeValues: { ":domain": { S: domain } },
    }),
  );
  return (res.Items || []).map((item) => ({
    domain: item.domain?.S,
    url: item.url?.S,
    verdict: item.verdict?.S || "UNKNOWN",
    coverageState: item.coverageState?.S || "Not checked",
    lastCrawlTime: item.lastCrawlTime?.S || null,
    lastChecked: item.lastChecked?.S || null,
    indexingState: item.indexingState?.S || "UNKNOWN",
    pageFetchState: item.pageFetchState?.S || "UNKNOWN",
    robotsTxtState: item.robotsTxtState?.S || "UNKNOWN",
    // New tracking fields
    firstSubmitted: item.firstSubmitted?.S || null,
    lastSubmitted: item.lastSubmitted?.S || null,
    statusChangedAt: item.statusChangedAt?.S || null,
    previousVerdict: item.previousVerdict?.S || null,
  }));
}

async function getExistingStatus(domain, url) {
  try {
    const res = await dynamodb.send(
      new GetItemCommand({
        TableName: STATUS_TABLE,
        Key: { domain: { S: domain }, url: { S: url } },
      }),
    );
    if (!res.Item) return null;
    return {
      verdict: res.Item.verdict?.S || null,
      firstSubmitted: res.Item.firstSubmitted?.S || null,
      lastSubmitted: res.Item.lastSubmitted?.S || null,
      statusChangedAt: res.Item.statusChangedAt?.S || null,
      previousVerdict: res.Item.previousVerdict?.S || null,
    };
  } catch {
    return null;
  }
}

async function saveUrlStatus(domain, url, inspection) {
  const now = new Date().toISOString();
  const existing = await getExistingStatus(domain, url);

  const item = {
    domain: { S: domain },
    url: { S: url },
    verdict: { S: inspection.verdict },
    coverageState: { S: inspection.coverageState },
    lastCrawlTime: { S: inspection.lastCrawlTime || "none" },
    lastChecked: { S: now },
    indexingState: { S: inspection.indexingState },
    pageFetchState: { S: inspection.pageFetchState },
    robotsTxtState: { S: inspection.robotsTxtState },
  };

  // Preserve firstSubmitted and lastSubmitted from notifier
  if (existing?.firstSubmitted) {
    item.firstSubmitted = { S: existing.firstSubmitted };
  }
  if (existing?.lastSubmitted) {
    item.lastSubmitted = { S: existing.lastSubmitted };
  }

  // Track status changes
  if (existing && existing.verdict && existing.verdict !== inspection.verdict) {
    item.statusChangedAt = { S: now };
    item.previousVerdict = { S: existing.verdict };
  } else if (existing?.statusChangedAt) {
    // Preserve previous change info
    item.statusChangedAt = { S: existing.statusChangedAt };
    if (existing.previousVerdict) {
      item.previousVerdict = { S: existing.previousVerdict };
    }
  }

  await dynamodb.send(
    new PutItemCommand({ TableName: STATUS_TABLE, Item: item }),
  );
}

// =============================================================================
// Route Handlers
// =============================================================================

async function handleGetDomains() {
  const domains = await getAllDomains();
  const result = [];
  for (const d of domains) {
    const statuses = await getUrlStatuses(d.domain);
    const statusMap = new Map(statuses.map((s) => [s.url, s]));
    const indexed = statuses.filter((s) => s.verdict === "PASS").length;
    const failed = statuses.filter((s) => s.verdict === "FAIL").length;
    const neutral = statuses.filter((s) => s.verdict === "NEUTRAL").length;
    const unchecked = d.urls.filter((u) => !statusMap.has(u)).length;
    result.push({
      domain: d.domain,
      siteUrl: `https://${d.domain}`,
      urlCount: d.urls.length,
      indexed,
      failed,
      neutral,
      unchecked,
      lastUpdated: d.lastUpdated,
      lastChecked: statuses.length
        ? statuses
            .map((s) => s.lastChecked)
            .filter(Boolean)
            .sort()
            .pop()
        : null,
    });
  }
  return result;
}

async function handleGetUrls(domain) {
  const tracker = await dynamodb.send(
    new GetItemCommand({
      TableName: TRACKER_TABLE,
      Key: { domain: { S: domain } },
    }),
  );
  const urls = (tracker.Item?.urls?.SS || []).filter((u) => u !== "__empty__");
  const statuses = await getUrlStatuses(domain);
  const statusMap = new Map(statuses.map((s) => [s.url, s]));
  return urls.map((url) => {
    const status = statusMap.get(url);
    return {
      url,
      verdict: status?.verdict || "UNCHECKED",
      coverageState: status?.coverageState || "Not checked yet",
      lastCrawlTime: status?.lastCrawlTime || null,
      lastChecked: status?.lastChecked || null,
      indexingState: status?.indexingState || "UNKNOWN",
      pageFetchState: status?.pageFetchState || "UNKNOWN",
      // New fields
      firstSubmitted: status?.firstSubmitted || null,
      lastSubmitted: status?.lastSubmitted || null,
      statusChangedAt: status?.statusChangedAt || null,
      previousVerdict: status?.previousVerdict || null,
    };
  });
}

// =============================================================================
// Background worker
// =============================================================================

async function backgroundCheck(domain) {
  console.log(`[BG] Starting inspection for ${domain}`);
  const token = await getAccessToken();
  const inspectionSiteUrl = toScDomain(domain);

  const tracker = await dynamodb.send(
    new GetItemCommand({
      TableName: TRACKER_TABLE,
      Key: { domain: { S: domain } },
    }),
  );
  const allUrls = (tracker.Item?.urls?.SS || []).filter(
    (u) => u !== "__empty__",
  );
  const statuses = await getUrlStatuses(domain);
  const statusMap = new Map(statuses.map((s) => [s.url, s]));

  const toCheck = allUrls.filter((url) => {
    const s = statusMap.get(url);
    return !s || s.verdict !== "PASS";
  });

  console.log(`[BG] ${toCheck.length} URLs to check out of ${allUrls.length}`);

  let checked = 0;
  let errors = 0;

  for (const url of toCheck) {
    try {
      const inspection = await inspectUrl(token, url, inspectionSiteUrl);
      if (!inspection.error) {
        await saveUrlStatus(domain, url, inspection);
        console.log(`[BG] ${url} → ${inspection.verdict}`);
        checked++;
      } else {
        console.error(`[BG] ${url} → ERROR ${inspection.status}`);
        errors++;
      }
    } catch (err) {
      console.error(`[BG] ${url} → EXCEPTION: ${err.message}`);
      errors++;
    }
  }

  console.log(`[BG] Done: ${checked} checked, ${errors} errors`);
}

// =============================================================================
// Lambda Handler
// =============================================================================

export const handler = async (event) => {
  if (event._background) {
    await backgroundCheck(event._background.domain);
    return { ok: true };
  }

  if (event.source === "aws.events" || event["detail-type"]) {
    console.log("Scheduled check triggered");
    const domains = await getAllDomains();
    for (const d of domains) {
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: FUNCTION_NAME,
          InvocationType: "Event",
          Payload: JSON.stringify({ _background: { domain: d.domain } }),
        }),
      );
    }
    return { statusCode: 200, body: { triggered: domains.length } };
  }

  const routeKey = event.routeKey || event.requestContext?.routeKey || "";
  const qs = event.queryStringParameters || {};
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  try {
    let body;

    if (routeKey === "GET /domains") {
      body = await handleGetDomains();
    } else if (routeKey === "GET /urls") {
      if (!qs.domain)
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "domain required" }),
        };
      body = await handleGetUrls(qs.domain);
    } else if (routeKey === "POST /check") {
      const payload = JSON.parse(event.body || "{}");
      if (!payload.domain)
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "domain required" }),
        };
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: FUNCTION_NAME,
          InvocationType: "Event",
          Payload: JSON.stringify({ _background: { domain: payload.domain } }),
        }),
      );
      body = {
        status: "started",
        domain: payload.domain,
        message: "Sprawdzanie w tle. Odśwież za chwilę.",
      };
    } else if (routeKey === "POST /check-all") {
      const domains = await getAllDomains();
      for (const d of domains) {
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: FUNCTION_NAME,
            InvocationType: "Event",
            Payload: JSON.stringify({ _background: { domain: d.domain } }),
          }),
        );
      }
      body = { status: "started", domains: domains.length };
    } else {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Not found" }),
      };
    }

    return { statusCode: 200, headers, body: JSON.stringify(body) };
  } catch (err) {
    console.error("Handler error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
