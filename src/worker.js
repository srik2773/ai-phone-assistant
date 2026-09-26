// Cloudflare Worker backend for an AI call-answering agent.
//
// Your carrier conditionally forwards calls you don't answer to a Twilio
// number pointed at this Worker. Twilio handles the phone-network side;
// this Worker runs the conversation through Claude and texts you a summary
// when the call ends.
//
// Routes (all POST, called by Twilio webhooks):
//   /twilio/voice   - call just connected, greet and start listening
//   /twilio/gather  - caller finished speaking, respond and keep listening
//   /twilio/status  - call ended, summarize the transcript, text it to you,
//                     and log the call to Airtable (if configured)

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-5";
// The caller waits in silence while each live reply is generated, so the
// conversation uses a faster model. The after-call summary isn't
// time-sensitive and keeps DEFAULT_MODEL.
const CALL_MODEL = "claude-haiku-4-5-20251001";
const CALL_TTL_SECONDS = 60 * 30; // call records only need to survive one call

// Twilio's default recognizer assumes US English and struggles with other
// accents. Deepgram Nova-3 handles accented speech much better. The language
// defaults to Australian English; set the SPEECH_LANGUAGE var (e.g. "en-US",
// "en-GB", "en-IN") to match where your calls come from.
const SPEECH_MODEL = "deepgram_nova-3";
const DEFAULT_SPEECH_LANGUAGE = "en-AU";
// speechTimeout="auto" stops listening at the caller's first pause, which
// clips people who pause mid-sentence. 1 second still lets them pause
// briefly without adding much lag after every answer.
const SPEECH_PAUSE_SECONDS = 1;
// How long to wait for the caller to start answering before treating it as
// silence.
const ANSWER_WAIT_SECONDS = 10;
// Silent or empty answers in a row before the agent says goodbye. Each one
// gets the last question repeated politely.
const MAX_MISSED_ANSWERS = 2;

// Spoken when Claude can't be reached (bad API key, outage), so the caller
// hears a polite message instead of Twilio's generic application error.
const FALLBACK_GREETING =
  "Hi, this is Srikanth's AI assistant. He can't get to the phone right now. Can I get your name and why you're calling?";
const FALLBACK_GOODBYE =
  "Sorry, I'm having a technical problem. I'll let Srikanth know you called, and he'll get back to you. Goodbye.";

const CALL_SYSTEM_PROMPT = `You are answering a phone call on behalf of Srikanth, who can't come to the phone right now.
You are speaking directly to a real caller in a live phone call, so:
- Speak in short, natural sentences (1-2 sentences per turn). No markdown, no lists, nothing that isn't meant to be spoken aloud.
- At the very start of the call, introduce yourself once as Srikanth's AI assistant (not a human, not Srikanth).
- Ask at most these 5 questions, one at a time, skipping any the caller already answered unprompted, and never asking more than these 5 total:
  1. Their name.
  2. The reason for the call.
  3. A callback number, only if it isn't obvious or is different from the number they're calling from.
  4. Whether it's urgent or can wait for a callback.
  5. Anything else Srikanth should know, only if the call still feels incomplete after the first four.
- You need at minimum a name and a reason before ending the call; everything else is best-effort. If the caller is clearly a robocall/spam, end immediately without going through the list.
- As soon as you have what you need, thank them, say Srikanth will get back to them, and end the call — don't drag it out past what's needed.
- The instant you are ready to end the call, put the exact token [[HANGUP]] at the very end of your reply, after your spoken words. It will be removed before speaking, never say it aloud.
- Never invent information about Srikanth you don't know; if asked something you can't answer, say Srikanth will follow up.
- What the caller says reaches you through automatic speech recognition, which can mangle accented speech, names and numbers. Read each reply generously and work out the most likely meaning from context. If a name or callback number still looks garbled, politely ask them to repeat or spell it. If an answer is unintelligible or doesn't answer your question, politely say you didn't quite catch that and ask the same question again, in simpler words if it helps; do this up to twice per question. Repeats don't count toward the 5 questions. Never mention their accent, and never end the call just because an answer was unclear.`;

