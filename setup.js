/**
 * setup.js — run ONCE to authorise your account and save a refresh token.
 *
 *   npm run setup
 *
 * What it does:
 *   1. Prints an authorisation URL
 *   2. You open it in your browser, consent, and copy the code
 *   3. This script exchanges the code for tokens and writes
 *      GOOGLE_REFRESH_TOKEN into your .env file
 */

import { google } from "googleapis";
import * as fs from "fs";
import * as readline from "readline";
import * as path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, ".env");

// ── Scopes ─────────────────────────────────────────────────────────────────
// Adjust to the minimum your application actually needs.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",      // read, mark read/starred, apply labels
  "https://www.googleapis.com/auth/drive",             // full Drive access — needed to replace files not created by this app
];

// ── Validate env ───────────────────────────────────────────────────────────
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error(
    "\n❌  Missing credentials.\n" +
    "    Copy .env.example → .env and fill in GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.\n"
  );
  process.exit(1);
}

// ── Build OAuth2 client ────────────────────────────────────────────────────
// Using the OOB (out-of-band) redirect URI — standard for CLI/Desktop apps
// where no local HTTP server is available to receive the redirect.
const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",   // ← essential: requests a refresh_token
  prompt: "consent",         // ← forces Google to return refresh_token every time
  scope: SCOPES,
});

console.log("\n┌─────────────────────────────────────────────────────────┐");
console.log("│           Gmail API — one-time authorisation            │");
console.log("└─────────────────────────────────────────────────────────┘");
console.log("\n1. Open this URL in your browser:\n");
console.log("   " + authUrl);
console.log("\n2. Sign in with the Gmail account you want to access.");
console.log("3. Copy the authorisation code shown after consent.\n");

// ── Ask for the code ───────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("Paste the authorisation code here: ", async (code) => {
  rl.close();

  try {
    const { tokens } = await oauth2Client.getToken(code.trim());

    if (!tokens.refresh_token) {
      console.error(
        "\n⚠️  Google did not return a refresh_token.\n" +
        "   This usually means the app was already authorised without 'prompt=consent'.\n" +
        "   Revoke access at https://myaccount.google.com/permissions and run setup again.\n"
      );
      process.exit(1);
    }

    // Persist to .env -------------------------------------------------------
    let envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";

    if (envContent.includes("GOOGLE_REFRESH_TOKEN=")) {
      // Replace existing line
      envContent = envContent.replace(
        /^GOOGLE_REFRESH_TOKEN=.*$/m,
        `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`
      );
    } else {
      envContent += `\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`;
    }

    fs.writeFileSync(ENV_PATH, envContent, "utf8");

    console.log("\n✅  Refresh token saved to .env");
    console.log("    You can now run  npm start  without any browser interaction.\n");
  } catch (err) {
    console.error("\n❌  Failed to exchange code for tokens:", err.message);
    process.exit(1);
  }
});
