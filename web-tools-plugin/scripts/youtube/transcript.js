#!/usr/bin/env node
//
// transcript.js — fetch YouTube captions via yt-dlp.
//
// Replaces the old `youtube-transcript-plus` path which has been broken
// since YouTube's late-2025 caption-endpoint clampdown.  The canonical
// recipe (verified 2026-04-26) is documented in:
//   ~/.synaps-cli/memory/web/notes/youtube-transcripts-via-yt-dlp-*.md
//
// Output: one line per caption cue, formatted "[m:ss] text".
//         Duplicates from auto-caption rolling display are collapsed.
//
// Exit codes:
//   0  success
//   1  usage error
//   2  transcript unavailable / yt-dlp failed (caption side)
//   3  yt-dlp not installed

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { recallAndEmit, failAndExit } from '../_lib/hooks.mjs';
import { parseVTT } from './vtt.mjs';

const HOST = 'youtube.com';
const OP   = 'youtube-transcript';

// ── arg parsing ────────────────────────────────────────────────────────────

function printHelp() {
  console.error('Usage: transcript.js <video-id-or-url> [options]');
  console.error('');
  console.error('Fetches YouTube auto-generated or manual captions via yt-dlp.');
  console.error('');
  console.error('Options:');
  console.error('  --no-cookies                  do not use a browser cookie jar');
  console.error('  --cookies-from-browser=NAME   override default browser (chrome)');
  console.error('  --lang=CODE                   subtitle language (default: en)');
  console.error('  -h, --help                    show this help');
  console.error('');
  console.error('Examples:');
  console.error('  transcript.js xh2v5oC5Lx4');
  console.error('  transcript.js https://www.youtube.com/watch?v=xh2v5oC5Lx4');
  console.error('  transcript.js xh2v5oC5Lx4 --no-cookies');
  console.error('  transcript.js xh2v5oC5Lx4 --cookies-from-browser=firefox');
  console.error('  transcript.js xh2v5oC5Lx4 --lang=es');
}

let videoArg = null;
let useCookies = true;
let cookieBrowser = 'chrome';
let lang = 'en';

for (const a of process.argv.slice(2)) {
  if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
  else if (a === '--no-cookies') useCookies = false;
  else if (a === '--cookies' || a === '--cookies-from-browser') useCookies = true;
  else if (a.startsWith('--cookies-from-browser=')) {
    useCookies = true;
    cookieBrowser = a.slice('--cookies-from-browser='.length) || 'chrome';
  }
  else if (a.startsWith('--lang=')) lang = a.slice('--lang='.length) || 'en';
  else if (!a.startsWith('-') && !videoArg) videoArg = a;
  else { console.error(`unknown arg: ${a}`); printHelp(); process.exit(1); }
}

if (!videoArg) { printHelp(); process.exit(1); }

