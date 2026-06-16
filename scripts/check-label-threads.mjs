/**
 * Temporary diagnostic: count threads with label "เอกสาร P4P"
 * Delete after use.
 */
import { config as dotenvConfig } from "dotenv";
import { google } from "googleapis";

dotenvConfig({ override: true });

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
  throw new Error("Missing Google OAuth env vars");
}

const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });

const client = google.gmail({ version: "v1", auth });

// Find the label ID for "เอกสาร P4P"
const labelsRes = await client.users.labels.list({ userId: "me" });
const labels = labelsRes.data.labels ?? [];
const target = labels.find(l => l.name === "เอกสาร P4P");

if (!target) {
  console.log('❌ Label "เอกสาร P4P" not found.');
  console.log("Available labels:", labels.map(l => l.name).join(", "));
  process.exit(0);
}

console.log(`✅ Found label: "${target.name}" (id: ${target.id})`);

// Count threads
let totalThreads = 0;
let pageToken;
do {
  const res = await client.users.threads.list({
    userId: "me",
    labelIds: [target.id],
    maxResults: 500,
    pageToken,
  });
  const threads = res.data.threads ?? [];
  totalThreads += threads.length;
  pageToken = res.data.nextPageToken;
} while (pageToken);

console.log(`📬 Total threads with label "เอกสาร P4P": ${totalThreads}`);