const SUMMARY_SYSTEM_PROMPT = `You summarize a finished phone call transcript for the person who missed the call.
Reply with only a JSON object, no other text, with these keys:
- "sms": a text message under 300 characters, plain text, no markdown. Include the caller's name (if given), the reason they called, a callback number if one was given or is obviously different from the caller ID on file, and whether they said it was urgent. If the call was empty, silent, or clearly spam/robocall, say that in one short sentence instead.
- "caller_name": the caller's name, or "" if not given.
- "reason": one sentence on why they called, or "" if unknown.
- "callback_number": a callback number they gave, or "" if none.
- "urgent": true if the caller said it was urgent or the matter is clearly time-critical, otherwise false.
The caller's words came from speech recognition and may be garbled. Use the most likely meaning, and if a name or number is still unclear, give your best guess followed by "(unclear)".`;

// Default Airtable table name; override with the AIRTABLE_TABLE var.
const DEFAULT_AIRTABLE_TABLE = "Calls";

function xmlEscape(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function xml(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/xml" },
  });
}

function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}

async function callClaude(env, system, messages, maxTokens = 400, model = env.MODEL || DEFAULT_MODEL) {
  const resp = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${detail}`);
  }

  const data = await resp.json();
  const reply = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();

  return reply || "";
}

function decodeFormBody(rawBody) {
  const params = {};
  for (const pair of rawBody.split("&")) {
    if (!pair) continue;
    const idx = pair.indexOf("=");
    const rawKey = idx === -1 ? pair : pair.slice(0, idx);
    const rawVal = idx === -1 ? "" : pair.slice(idx + 1);
    const decode = (part) => {
      const t = part.replace(/\+/g, " ");
      try {
        return decodeURIComponent(t);
      } catch (err) {
        return t;
      }
    };
    params[decode(rawKey)] = decode(rawVal);
  }
  return params;
}

async function validTwilioSignature(request, rawUrl, rawBody, authToken) {
  const signature = request.headers.get("x-twilio-signature");
  if (!signature || !authToken) return false;

  const params = decodeFormBody(rawBody);
  let data = rawUrl;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));

  if (computed !== signature) {
    // Almost always means TWILIO_AUTH_TOKEN is not the account's current token.
    console.log("twilio signature mismatch on " + rawUrl);
  }

  return computed === signature;
}

async function parseTwilioRequest(request) {
  const rawBody = await request.text();
  return { params: decodeFormBody(rawBody), rawBody };
}

// If the caller stays silent, Twilio doesn't always post back from <Gather>
// even with actionOnEmptyResult, and with nothing after it the call just
// ends. The <Redirect> catches that case and posts to /twilio/gather with no
// SpeechResult, which counts as a missed answer and repeats the question.
function gatherTwiml(env, sayText, gatherActionUrl) {
  const language = xmlEscape(env.SPEECH_LANGUAGE || DEFAULT_SPEECH_LANGUAGE);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${gatherActionUrl}" method="POST" actionOnEmptyResult="true" language="${language}" speechModel="${SPEECH_MODEL}" speechTimeout="${SPEECH_PAUSE_SECONDS}" timeout="${ANSWER_WAIT_SECONDS}">
    <Say voice="Polly.Joanna">${xmlEscape(sayText)}</Say>
  </Gather>
  <Redirect method="POST">${gatherActionUrl}</Redirect>
</Response>`;
}

function finalTwiml(sayText) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${xmlEscape(sayText)}</Say>
  <Hangup/>
