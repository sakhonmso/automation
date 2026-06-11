/**
 * drive-client.js
 *
 * Uploads processed Excel files to the P4P folder structure on Google Drive.
 *
 * Folder structure:
 *   P4P/
 *   ├── 2568/
 *   │   ├── 1 - มกราคม/
 *   │   ├── 2 - กุมภาพันธ์/
 *   │   └── ... 12 - ธันวาคม/
 *   └── 2569/
 *       └── ...
 *
 * Requires in .env:
 *   P4P_FOLDER_ID  — the Drive folder ID of the root "P4P" folder
 *
 * ⚠️  The OAuth account must have write access to the P4P folder.
 *     If the folder belongs to sakhonmso@gmail.com, either:
 *     (a) run setup.js logged in as sakhonmso@gmail.com, or
 *     (b) share the P4P folder with the OAuth account as Editor.
 */

import { google }   from "googleapis";
import { Readable } from "stream";

// ── Thai month folder names (match the Drive folder names exactly) ─────────
const MONTH_FOLDER_NAMES = {
   1: "1 - มกราคม",
   2: "2 - กุมภาพันธ์",
   3: "3 - มีนาคม",
   4: "4 - เมษายน",
   5: "5 - พฤษภาคม",
   6: "6 - มิถุนายน",
   7: "7 - กรกฎาคม",
   8: "8 - สิงหาคม",
   9: "9 - กันยายน",
  10: "10 - ตุลาคม",
  11: "11 - พฤศจิกายน",
  12: "12 - ธันวาคม",
};

function createAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Missing Google credentials in .env");
  }
  const client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return client;
}

export function createDriveClient() {
  const auth  = createAuthClient();
  const drive = google.drive({ version: "v3", auth });

  /** Escape a string for use inside a Drive API query (single-quote safe). */
  function driveEscape(s) {
    return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  /**
   * Find a folder by name within a parent. Returns its ID or null.
   */
  async function findFolder(name, parentId) {
    const res = await drive.files.list({
      q        : `name='${driveEscape(name)}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields   : "files(id, name)",
      pageSize : 5,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return res.data.files?.[0]?.id ?? null;
  }

  /**
   * Resolve the target month subfolder for a date key.
   * Throws a clear error if a folder is missing — does NOT auto-create.
   */
  async function resolveTargetFolder(date) {
    const rootId = process.env.P4P_FOLDER_ID;
    if (!rootId) throw new Error("Missing P4P_FOLDER_ID in .env");

    const [yearStr, monthStr] = date.split("_");
    const month = parseInt(monthStr, 10);
    const monthFolderName = MONTH_FOLDER_NAMES[month];

    if (!monthFolderName) {
      throw new Error(`Invalid month "${monthStr}" in date "${date}"`);
    }

    const yearFolderId = await findFolder(yearStr, rootId);
    if (!yearFolderId) {
      throw new Error(`Year folder "${yearStr}" not found inside P4P folder`);
    }

    const monthFolderId = await findFolder(monthFolderName, yearFolderId);
    if (!monthFolderId) {
      throw new Error(`Month folder "${monthFolderName}" not found inside "${yearStr}"`);
    }

    return monthFolderId;
  }

  /**
   * Upload an Excel buffer to the correct P4P subfolder.
   * File is named: physician name only (no extension, no date).
   * If a file with the same name already exists, its content is replaced.
   *
   * @param {Buffer} buffer         Raw xlsx bytes (single sheet)
   * @param {string} physicianName  e.g. "สมชาย ใจดี"
   * @param {string} date           e.g. "2569_02"
   * @returns {Promise<{ fileId: string, fileName: string, replaced: boolean }>}
   */
  async function uploadFile(buffer, physicianName, date) {
    const folderId = await resolveTargetFolder(date);
    const fileName = physicianName;   // physician name only — no extension, no date

    const mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const media    = { mimeType, body: bufferToReadable(buffer) };
    const metadata = { name: fileName, parents: [folderId] };

    // Check for an existing file with the same name in that folder
    const existing = await drive.files.list({
      q        : `name='${driveEscape(fileName)}' and '${folderId}' in parents and trashed=false`,
      fields   : "files(id, modifiedTime)",
      pageSize : 2,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const existingFile = existing.data.files?.[0];

    if (existingFile) {
      const res = await drive.files.update({
        fileId  : existingFile.id,
        media,
        fields  : "id, name, modifiedTime",
        supportsAllDrives: true,
      });
      return { fileId: res.data.id, fileName, replaced: true };
    }

    const res = await drive.files.create({
      requestBody: { ...metadata },
      media,
      fields: "id, name, modifiedTime",
      supportsAllDrives: true,
    });
    return { fileId: res.data.id, fileName, replaced: false };
  }

  /**
   * List all files in the month folder for a given date key.
   * Returns a Map<physicianName, fileId> — one entry per file.
   * Returns an empty Map (silently) if the folder doesn't exist.
   *
   * @param {string} date  e.g. "2569_05"
   * @returns {Promise<Map<string, string>>}
   */
  async function listMonthFiles(date) {
    let folderId;
    try {
      folderId = await resolveTargetFolder(date);
    } catch {
      return new Map();
    }

    const res = await drive.files.list({
      q        : `'${folderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
      fields   : "files(id, name)",
      pageSize : 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const map = new Map();
    for (const f of res.data.files ?? []) {
      map.set(f.name, f.id);
    }
    return map;
  }

  return { uploadFile, listMonthFiles };
}

// ── Helper: convert Buffer to a Node.js Readable stream ───────────────────
function bufferToReadable(buf) {
  const r = new Readable();
  r.push(buf);
  r.push(null);
  return r;
}
