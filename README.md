# Personal Voice Agent (AI Call Answering)

An AI assistant that answers your phone when you can't. When you don't pick
up in time, your carrier forwards the call to a Twilio number, which runs a
live conversation through Claude and texts you a summary afterward.

```
Caller dials your normal number
         |
         v
  You don't answer within ~20-30s
         |
         v
  Your carrier conditionally forwards the call to a Twilio number
         |
         v
  Twilio hits this Worker's /twilio/voice, /twilio/gather webhooks
         |
         v
  Worker calls the Anthropic API each turn, keeps the transcript in KV
         |
         v
  Call ends -> Worker summarizes the transcript and texts you via Twilio SMS
```

The caller never dials anything different — from their side, it just rings
for a while and then "someone" picks up.

## 1. Install Node.js (if you don't have it)

Check first:

```sh
node --version
```

If that fails, install the LTS version from https://nodejs.org (just run the
installer). On macOS with Homebrew: `brew install node`.

## 2. Get the code onto your machine

```sh
git clone https://github.com/srik2773/ai-phone-assistant
cd ai-phone-assistant
npm install
```

## 3. Create a free Cloudflare account

Sign up at https://dash.cloudflare.com/sign-up, then authenticate the CLI:

```sh
npx wrangler login
```

## 4. Create the KV storage (used to hold each call's transcript while it's in progress)

```sh
npx wrangler kv namespace create CALL_STORE
```

This prints an `id`. Open `wrangler.toml` and replace
`<your-kv-namespace-id>` in the `kv_namespaces` entry with that id.

## 5. Create a Twilio account and buy a number

1. Sign up free at https://www.twilio.com/try-twilio.
2. In the Twilio Console, buy a phone number in your own country with
   **Voice** and **SMS** capability (Phone Numbers → Buy a number). Getting a
   number in your own country keeps the forwarded call domestic instead of
   international.
3. From the Console dashboard, note down your **Account SID** and
   **Auth Token** (click "show" to reveal the token). Keep these private —
   they authenticate full control of your Twilio account.

## 6. Set your secrets

None of these are ever written to the repo — they're stored encrypted on
Cloudflare and injected at runtime.

```sh
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_PHONE_NUMBER
npx wrangler secret put MY_PHONE_NUMBER
```

- `TWILIO_PHONE_NUMBER` and `MY_PHONE_NUMBER` should both be in **E.164
  format**, e.g. `+61412345678` (country code, no spaces/dashes).

**Not in Australia?** Speech recognition is tuned for Australian English
(`en-AU`) by default. Open `wrangler.toml`, remove the `# ` in front of the
`[vars]` and `SPEECH_LANGUAGE` lines, and set it to `en-US`, `en-GB`,
`en-IN`, etc. to match how your callers speak.

## 7. Deploy

```sh
npx wrangler deploy
```

This prints a URL like `https://personal-voice-agent.<your-subdomain>.workers.dev`.
That's your backend's address — you'll wire Twilio to it next.

### Test the conversation without a phone call

If your Twilio number isn't active yet (e.g. still waiting on a regulatory
bundle review), you can still test the actual conversation logic — real
Claude calls, real KV storage — using `test-call.js`. It sends the same kind
of signed webhook requests Twilio would send, so the Worker can't tell the
difference; you just type replies in the terminal instead of speaking them.

```powershell
$env:TWILIO_AUTH_TOKEN = "<your auth token>"
node test-call.js
```

The final step (texting you the summary) will fail until the Twilio number
is active and SMS-capable, but the conversation itself is the real thing.

## 8. Point your Twilio number at the Worker

In the Twilio Console, open your number's configuration page (Phone Numbers
→ Manage → Active numbers → click your number), and under **Voice
Configuration**:

- "A call comes in" → Webhook → `https://<your-worker-url>/twilio/voice` → HTTP POST
- "Call status changes" → `https://<your-worker-url>/twilio/status` → HTTP POST

Save.

## 9. Set up conditional call forwarding on your iPhone

This is done via a GSM dial code from your carrier, not the plain Settings →
Phone → Call Forwarding toggle (that one is *unconditional* — it would
forward every call, answered or not).

From the Phone app keypad, dial (replacing the number with your Twilio
number, full international format, no `+`, and adjust the ring timeout to
whatever your carrier supports — commonly up to ~30 seconds in ~5s steps):

```
**61*61412345678*11*20#
```

then press call. You should get a confirmation tone or message. To check the
current setting: dial `*#61#`. To turn it off: dial `##61#`.