function extractVideoId(s) {
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  const m = String(s).match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

const videoId = extractVideoId(videoArg);
if (!videoId) {
  console.error(`Could not extract YouTube video ID from: ${videoArg}`);
  process.exit(1);
}
const url = `https://www.youtube.com/watch?v=${videoId}`;

// ── PRE: recall any prior fixes for this op ────────────────────────────────

recallAndEmit(`youtube transcript ${videoId}`, { host: HOST, op: OP });

// ── verify yt-dlp is installed ─────────────────────────────────────────────

const versionCheck = spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' });
if (versionCheck.error || versionCheck.status !== 0) {
  failAndExit({
    host: HOST, op: OP,
    err: new Error('yt-dlp not found on PATH'),
    exit: 3,
    err_class: 'no_yt_dlp',
    cmd: 'yt-dlp --version',
    stdout:
      'INSTALL: yt-dlp is required.\n' +
      '  pip install -U yt-dlp        # any platform\n' +
      '  brew install yt-dlp          # macOS\n' +
      '  sudo apt install yt-dlp      # Debian/Ubuntu\n',
  });
}

// ── ACT: download captions to a temp dir ───────────────────────────────────

const workDir = join(tmpdir(), `yt-transcript-${videoId}-${process.pid}`);
mkdirSync(workDir, { recursive: true });

// Canonical flag set per the youtube-transcripts memory note. The four
// non-obvious pieces (cookies, js-runtimes, remote-components, player_client)
// each guard against a separate failure mode YouTube has rolled out since 2025.
const ytArgs = [
  '--skip-download',
  '--write-auto-sub',
  '--write-sub',
  '--sub-lang', `${lang}.*,${lang}`,
  '--sub-format', 'vtt',
  '--convert-subs', 'vtt',
  '--js-runtimes', 'node',
  '--remote-components', 'ejs:github',
  '--extractor-args', 'youtube:player_client=web,web_safari,mweb',
  '-o', join(workDir, '%(id)s.%(ext)s'),
];
if (useCookies) ytArgs.push('--cookies-from-browser', cookieBrowser);
ytArgs.push(url);

const yt = spawnSync('yt-dlp', ytArgs, { encoding: 'utf8' });

function cleanup() {
  try { rmSync(workDir, { recursive: true, force: true }); } catch {}
}

// ── classify yt-dlp errors into err_class our memory layer understands ─────

function classifyYtDlpError(stderr) {
  const s = String(stderr || '');
  if (/sign in to confirm.*not a bot|consent|cookies/i.test(s)) return 'bot_detected';
  if (/age[-\s]?restricted|sign in to confirm.*age/i.test(s))    return 'age_gate';
  if (/private video/i.test(s))                                  return 'http_403';
  if (/video unavailable|removed by the uploader|terminated/i.test(s)) return 'http_404';
  if (/HTTP Error 429|too many requests|rate.?limit/i.test(s))   return 'rate_limit';
  if (/no subtitles|no.*captions|requested subtitle.*not.*available/i.test(s)) return 'no_transcript';
  if (/n.?challenge solving failed|player.script/i.test(s))      return 'nsig_failed';
  if (/cookies?.*could not be decrypted|secretstorage/i.test(s)) return 'cookie_decrypt';
  if (/network|getaddrinfo|name or service/i.test(s))            return 'dns';
  return 'no_transcript';
}

if (yt.status !== 0) {
  const stderr = yt.stderr || '';
  const errClass = classifyYtDlpError(stderr);
  const firstError = (stderr.split('\n').find((l) => /\bERROR\b/.test(l)) || stderr.split('\n').slice(-3).join(' ')).slice(0, 300);
  cleanup();

  // Targeted escalation hints by class, written to stderr before failAndExit
  console.error(`TRANSCRIPT_UNAVAILABLE (${errClass})`);
  console.error('');
  if (errClass === 'bot_detected' && !useCookies) {
    console.error('YouTube blocked the anonymous request. Retry with cookies:');
    console.error(`  transcript.js ${videoId}                # default uses chrome cookies`);
    console.error(`  transcript.js ${videoId} --cookies-from-browser=firefox`);
  } else if (errClass === 'cookie_decrypt') {
    console.error('Browser cookies could not be decrypted. On Linux:');
    console.error('  sudo apt install python3-secretstorage');
    console.error('Or retry with --no-cookies if the video is public.');
  } else if (errClass === 'age_gate') {
    console.error('Age-restricted video — needs a logged-in browser session.');
    console.error(`  transcript.js ${videoId} --cookies-from-browser=chrome   # ensure logged in`);
  } else if (errClass === 'no_transcript') {
    console.error('No captions available — fall back to audio + whisper:');
    console.error(`  yt-dlp -x --audio-format mp3 -o "/tmp/${videoId}.%(ext)s" "${url}"`);
    console.error(`  python3 \${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py /tmp/${videoId}.mp3 --stdout`);
  } else if (errClass === 'nsig_failed') {
    console.error('n-sig challenge could not be solved. Update yt-dlp:');
    console.error('  pip install -U yt-dlp');
  }

  failAndExit({
    host: HOST, op: OP,
    err: new Error(firstError || 'yt-dlp failed'),
    exit: 2,
    err_class: errClass,
    cmd: `yt-dlp --skip-download ... ${url}`,
    args: { videoId, useCookies, cookieBrowser, lang },
    stderr,
  });
}

// ── locate the .vtt file yt-dlp produced ───────────────────────────────────

let vttFiles;
try {
  vttFiles = readdirSync(workDir).filter((f) => f.endsWith('.vtt'));
} catch (e) {
  cleanup();
  failAndExit({ host: HOST, op: OP, err: e, exit: 2, err_class: 'no_transcript' });
}

if (!vttFiles.length) {
  cleanup();
  console.error('TRANSCRIPT_UNAVAILABLE (no_transcript)');
  console.error('yt-dlp ran but produced no .vtt subtitle file.');
  console.error('Likely captions are disabled for this video. Whisper fallback:');
  console.error(`  yt-dlp -x --audio-format mp3 -o "/tmp/${videoId}.%(ext)s" "${url}"`);
  console.error(`  python3 \${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py /tmp/${videoId}.mp3 --stdout`);
  failAndExit({
    host: HOST, op: OP,
    err: new Error('no .vtt produced'),
    exit: 2,
    err_class: 'no_transcript',
    args: { videoId, useCookies, cookieBrowser, lang },
  });
}

// Prefer the human-language .vtt over auto-translation (.en-orig, .en-en, …)
const langRx   = new RegExp(`\\.${lang}\\.vtt$`, 'i');
const variantRx = new RegExp(`\\.${lang}-[^.]+\\.vtt$`, 'i');
vttFiles.sort((a, b) => {
  const score = (n) => (langRx.test(n) ? 0 : variantRx.test(n) ? 2 : 1);
  return score(a) - score(b);
});
const vttPath = join(workDir, vttFiles[0]);

let vttRaw;
try { vttRaw = readFileSync(vttPath, 'utf8'); }
catch (e) {
  cleanup();
  failAndExit({ host: HOST, op: OP, err: e, exit: 2, err_class: 'no_transcript' });
}
cleanup();

const cues = parseVTT(vttRaw);
if (!cues.length) {
  console.error('TRANSCRIPT_UNAVAILABLE (empty_vtt)');
  failAndExit({
    host: HOST, op: OP,
    err: new Error('VTT parsed to zero cues'),
    exit: 2,
    err_class: 'no_transcript',
    args: { videoId, vttFile: vttFiles[0] },
  });
}

for (const { time, text } of cues) {
  process.stdout.write(`[${time}] ${text}\n`);
}
