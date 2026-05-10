#!/usr/bin/env node
/**
 * @file fake-synaps-rpc.mjs
 *
 * Fake `synaps rpc` child process — line-JSON protocol.
 * Spawned by SynapsRpc (which calls child_process.spawn(binary, args)).
 *
 * Zero imports from bridge code — only node:readline and node:process.
 * This guarantees it genuinely mimics an external binary boundary.
 *
 * Protocol (mirrors real `synaps rpc`):
 *   On startup: emit ready frame.
 *   On stdin commands: emit scripted response sequences.
 */

import { createInterface } from 'node:readline';
import process from 'node:process';

// ── helpers ──────────────────────────────────────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function fakeSessionId() {
  return 'fake-' + Math.random().toString(36).slice(2, 10);
}

// ── parse CLI args for model ─────────────────────────────────────────────────

let model = 'fake-model';
const argv = process.argv.slice(2); // strip node + script path
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--model' && argv[i + 1]) {
    model = argv[i + 1];
    i++;
  }
}

// ── startup ready frame ──────────────────────────────────────────────────────

const SESSION_ID = fakeSessionId();

emit({
  type: 'ready',
  session_id: SESSION_ID,
  model,
  protocol_version: 1,
});

// ── canned response sequences ─────────────────────────────────────────────────

/**
 * Emit a scripted sequence of events based on prompt content.
 * @param {string} id   - Command id to correlate the final response.
 * @param {string} message - Prompt text.
 */
async function runPromptSequence(id, message) {
  const msg = (message || '').toLowerCase();

  if (msg.includes('crash')) {
    // Write a malformed line then exit non-zero.
    process.stdout.write('{INVALID JSON\n');
    process.exit(2);
    return;
  }

  if (msg.includes('streams_text')) {
    // Simple text streaming: two deltas then agent_end.
    emit({ type: 'message_update', event: { type: 'text_delta', delta: 'Hello, ' } });
    emit({ type: 'message_update', event: { type: 'text_delta', delta: 'world!' } });
    emit({ type: 'agent_end', usage: fakeUsage() });
  } else if (msg.includes('tool_call')) {
    // Tool call lifecycle.
    emit({ type: 'message_update', event: { type: 'text_delta', delta: 'Looking up... ' } });
    emit({ type: 'message_update', event: { type: 'toolcall_start', tool_id: 'T1', tool_name: 'read_messages' } });
    emit({ type: 'message_update', event: { type: 'toolcall_input', tool_id: 'T1', input: { q: 'latest' } } });
    emit({ type: 'message_update', event: { type: 'toolcall_result', tool_id: 'T1', result: 'ok' } });
    emit({ type: 'message_update', event: { type: 'text_delta', delta: 'done.' } });
    emit({ type: 'agent_end', usage: fakeUsage() });
  } else if (msg.includes('subagent')) {
    // Subagent lifecycle.
    emit({ type: 'subagent_start', subagent_id: 'SA1', agent_name: 'sub-worker', task_preview: 'doing work' });
    emit({ type: 'subagent_update', subagent_id: 'SA1', agent_name: 'sub-worker', status: 'in_progress' });
    emit({ type: 'subagent_done', subagent_id: 'SA1', agent_name: 'sub-worker', result_preview: 'done', duration_secs: 0.5 });
    emit({ type: 'message_update', event: { type: 'text_delta', delta: 'summary' } });
    emit({ type: 'agent_end', usage: fakeUsage() });
  } else {
    // Default: single ack delta.
    emit({ type: 'message_update', event: { type: 'text_delta', delta: 'ack' } });
    emit({ type: 'agent_end', usage: fakeUsage() });
  }

  // Emit a correlated response so SynapsRpc's pending promise resolves.
  emit({ type: 'response', id, command: 'prompt', ok: true });
}

function fakeUsage() {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    model,
  };
}

// ── stdin command dispatch ────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let cmd;
  try {
    cmd = JSON.parse(trimmed);
  } catch {
    // Malformed inbound — ignore.
    return;
  }

  const { type, id } = cmd;

  switch (type) {
    case 'prompt':
    case 'follow_up':
      // Run async but don't await — keep reading stdin.
      runPromptSequence(id, cmd.message || '').catch(() => {});
      break;

    case 'set_model': {
      const newModel = cmd.model ?? model;
      model = newModel;
      emit({ type: 'response', id, command: 'set_model', ok: true, model: newModel });
      break;
    }

    case 'get_state':
      emit({ type: 'response', id, command: 'get_state', ok: true, state: { session_id: SESSION_ID, model } });
      break;

    case 'abort':
      emit({ type: 'response', id, command: 'abort', ok: true });
      break;

    case 'get_session_stats':
      emit({ type: 'response', id, command: 'get_session_stats', ok: true, stats: {} });
      break;

    case 'get_messages':
      emit({ type: 'response', id, command: 'get_messages', ok: true, messages: [] });
      break;

    case 'get_available_models':
      emit({ type: 'response', id, command: 'get_available_models', ok: true, models: [model] });
      break;

    case 'compact':
      emit({ type: 'response', id, command: 'compact', ok: true });
      break;

    case 'new_session':
      emit({ type: 'response', id, command: 'new_session', ok: true });
      break;

    case 'shutdown':
      // No response — graceful exit.
      process.exit(0);
      break;

    default:
      if (id) {
        emit({ type: 'error', id, message: `unknown command type: ${type}` });
      }
  }
});

// Graceful exit on stdin EOF.
rl.on('close', () => {
  process.exit(0);
});
