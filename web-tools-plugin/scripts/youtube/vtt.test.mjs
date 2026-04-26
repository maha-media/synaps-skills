// vtt.test.mjs — unit tests for the VTT parser used by transcript.js
// Run: node --test web-tools-plugin/scripts/youtube/vtt.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVTT, formatTimestamp } from './vtt.mjs';

test('formatTimestamp under one hour produces m:ss', () => {
  assert.equal(formatTimestamp('00:00:07.954'), '0:07');
  assert.equal(formatTimestamp('00:01:23.456'), '1:23');
  assert.equal(formatTimestamp('00:59:59.999'), '59:59');
});

test('formatTimestamp at one hour or more produces h:mm:ss', () => {
  assert.equal(formatTimestamp('01:00:00.000'), '1:00:00');
  assert.equal(formatTimestamp('02:34:56.000'), '2:34:56');
});

test('formatTimestamp tolerates missing milliseconds', () => {
  assert.equal(formatTimestamp('00:01:23'), '1:23');
  assert.equal(formatTimestamp('01:01:23'), '1:01:23');
});

test('parseVTT returns empty list for empty input', () => {
  assert.deepEqual(parseVTT(''), []);
  assert.deepEqual(parseVTT('WEBVTT\n\n'), []);
});

test('parseVTT extracts a single cue', () => {
  const raw = [
    'WEBVTT',
    '',
    '00:00:00.451 --> 00:00:03.618',
    '(audience applauding)',
    '',
  ].join('\n');
  assert.deepEqual(parseVTT(raw), [
    { time: '0:00', text: '(audience applauding)' },
  ]);
});

test('parseVTT joins multi-line cue text with a space', () => {
  const raw = [
    'WEBVTT',
    '',
    '00:00:18.450 --> 00:00:20.820',
    'is that you have been working in AI',
    'for a very long time',
    '',
  ].join('\n');
  assert.deepEqual(parseVTT(raw), [
    { time: '0:18', text: 'is that you have been working in AI for a very long time' },
  ]);
});

test('parseVTT strips inline VTT tags like <c> and <00:00:01.000>', () => {
  const raw = [
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:03.000',
    '<c>Hello</c> <00:00:02.000><c> world</c>',
    '',
  ].join('\n');
  assert.deepEqual(parseVTT(raw), [
    { time: '0:01', text: 'Hello world' },
  ]);
});

test('parseVTT collapses consecutive duplicate cues (auto-caption rolling display)', () => {
  // YouTube auto-captions emit each line ~3 times as the display rolls.
  const raw = [
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:03.000',
    'and so I said',
    '',
    '00:00:02.500 --> 00:00:04.500',
    'and so I said',
    '',
    '00:00:04.500 --> 00:00:06.000',
    'and so I said',
    '',
    '00:00:06.000 --> 00:00:08.000',
    'we are going somewhere new',
    '',
  ].join('\n');
  assert.deepEqual(parseVTT(raw), [
    { time: '0:01', text: 'and so I said' },
    { time: '0:06', text: 'we are going somewhere new' },
  ]);
});

test('parseVTT skips cue index numbers if present', () => {
  // Some VTT producers prefix each cue with a numeric index.
  const raw = [
    'WEBVTT',
    '',
    '1',
    '00:00:01.000 --> 00:00:03.000',
    'first',
    '',
    '2',
    '00:00:04.000 --> 00:00:06.000',
    'second',
    '',
  ].join('\n');
  assert.deepEqual(parseVTT(raw), [
    { time: '0:01', text: 'first' },
    { time: '0:04', text: 'second' },
  ]);
});

test('parseVTT skips NOTE blocks and STYLE blocks', () => {
  const raw = [
    'WEBVTT',
    '',
    'NOTE this file was machine generated',
    '',
    'STYLE',
    '::cue { color: white }',
    '',
    '00:00:01.000 --> 00:00:03.000',
    'real cue',
    '',
  ].join('\n');
  assert.deepEqual(parseVTT(raw), [
    { time: '0:01', text: 'real cue' },
  ]);
});

test('parseVTT ignores cues whose text reduces to empty after tag stripping', () => {
  const raw = [
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:03.000',
    '<c></c>',
    '',
    '00:00:04.000 --> 00:00:06.000',
    'kept',
    '',
  ].join('\n');
  assert.deepEqual(parseVTT(raw), [
    { time: '0:04', text: 'kept' },
  ]);
});
