#!/usr/bin/env node
// Publishes extension/ to the existing Chrome Web Store item.
// Setup and credential locations are documented in docs/publishing.md.

import { createSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ITEM_ID = "fpopdhhcjefmejigbgnjeknkbloolcfb";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";
const ZIP_PATH = path.join(ROOT, "extension.zip");
const CONFIG_PATH = path.join(ROOT, "scripts", "chrome-webstore.local.json");
const KEY_PATH =
  process.env.CWS_SERVICE_ACCOUNT_KEY ||
  path.join(process.env.APPDATA || path.join(process.env.HOME || "", ".config"), "NovelTrackr", "chrome-webstore-key.json");

const USAGE = `\
Usage: npm run extension:<command>

  extension:zip       Build extension.zip only (manifest.json at the root)
  extension:status    Show the published and submitted store versions
  extension:upload    Zip and upload, but do not publish
  extension:publish   Zip, upload, wait for processing, and publish

Credentials:
  Service account key: ${KEY_PATH}
    (override with CWS_SERVICE_ACCOUNT_KEY)
  Publisher ID:        ${CONFIG_PATH} as {"publisherId":"..."}
    (or set CWS_PUBLISHER_ID)

Setup: docs/publishing.md
`;

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function readJson(file, description) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`Could not read ${description} at ${file}: ${error.message}`);
  }
}

function publisherId() {
  const fromEnv = process.env.CWS_PUBLISHER_ID?.trim();
  if (fromEnv) return fromEnv;

  if (existsSync(CONFIG_PATH)) {
    const id = readJson(CONFIG_PATH, "publisher config").publisherId;
    if (id) return String(id).trim();
  }

  fail(`No publisher ID found. Add {"publisherId":"..."} to ${CONFIG_PATH}, or set CWS_PUBLISHER_ID.`);
}

async function accessToken() {
  if (!existsSync(KEY_PATH)) {
    fail(`No service account key at ${KEY_PATH}. See docs/publishing.md.`);
  }

  const key = readJson(KEY_PATH, "service account key");
  if (!key.client_email || !key.private_key) {
    fail(`${KEY_PATH} is not a Google service account JSON key.`);
  }

  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = { alg: "RS256", typ: "JWT" };
  if (key.private_key_id) header.kid = key.private_key_id;

  const unsigned = `${encode(header)}.${encode({
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");

  const response = await fetch(key.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    fail(`Google refused the service account (${response.status}): ${body.slice(0, 2000)}`);
  }

  const token = JSON.parse(body).access_token;
  if (!token) fail(`Google returned no access token: ${body.slice(0, 2000)}`);
  return token;
}

async function call(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    fail(`${init.method || "GET"} ${url} failed (${response.status}): ${text.slice(0, 2000)}`);
  }
  return body;
}

function itemPath(publisher) {
  return `publishers/${publisher}/items/${ITEM_ID}`;
}

function manifestVersion() {
  const manifest = readJson(path.join(ROOT, "extension", "manifest.json"), "extension manifest");
  if (!manifest.version) fail("extension/manifest.json has no version.");
  return manifest.version;
}

function zipExtension() {
  if (process.platform !== "win32") {
    fail("The zip step uses PowerShell and currently supports Windows only.");
  }
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(ROOT, "scripts", "zip-extension.ps1"),
      "-Source",
      path.join(ROOT, "extension"),
      "-Destination",
      ZIP_PATH,
    ],
    { stdio: "inherit" }
  );
  console.log(`✓ extension.zip (${(statSync(ZIP_PATH).size / 1024).toFixed(1)} KB)`);
}

async function fetchStatus(token, publisher) {
  return call(`https://chromewebstore.googleapis.com/v2/${itemPath(publisher)}:fetchStatus`, token);
}

function printStatus(data) {
  const published = data.publishedItemRevisionStatus?.distributionChannels?.[0];
  const submitted = data.submittedItemRevisionStatus?.distributionChannels?.[0];
  console.log(`Published: ${published?.crxVersion ?? "none"}${published?.state ? ` (${published.state})` : ""}`);
  if (submitted) {
    console.log(`Submitted: ${submitted.crxVersion ?? "unknown"}${submitted.state ? ` (${submitted.state})` : ""}`);
  }
  console.log(`Last upload: ${data.lastAsyncUploadState ?? "unknown"}`);
  if (data.takenDown) console.log("Warning: the item is taken down.");
}

async function upload(token, publisher) {
  if (!existsSync(ZIP_PATH)) fail(`No ${ZIP_PATH}. Run: npm run extension:zip`);

  const data = await call(
    `https://chromewebstore.googleapis.com/upload/v2/${itemPath(publisher)}:upload`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: readFileSync(ZIP_PATH),
    }
  );
  console.log(`Uploaded: ${data.crxVersion ?? "unknown"} (${data.uploadState ?? "unknown"})`);

  if (data.uploadState === "UPLOAD_IN_PROGRESS") {
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const status = await fetchStatus(token, publisher);
      if (status.lastAsyncUploadState && status.lastAsyncUploadState !== "UPLOAD_IN_PROGRESS") {
        console.log(`Upload finished: ${status.lastAsyncUploadState}`);
        return;
      }
    }
    fail("Upload is still in progress after 60 seconds; check the Developer Dashboard.");
  }
}

async function publish(token, publisher, version) {
  const status = await fetchStatus(token, publisher);
  const published = status.publishedItemRevisionStatus?.distributionChannels?.[0]?.crxVersion;
  const submitted = status.submittedItemRevisionStatus?.distributionChannels?.[0]?.crxVersion;
  if (published === version || submitted === version) {
    fail(`extension/manifest.json is already at ${version} (published or submitted). Bump the version before publishing.`);
  }

  const data = await call(`https://chromewebstore.googleapis.com/v2/${itemPath(publisher)}:publish`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publishType: "DEFAULT_PUBLISH" }),
  });

  console.log(`Published ${version}: ${data.state ?? "submitted"}`);
  for (const warning of data.warningInfo?.warnings ?? []) {
    console.log(`Warning: ${warning.reason ?? "unknown"}: ${warning.description ?? ""}`);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));

  if (args.size === 0 || args.has("--help")) {
    console.log(USAGE);
    return;
  }
  if (args.has("--zip")) {
    zipExtension();
    return;
  }

  const publisher = publisherId();
  const token = await accessToken();

  if (args.has("--status")) {
    printStatus(await fetchStatus(token, publisher));
    return;
  }
  if (args.has("--upload")) {
    zipExtension();
    await upload(token, publisher);
    printStatus(await fetchStatus(token, publisher));
    return;
  }
  if (args.has("--publish")) {
    const version = manifestVersion();
    console.log(`Manifest version: ${version}`);
    zipExtension();
    await upload(token, publisher);
    await publish(token, publisher, version);
    printStatus(await fetchStatus(token, publisher));
    return;
  }

  fail(`Unknown arguments: ${[...args].join(" ")}\n\n${USAGE}`);
}

main().catch((error) => fail(error?.message || String(error)));