</Response>`;
}

async function handleTwilioVoice(request, env, url) {
  const { params, rawBody } = await parseTwilioRequest(request);
  if (!(await validTwilioSignature(request, url.toString(), rawBody, env.TWILIO_AUTH_TOKEN))) {
    return unauthorized();
  }

  const callSid = params.CallSid;
  const from = params.From || "unknown number";

  await env.CALL_STORE.put(
    `call:${callSid}`,
    JSON.stringify({ from, transcript: [] }),
    { expirationTtl: CALL_TTL_SECONDS }
  );

  let greeting = "";
  try {
    greeting = await callClaude(env, CALL_SYSTEM_PROMPT, [
      { role: "user", content: "[The call just connected. Give your opening greeting now.]" },
    ], 400, env.CALL_MODEL || CALL_MODEL);
  } catch (err) {
    console.log("greeting failed, using fallback: " + ((err && err.message) || String(err)));
  }
  const spoken = greeting.replace("[[HANGUP]]", "").trim() || FALLBACK_GREETING;

  await appendCallTurn(env, callSid, "assistant", spoken);

  const gatherUrl = new URL("/twilio/gather", url).toString();
  return xml(gatherTwiml(env, spoken, gatherUrl));
}

async function appendCallTurn(env, callSid, role, content) {
  const key = `call:${callSid}`;
  const raw = await env.CALL_STORE.get(key);
  const record = raw ? JSON.parse(raw) : { from: "unknown", transcript: [] };
  record.transcript.push({ role, content });
  await env.CALL_STORE.put(key, JSON.stringify(record), { expirationTtl: CALL_TTL_SECONDS });
  return record;
}

async function handleTwilioGather(request, env, url) {
  const { params, rawBody } = await parseTwilioRequest(request);
  if (!(await validTwilioSignature(request, url.toString(), rawBody, env.TWILIO_AUTH_TOKEN))) {
    return unauthorized();
  }

  const callSid = params.CallSid;
  const speech = (params.SpeechResult || "").trim();

  const key = `call:${callSid}`;
  const raw = await env.CALL_STORE.get(key);
  const record = raw ? JSON.parse(raw) : { from: params.From || "unknown", transcript: [] };

  // Silence or nothing recognisable: repeat the last question politely,
  // and only give up after MAX_MISSED_ANSWERS in a row.
  if (!speech) {
    record.missedAnswers = (record.missedAnswers || 0) + 1;
    await env.CALL_STORE.put(key, JSON.stringify(record), { expirationTtl: CALL_TTL_SECONDS });
    if (record.missedAnswers > MAX_MISSED_ANSWERS) {
      return xml(finalTwiml("I'm sorry, I still can't hear you. I'll let Srikanth know you called. Goodbye."));
    }
    const lastQuestion = [...record.transcript].reverse().find((t) => t.role === "assistant");
    const opener = record.missedAnswers === 1
      ? "Sorry, I didn't catch that."
      : "Sorry, I still didn't hear anything. Take your time.";
    const gatherUrl = new URL("/twilio/gather", url).toString();
    return xml(gatherTwiml(env, `${opener} ${lastQuestion ? lastQuestion.content : "Could you say that again?"}`, gatherUrl));
  }

  record.missedAnswers = 0;
  record.transcript.push({ role: "user", content: speech });

  const messages = record.transcript.map((t) => ({ role: t.role, content: t.content }));
  let reply;
  try {
    reply = await callClaude(env, CALL_SYSTEM_PROMPT, messages, 400, env.CALL_MODEL || CALL_MODEL);
  } catch (err) {
    // End politely but keep what the caller said, so the status callback
    // still texts it to you.
    console.log("reply failed, ending call: " + ((err && err.message) || String(err)));
    reply = FALLBACK_GOODBYE + " [[HANGUP]]";
  }
  const shouldHangup = reply.includes("[[HANGUP]]");
  const spoken = reply.replace("[[HANGUP]]", "").trim() || "Thanks, goodbye.";

  record.transcript.push({ role: "assistant", content: spoken });
  await env.CALL_STORE.put(key, JSON.stringify(record), { expirationTtl: CALL_TTL_SECONDS });

  if (shouldHangup) {
    return xml(finalTwiml(spoken));
  }

  const gatherUrl = new URL("/twilio/gather", url).toString();
  return xml(gatherTwiml(env, spoken, gatherUrl));
}

async function handleTwilioStatus(request, env, url) {
  const { params, rawBody } = await parseTwilioRequest(request);
  if (!(await validTwilioSignature(request, url.toString(), rawBody, env.TWILIO_AUTH_TOKEN))) {
    return unauthorized();
  }

  if (params.CallStatus !== "completed") {
    return new Response("ok");
  }

  const callSid = params.CallSid;
  const key = `call:${callSid}`;
  const raw = await env.CALL_STORE.get(key);
  if (!raw) return new Response("ok");

  const record = JSON.parse(raw);
  await env.CALL_STORE.delete(key);

  if (!record.transcript || record.transcript.length === 0) {
    await logCallSafely(env, {
      callSid,
      from: record.from,
      summary: "Call ended before any conversation.",
      urgent: false,
    });
    await sendSms(env, `Missed call from ${record.from}. No conversation was recorded (call ended immediately).`);
    return new Response("ok");
  }

  const transcriptText = record.transcript
    .map((t) => `${t.role === "user" ? "Caller" : "Assistant"}: ${t.content}`)
    .join("\n");

  let rawSummary = "";
  try {
    rawSummary = await callClaude(
      env,
      SUMMARY_SYSTEM_PROMPT,
      [{ role: "user", content: `Caller ID: ${record.from}\n\nTranscript:\n${transcriptText}` }],
      500
    );
  } catch (err) {
    // parseSummary's fallback still texts you that the call happened.
    console.log("summary failed: " + ((err && err.message) || String(err)));
  }
  const summary = parseSummary(rawSummary, record.from);

  await logCallSafely(env, {
    callSid,
    from: record.from,
    callerName: summary.callerName,
    reason: summary.reason,
    callbackNumber: summary.callbackNumber,
    summary: summary.sms,
    urgent: summary.urgent,
    transcript: transcriptText,
  });
  await sendSms(env, (summary.urgent ? "URGENT: " : "") + summary.sms);
  return new Response("ok");
}

// Claude is asked for JSON; if it answers in plain text anyway, still text
// that to Srikanth rather than losing the call.
function parseSummary(text, from) {
  const fallback = {
    sms: text || `Missed call from ${from}. Couldn't summarize the conversation.`,
    callerName: "",
    reason: "",
    callbackNumber: "",
    urgent: false,
  };
  const match = (text || "").match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    const data = JSON.parse(match[0]);
    return {
      sms: String(data.sms || "").trim() || fallback.sms,
      callerName: String(data.caller_name || "").trim(),
      reason: String(data.reason || "").trim(),
      callbackNumber: String(data.callback_number || "").trim(),
      urgent: data.urgent === true,
    };
  } catch (err) {
    return fallback;
  }
}

