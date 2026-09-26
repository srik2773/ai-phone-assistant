// One-time setup: creates the "Calls" table (and its fields) in your
// Airtable base, so you don't have to build it by hand.
//
// Usage: npm run dashboard:setup

const { loadEnv, airtable } = require("./airtable");

const FIELDS = [
  { name: "Caller", type: "singleLineText" },
  { name: "Phone", type: "phoneNumber" },
  { name: "Callback Number", type: "singleLineText" },
  { name: "Reason", type: "multilineText" },
  { name: "Summary", type: "multilineText" },
  {
    name: "Urgency",
    type: "singleSelect",
    options: { choices: [{ name: "Urgent", color: "redBright" }, { name: "Non-Urgent", color: "greenLight2" }] },
  },
  {
    name: "Status",
    type: "singleSelect",
    options: { choices: [{ name: "Pending", color: "yellowBright" }, { name: "Handled", color: "grayLight2" }] },
  },
  {
    name: "Received",
    type: "dateTime",
    options: { dateFormat: { name: "local" }, timeFormat: { name: "12hour" }, timeZone: "client" },
  },
  { name: "Transcript", type: "multilineText" },
  { name: "Call SID", type: "singleLineText" },
];

async function main() {
  const config = loadEnv();
  const { tables } = await airtable(config, "GET", `meta/bases/${config.baseId}/tables`);
  const existing = tables.find((t) => t.name === config.table);
  if (existing) {
    const have = new Set(existing.fields.map((f) => f.name));
    const missing = FIELDS.filter((f) => !have.has(f.name)).map((f) => f.name);
    console.log(`Table "${config.table}" already exists.`);
    if (missing.length) console.log(`It is missing these fields: ${missing.join(", ")}`);
    return;
  }
  await airtable(config, "POST", `meta/bases/${config.baseId}/tables`, {
    name: config.table,
    description: "Calls screened by the personal voice agent.",
    fields: FIELDS,
  });
  console.log(`Created table "${config.table}" with ${FIELDS.length} fields. You're ready to go.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
