#!/usr/bin/env node

import { YoutubeTranscript } from 'youtube-transcript-plus';
import { recallAndEmit, failAndExit } from "../_lib/hooks.mjs";

const videoId = process.argv[2];

if (!videoId) {
  console.error('Usage: transcript.js <video-id-or-url>');
  console.error('Example: transcript.js EBw7gsDPAYQ');
  console.error('Example: transcript.js https://www.youtube.com/watch?v=EBw7gsDPAYQ');
  process.exit(1);
}

// Extract video ID if full URL is provided
let extractedId = videoId;
if (videoId.includes('youtube.com') || videoId.includes('youtu.be')) {
  const match = videoId.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (match) extractedId = match[1];
}

const HOST = "youtube.com";
const OP = "youtube-transcript";

recallAndEmit(`youtube transcript ${extractedId}`, { host: HOST, op: OP });

try {
  const transcript = await YoutubeTranscript.fetchTranscript(extractedId);

  for (const entry of transcript) {
    const timestamp = formatTimestamp(entry.offset / 1000);
    console.log(`[${timestamp}] ${entry.text}`);
  }
} catch (error) {
  // Hint the agent how to escalate (audio download → whisper)
  console.error('TRANSCRIPT_UNAVAILABLE: ' + error.message);
  console.error('');
  console.error('Captions are not available for this video.');
  console.error('Fallback: download audio and transcribe with Whisper:');
  console.error('');
  console.error(`  yt-dlp -x --audio-format mp3 -o "/tmp/${extractedId}.%(ext)s" "https://www.youtube.com/watch?v=${extractedId}"`);
  console.error(`  python3 ${process.env.CLAUDE_PLUGIN_ROOT || '.'}/scripts/transcribe/transcribe.py /tmp/${extractedId}.mp3 --stdout`);
  failAndExit({
    host: HOST, op: OP,
    err: error,
    exit: 2,
    err_class: "no_transcript",
    cmd: `transcript.js ${extractedId}`,
    args: { videoId: extractedId },
  });
}

function formatTimestamp(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}
