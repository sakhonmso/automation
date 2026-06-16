/**
 * Temporary diagnostic: count threads with label "เอกสาร P4P"
 * Delete after use.
 */
import { config as dotenvConfig } from "dotenv";
import { createGmailClient } from "../gmail-client.js";

dotenvConfig({ override: true });

const gmail = createGmailClient();
const auth  = gmail.getAuth();

const { google } = await import("googleapis");
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
