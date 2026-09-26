// Laptop dashboard for screened calls. Serves a small web page on
// http://localhost:3000 that reads the Airtable "Calls" table. Your Airtable
// token stays in this process; the browser only talks to localhost.
//
// Usage: npm run dashboard

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { exec } = require("node:child_process");
const { loadEnv, airtable } = require("./airtable");

const config = loadEnv();
const PORT = Number(process.env.PORT) || 3000;
const table = encodeURIComponent(config.table);
const STATUSES = new Set(["Pending", "Handled"]);
// How often the open page reloads calls from Airtable.
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES) > 0 ? Number(process.env.REFRESH_MINUTES) : 60;

async function listCalls() {
  const calls = [];
  let offset;
  do {
    const query = new URLSearchParams({ "sort[0][field]": "Received", "sort[0][direction]": "desc" });
    if (offset) query.set("offset", offset);
    const page = await airtable(config, "GET", `${config.baseId}/${table}?${query}`);
    for (const rec of page.records) {
      const f = rec.fields;
      calls.push({
        id: rec.id,
        caller: f["Caller"] || "Unknown caller",
        phone: f["Phone"] || "",
        callback: f["Callback Number"] || "",
        reason: f["Reason"] || "",
        summary: f["Summary"] || "",
        urgency: f["Urgency"] || "Non-Urgent",
        status: f["Status"] || "Pending",
        received: f["Received"] || rec.createdTime,
        transcript: f["Transcript"] || "",
      });
    }
    offset = page.offset;
  } while (offset);
  return calls;
}

async function setStatus(id, status) {
  await airtable(config, "PATCH", `${config.baseId}/${table}/${encodeURIComponent(id)}`, {
    fields: { Status: status },
  });
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Only answer requests addressed to localhost, so another website can't
  // reach this server through DNS rebinding.
  const host = (req.headers.host || "").split(":")[0];
  if (host !== "localhost" && host !== "127.0.0.1") return send(res, 403, { error: "forbidden" });

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8")
        .replace("__REFRESH_MINUTES__", String(REFRESH_MINUTES));
      return send(res, 200, page, "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/calls") {
      return send(res, 200, await listCalls());
    }
    const match = url.pathname.match(/^\/api\/calls\/([A-Za-z0-9]+)$/);
    if (req.method === "PATCH" && match) {
      if (!(req.headers["content-type"] || "").startsWith("application/json")) {
        return send(res, 415, { error: "expected JSON" });
      }
      const { status } = JSON.parse((await readBody(req)) || "{}");
      if (!STATUSES.has(status)) return send(res, 400, { error: "status must be Pending or Handled" });
      await setStatus(match[1], status);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err.message);
    send(res, 502, { error: err.message });
  }
});

function openBrowser(address) {
  if (process.env.NO_OPEN) return;
  const opener =
    process.platform === "win32" ? `start "" "${address}"` :
    process.platform === "darwin" ? `open "${address}"` : `xdg-open "${address}"`;
  exec(opener, () => {});
}

const address = `http://localhost:${PORT}`;

// Double-clicking the desktop shortcut while the dashboard is already
// running just brings up the page again instead of failing.
server.on("error", (err) => {
  if (err.code !== "EADDRINUSE") throw err;
  console.log(`Dashboard is already running at ${address}, opening it.`);
  openBrowser(address);
  setTimeout(() => process.exit(0), 1000);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Call dashboard running at ${address}, refreshing every ${REFRESH_MINUTES} min (close this window or press Ctrl+C to stop)`);
  openBrowser(address);
});
