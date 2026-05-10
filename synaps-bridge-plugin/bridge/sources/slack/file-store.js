/**
 * @file file-store.js
 * @module bridge/sources/slack/file-store
 *
 * File-upload download helper.
 *
 * Downloads a Slack-hosted file to a local path derived from the conversation
 * and thread identifiers, then returns an attachment descriptor ready for
 * injection into `SynapsRpc.prompt()`.
 *
 * §6 of the spec: `~/.synaps-cli/bridge/files/<conversation>/<thread>/<name>`
 * §0 #7: tokens are NEVER written to any log line.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── constants ─────────────────────────────────────────────────────────────────

const DEFAULT_ROOT = path.join(os.homedir(), '.synaps-cli', 'bridge', 'files');

/** Maximum allowed file size in bytes (20 MiB). */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

// ─── sanitizeFilename ──────────────────────────────────────────────────────────

/**
 * Sanitize a filename to prevent path traversal, control character injection,
 * and excessively long names.
 *
 * Rules:
 *  - Strip any leading `../`, `./`, `/`, or backslash sequences.
 *  - Remove ASCII control characters (0x00–0x1F, 0x7F).
 *  - Replace characters that are illegal on common filesystems with `_`.
 *  - Truncate to 200 characters.
 *  - Fall back to `"attachment"` if the result is empty.
 *
 * @param {string} name - Raw filename from Slack file metadata.
 * @returns {string}     Safe filename component (no directory separators).
 */
