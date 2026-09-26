// Shared Airtable helpers for the laptop dashboard and its setup script.
// Reads AIRTABLE_TOKEN, AIRTABLE_BASE_ID and optional AIRTABLE_TABLE from
// dashboard/.env (or the real environment, which wins).

const fs = require("node:fs");
const path = require("node:path");

function loadEnv() {
  const file = path.join(__dirname, ".env");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
  const config = {
    token: process.env.AIRTABLE_TOKEN,
    baseId: process.env.AIRTABLE_BASE_ID,
    table: process.env.AIRTABLE_TABLE || "Calls",
  };
  if (!config.token || !config.baseId) {
    console.error(
      "Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID.\n" +
        "Copy dashboard/.env.example to dashboard/.env and fill both in."
    );
    process.exit(1);
  }
  return config;
}

async function airtable(config, method, urlPath, body) {
  const resp = await fetch(`https://api.airtable.com/v0/${urlPath}`, {
    method,
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Airtable ${method} ${urlPath} -> ${resp.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

module.exports = { loadEnv, airtable };
