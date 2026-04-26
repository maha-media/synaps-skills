// vtt.mjs — VTT (WebVTT) caption parser used by transcript.js.
//
// Why this exists: yt-dlp emits .vtt files (with optional auto-caption rolling
// duplicates and inline timestamp tags); we want a flat "[m:ss] text" stream.
//
// Public API:
//   parseVTT(raw: string)        -> Array<{ time: string, text: string }>
//   formatTimestamp(vtt: string) -> string ("m:ss" or "h:mm:ss")

/**
 * Format a VTT timestamp ("HH:MM:SS.mmm" or "HH:MM:SS") as a short label:
 *   < 1h → "m:ss"
 *   ≥ 1h → "h:mm:ss"
 */
export function formatTimestamp(vttTime) {
  const [hms] = String(vttTime).split('.');
  const [hStr, mStr, sStr] = hms.split(':');
  const h = parseInt(hStr, 10) || 0;
  const m = parseInt(mStr, 10) || 0;
  const s = parseInt(sStr, 10) || 0;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

const TS_RX = /^\d\d:\d\d:\d\d(?:\.\d+)?\s*-->\s*\d\d:\d\d:\d\d/;

/**
 * Parse a WebVTT document and return ordered cues with normalized text.
 *
 * - Skips WEBVTT header, NOTE blocks, STYLE blocks, and bare cue indices.
 * - Strips inline VTT tags (<c>, <00:00:01.000>, etc.).
 * - Collapses consecutive cues whose text matches the previous cue
 *   (YouTube auto-caption rolling-display artifact).
 * - Drops cues whose text is empty after tag stripping.
 */
export function parseVTT(raw) {
  if (!raw) return [];
  const blocks = String(raw).replace(/\r\n/g, '\n').split(/\n\n+/);
  const out = [];
  let lastText = '';
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    // Skip metadata blocks
    if (lines[0].startsWith('WEBVTT')) continue;
    if (lines[0].startsWith('NOTE')) continue;
    if (lines[0] === 'STYLE' || lines[0].startsWith('STYLE ')) continue;
    if (lines[0] === 'REGION' || lines[0].startsWith('REGION ')) continue;
    // Find timestamp line (may be preceded by a cue index)
    const tsIdx = lines.findIndex((l) => TS_RX.test(l));
    if (tsIdx === -1) continue;
    const ts = lines[tsIdx].split('-->')[0].trim();
    const textLines = lines.slice(tsIdx + 1);
    const text = textLines
      .join(' ')
      .replace(/<[^>]+>/g, '')   // strip <c>, <00:00:01.000>, etc.
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    if (text === lastText) continue;
    lastText = text;
    out.push({ time: formatTimestamp(ts), text });
  }
  return out;
}