export function sanitizeFilename(name) {
  if (typeof name !== 'string' || name.length === 0) return 'attachment';

  // Strip path separators and traversal sequences.
  let s = name
    .replace(/[\\/]/g, '_')            // forward + back slashes → _
    .replace(/\.\.\./g, '_')           // triple dots → _
    .replace(/\.\./g, '_');            // double dots → _

  // Remove ASCII control chars (0x00–0x1F) and DEL (0x7F).
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1F\x7F]/g, '');

  // Replace characters illegal on Windows NTFS / FAT (< > : " | ? *) and
  // null-like byte sequences that sneak through in some encodings.
  s = s.replace(/[<>:"|?*]/g, '_');

  // Truncate to 200 chars.
  if (s.length > 200) s = s.slice(0, 200);

  return s.length > 0 ? s : 'attachment';
}

// ─── downloadSlackFile ─────────────────────────────────────────────────────────

/**
 * Download a Slack-hosted file to disk and return an attachment descriptor.
 *
 * @param {object}  opts
 * @param {object}  opts.fileMeta         - Slack file object: `{ id, name, mimetype, url_private, size }`.
 * @param {string}  opts.conversation     - Slack channel id (C-prefixed), used as a path component.
 * @param {string}  opts.thread           - Thread timestamp, used as a path component.
 * @param {string}  opts.botToken         - Bot token used in the `Authorization` header.
 * @param {Function} [opts.fetchImpl]     - Injectable `fetch`-compatible function (default: globalThis.fetch).
 * @param {object}  [opts.fsImpl]         - Injectable `fs.promises`-compatible object (default: node:fs/promises).
 * @param {string}  [opts.root]           - Root directory for downloads (default: `~/.synaps-cli/bridge/files`).
 * @param {number}  [opts.maxBytes]       - Maximum allowed file size in bytes (default: 20 MiB).
 * @param {object}  [opts.logger]         - Injected logger (default: console).
 * @returns {Promise<{path: string, name: string, mime: string}>}
 *   Attachment descriptor ready for `SynapsRpc.prompt()`.
 * @throws {Error} On size violation, fetch failure, or write error (message never contains the token).
 */
export async function downloadSlackFile({
  fileMeta,
  conversation,
  thread,
  botToken,
  fetchImpl = globalThis.fetch,
  fsImpl = fs,
  root = DEFAULT_ROOT,
  maxBytes = DEFAULT_MAX_BYTES,
  logger = console,
} = {}) {
  // ── 1. Size guard (pre-fetch) ─────────────────────────────────────────────
  // fileMeta.size === 0 means unknown — we proceed and check the content-length
  // response header.  A non-zero size above the cap is rejected immediately.
  if (fileMeta.size && fileMeta.size > maxBytes) {
    const err = new Error(
      `File "${fileMeta.name}" (${fileMeta.size} bytes) exceeds the ${maxBytes}-byte limit`,
    );
    try { logger.warn(`[file-store] ${err.message}`); } catch { /* swallow */ }
    throw err;
  }

  // ── 2. Build target path ──────────────────────────────────────────────────
  const safeName = sanitizeFilename(fileMeta.name ?? 'attachment');
  const dir = path.join(root, String(conversation), String(thread));
  const targetPath = path.join(dir, safeName);

  // ── 3. mkdir -p ───────────────────────────────────────────────────────────
  try {
    await fsImpl.mkdir(dir, { recursive: true });
  } catch (err) {
    try { logger.warn(`[file-store] mkdir failed: ${err.message}`); } catch { /* swallow */ }
    throw new Error(`Could not create directory for file download: ${err.message}`);
  }

  // ── 4. Fetch the file from Slack ──────────────────────────────────────────
  // The botToken is placed in the Authorization header and MUST NOT appear in
  // any log line — we deliberately avoid logging the URL (which includes the
  // token-free private URL) at info level; only errors are logged, and then
  // only the sanitised message.
  let response;
  try {
    response = await fetchImpl(fileMeta.url_private, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
  } catch (err) {
    try { logger.warn(`[file-store] fetch failed for file "${fileMeta.name}": ${err.message}`); } catch { /* swallow */ }
    throw new Error(`Fetch failed for Slack file "${fileMeta.name}": ${err.message}`);
  }

  if (!response.ok) {
    const msg = `Slack file fetch returned HTTP ${response.status} for "${fileMeta.name}"`;
    try { logger.warn(`[file-store] ${msg}`); } catch { /* swallow */ }
    throw new Error(msg);
  }

  // ── 5. Content-length guard (post-fetch) ──────────────────────────────────
  const contentLength = Number(response.headers?.get?.('content-length') ?? 0);
  if (contentLength > 0 && contentLength > maxBytes) {
    const msg = `Slack file "${fileMeta.name}" content-length ${contentLength} exceeds ${maxBytes}-byte limit`;
    try { logger.warn(`[file-store] ${msg}`); } catch { /* swallow */ }
    throw new Error(msg);
  }

  // ── 6. Read body and size-check the actual bytes ──────────────────────────
  let buffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (err) {
    try { logger.warn(`[file-store] body read failed for "${fileMeta.name}": ${err.message}`); } catch { /* swallow */ }
    throw new Error(`Could not read body for Slack file "${fileMeta.name}": ${err.message}`);
  }

  if (buffer.byteLength > maxBytes) {
    const msg = `Slack file "${fileMeta.name}" actual size ${buffer.byteLength} exceeds ${maxBytes}-byte limit`;
    try { logger.warn(`[file-store] ${msg}`); } catch { /* swallow */ }
    throw new Error(msg);
  }

  // ── 7. Write to disk with restricted permissions (mode 0o600) ─────────────
  try {
    await fsImpl.writeFile(targetPath, Buffer.from(buffer), { mode: 0o600 });
  } catch (err) {
    try { logger.warn(`[file-store] write failed for "${fileMeta.name}": ${err.message}`); } catch { /* swallow */ }
    throw new Error(`Could not write Slack file "${fileMeta.name}" to disk: ${err.message}`);
  }

  // ── 8. Return attachment descriptor ──────────────────────────────────────
  return {
    path: targetPath,
    name: safeName,
    mime: fileMeta.mimetype ?? 'application/octet-stream',
  };
}
