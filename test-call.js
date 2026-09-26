// Simulates an incoming phone call against the deployed Worker, without any
// real call or an active Twilio number. Twilio webhooks are just signed HTTP
// POSTs -- this script sends the same kind of requests itself, acting as the
// caller, so you can test the conversation logic interactively.
//
// Usage (PowerShell):
//   $env:TWILIO_AUTH_TOKEN = "<your auth token>"
//   node test-call.js
//
// Optional env vars: WORKER_URL, FAKE_FROM, TWILIO_PHONE_NUMBER (defaults below).

const readline = require("node:readline");
const crypto = require("node:crypto");

const WORKER_URL = process.env.WORKER_URL || "https://personal-voice-agent.<your-subdomain>.workers.dev";
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FAKE_FROM = process.env.FAKE_FROM || "+61400000000";
const FAKE_TO = process.env.TWILIO_PHONE_NUMBER || "+61400000001";
const CALL_SID = "CAtest" + Date.now();

if (!AUTH_TOKEN) {
  console.error("Set TWILIO_AUTH_TOKEN first -- the same value you gave `wrangler secret put`.");
  process.exit(1);
}

function twilioSignature(url, params) {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  return crypto.createHmac("sha1", AUTH_TOKEN).update(data).digest("base64");
}

async function post(path, params) {
  const url = `${WORKER_URL}${path}`;
  const signature = twilioSignature(url, params);
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`${path} -> ${resp.status}: ${text}`);
  }
  return text;
}

function unescapeXml(str) {
  return str
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractSay(twiml) {
  // Only the first <Say> is the one that actually plays; a second <Say> (if
  // present) is the no-speech-detected fallback, which never runs when
  // we're always supplying a SpeechResult.
  const match = twiml.match(/<Say[^>]*>([\s\S]*?)<\/Say>/);
  return match ? unescapeXml(match[1]) : "";
}

function isHangup(twiml) {
  return !twiml.includes("<Gather");
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

async function main() {
  console.log("Simulating an incoming call...\n");
  let twiml = await post("/twilio/voice", { CallSid: CALL_SID, From: FAKE_FROM, To: FAKE_TO });
  console.log("AI:", extractSay(twiml));

  while (!isHangup(twiml)) {
    const speech = await ask("\nYou (caller): ");
    twiml = await post("/twilio/gather", { CallSid: CALL_SID, From: FAKE_FROM, SpeechResult: speech });
    console.log("AI:", extractSay(twiml));
  }

  console.log("\nCall ended. Simulating the call-status callback (this also tries to send a real summary SMS)...");
  await post("/twilio/status", { CallSid: CALL_SID, From: FAKE_FROM, CallStatus: "completed" });
  console.log("Done. Check your phone for the summary text -- this step may fail if the Twilio number isn't active/SMS-capable yet, but the conversation above is the real thing.");
  rl.close();
}

main().catch((err) => {
  console.error(err.message);
  rl.close();
  process.exit(1);
});