// Runs before the SMS so a Twilio failure can't lose the record. An Airtable
// problem is only logged, so it never blocks the SMS.
async function logCallSafely(env, call) {
  if (!env.AIRTABLE_TOKEN || !env.AIRTABLE_BASE_ID) return;
  try {
    await logCallToAirtable(env, call);
  } catch (err) {
    console.log("airtable error " + ((err && err.message) || String(err)));
  }
}

async function logCallToAirtable(env, call) {
  const table = encodeURIComponent(env.AIRTABLE_TABLE || DEFAULT_AIRTABLE_TABLE);
  const fields = {
    "Caller": call.callerName || "Unknown caller",
    "Phone": call.from || "",
    "Callback Number": call.callbackNumber || "",
    "Reason": call.reason || "",
    "Summary": call.summary || "",
    "Urgency": call.urgent ? "Urgent" : "Non-Urgent",
    "Status": "Pending",
    "Received": new Date().toISOString(),
    "Transcript": call.transcript || "",
    "Call SID": call.callSid || "",
  };
  const resp = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${table}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Airtable error ${resp.status}: ${detail}`);
  }
}

async function sendSms(env, body) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const params = new URLSearchParams({
    To: env.MY_PHONE_NUMBER,
    From: env.TWILIO_PHONE_NUMBER,
    Body: body,
  });

  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${auth}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Twilio SMS error ${resp.status}: ${detail}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return json({ error: "use POST" }, 405);
    }

    try {
      if (url.pathname === "/twilio/voice") {
        return await handleTwilioVoice(request, env, url);
      }
      if (url.pathname === "/twilio/gather") {
        return await handleTwilioGather(request, env, url);
      }
      if (url.pathname === "/twilio/status") {
        return await handleTwilioStatus(request, env, url);
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      console.log("worker error " + ((err && err.stack) || String(err)));
      return json({ error: err.message || "internal error" }, 500);
    }
  },
};