(Exact syntax can vary slightly by carrier — if it doesn't confirm, contact
your carrier's support for their specific "no reply" call forwarding code.)

## 10. Test it

Call your own number from a different phone and let it ring without
answering. After the timeout, you should hear the AI greeting, be able to
have a short conversation, and receive a text summary shortly after hanging
up.

## 11. Call log and dashboard (optional)

Every screened call can be saved to an Airtable table, flagged **Urgent** or
**Non-Urgent** and marked **Pending** until you deal with it. A small app on
your laptop shows them in four views: All, Urgent, Non-Urgent and Pending.
Urgent calls also start their text message with `URGENT:`.

### Create the Airtable base and token

1. Sign up at https://airtable.com and create an empty base (for example
   "Voice Agent"). Its id is the part of the URL that starts with `app`, e.g.
   `https://airtable.com/appXXXXXXXXXXXXXX/...`.
2. Go to https://airtable.com/create/tokens → **Create token**. Give it the
   scopes `data.records:read`, `data.records:write`, `schema.bases:read` and
   `schema.bases:write`, and under **Access** add your new base. Copy the
   token (it is shown only once).

### Set up the dashboard

```sh
copy dashboard\.env.example dashboard\.env    # macOS/Linux: cp dashboard/.env.example dashboard/.env
```

Open `dashboard/.env` and paste the token and base id after the `=` signs
(no quotes). Then create the table, once:

```sh
npm run dashboard:setup
```

That creates a **Calls** table with these fields:

| Field | Type | What goes in it |
| --- | --- | --- |
| Caller | Single line text | Caller's name, or "Unknown caller" |
| Phone | Phone number | Caller ID |
| Callback Number | Single line text | A different number they asked to be called on |
| Reason | Long text | One sentence on why they called |
| Summary | Long text | The same summary that gets texted to you |
| Urgency | Single select | Urgent / Non-Urgent |
| Status | Single select | Pending (new) / Handled |
| Received | Date and time | When the call ended |
| Transcript | Long text | The full conversation |
| Call SID | Single line text | Twilio's call id, for troubleshooting |

### Point the Worker at Airtable

```sh
npx wrangler secret put AIRTABLE_TOKEN
npx wrangler secret put AIRTABLE_BASE_ID
npx wrangler deploy
```

Paste each value bare, without quotes. Until both are set the Worker just
skips Airtable. If Airtable is ever down, you still get the text message.

### Run the dashboard

Easiest on Windows: create a desktop icon once,

```sh
npm run dashboard:shortcut
```

then double-click **Call Dashboard** on your desktop whenever you want to see
your calls. It starts the dashboard in a minimized window and opens it in your
browser; closing that window stops it. Double-clicking again while it's
running just reopens the page. (You can also double-click
`dashboard\Call Dashboard.cmd` directly.)

From a terminal instead, on any system:

```sh
npm run dashboard
```

Either way it opens http://localhost:3000 and reloads calls every 60
minutes (press **Refresh** any time). Change the interval with
`REFRESH_MINUTES=15` in `dashboard/.env`. Use **Mark handled** on a call once
you've dealt with it and it drops out of the Pending view. The dashboard
needs no `npm install` beyond Node.js itself, and your Airtable token never
leaves your laptop except to talk to Airtable.

## Notes

- **Cost**: Twilio charges a small monthly fee for the number plus a
  per-minute rate for calls and a per-SMS rate — check current pricing at
  twilio.com/pricing. Each call also makes a few Anthropic API calls.
- **Models**: the live conversation uses `claude-haiku-4-5-20251001` for
  speed, and the after-call summary uses `claude-sonnet-5`. Override them
  with `CALL_MODEL` and `MODEL` under `[vars]` in `wrangler.toml`.
- **If Claude can't be reached** (wrong API key, outage): the caller still
  hears a polite greeting or goodbye instead of an error, and you still get a
  text saying someone called. Run `npx wrangler tail` to see the error.
- **Testing locally**: if you run `npm run dev`, put your secrets in a
  `.dev.vars` file in the project folder. It's already in `.gitignore`, so it
  won't be committed.
- **Silence and unclear answers**: the agent waits up to 10 seconds for the
  caller to start answering. If it hears nothing, or can't make out the
  answer, it politely repeats the question. It only says goodbye after 3
  silent answers in a row (`ANSWER_WAIT_SECONDS` and `MAX_MISSED_ANSWERS` in
  `src/worker.js`).
- **Security**: every Twilio webhook is verified using Twilio's request
  signature (`X-Twilio-Signature`), so only genuine Twilio requests can
  reach the conversation logic.
- **Updating the backend**: after editing `src/worker.js`, just re-run
  `npx wrangler deploy`.
