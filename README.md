# Gmail Server-to-Server (Node.js)

Headless server access to Gmail via OAuth 2.0 refresh token — **no domain-wide delegation, no service account**.

---

## How it works

```
First run (once):
  Browser → Google consent screen → authorisation code
  setup.js exchanges code → refresh token → saved to .env

Every subsequent run (headless):
  index.js / your code → refresh token → access token (auto-renewed) → Gmail API
```

---

## Prerequisites

- Node.js ≥ 18
- A Google Cloud project with the **Gmail API enabled**

---

## 1 — Google Cloud setup

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.
2. Go to **APIs & Services → Library**, search for **Gmail API**, and enable it.
3. Go to **APIs & Services → OAuth consent screen**:
   - Choose **External** (or Internal if Workspace).
   - Fill in the required fields.
   - Under **Scopes**, add the Gmail scopes you need (see `setup.js`).
   - Add your Gmail address as a **Test user** (required while the app is in Testing).
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Desktop app**
   - Download or copy the **Client ID** and **Client Secret**.

---

## 2 — Local setup

```bash
# Install dependencies
npm install

# Copy the env template
cp .env.example .env

# Fill in your credentials
# Edit .env: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
```

---

## 3 — One-time authorisation

```bash
npm run setup
```

- Opens an authorisation URL — paste it in your browser.
- Sign in and consent.
- Copy the code shown and paste it back into the terminal.
- The refresh token is written to `.env` automatically.

---

## 4 — Run

```bash
npm start
```

No browser. Fully headless. The access token is renewed automatically when it expires.

---

## Project structure

```
.
├── .env.example       # Credential template
├── .env               # Your credentials (DO NOT commit)
├── package.json
├── setup.js           # One-time OAuth flow
├── gmail-client.js    # Reusable Gmail API client
└── index.js           # Example usage
```

---

## Available helpers (gmail-client.js)

| Method | Description |
|---|---|
| `getProfile()` | Authenticated account info |
| `listMessages(opts)` | List messages (`query`, `labelIds`, `maxResults`) |
| `getMessage(id, format)` | Raw message resource |
| `readMessage(id)` | Decoded `{ subject, from, to, date, snippet, body }` |
| `sendMessage(opts)` | Send plain-text email (supports thread replies) |
| `modifyMessage(id, add, remove)` | Modify label arrays |
| `markAsRead(id)` | Remove `UNREAD` label |
| `archive(id)` | Remove `INBOX` label |

---

## Security notes

- Never commit `.env` — add it to `.gitignore`.
- Store `GOOGLE_REFRESH_TOKEN` in a secrets manager (AWS Secrets Manager, GCP Secret Manager, Vault, etc.) in production.
- If the refresh token is ever compromised, revoke it at: https://myaccount.google.com/permissions
