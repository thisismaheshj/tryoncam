import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

/**
 * Regression cover for a real failure: the camera constraints were built by
 * wrapping a Decart model's `fps`, which is ALREADY a MediaTrackConstraint
 * (`{ ideal: 30, max: 30 }`). That produced `{ ideal: { ideal: 30 } }`, which
 * Chrome rejects as a non-finite double — throwing *before* it prompts, so the
 * camera appeared to do nothing and no permission dialog ever appeared.
 *
 * This asserts against the widget the extension actually ships, rather than a
 * helper module nothing imports any more.
 */
const WIDGET = readFileSync(path.resolve(process.cwd(), 'extension/widget.js'), 'utf8');

function getUserMediaCall(): string {
  const start = WIDGET.indexOf('getUserMedia(');
  assert.notEqual(start, -1, 'the widget must request the camera');
  // Balance braces from the call site to capture the whole constraint object.
  let depth = 0;
  for (let i = start; i < WIDGET.length; i += 1) {
    if (WIDGET[i] === '(') depth += 1;
    if (WIDGET[i] === ')') {
      depth -= 1;
      if (depth === 0) return WIDGET.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced getUserMedia call');
}

describe('extension camera constraints', () => {
  const call = getUserMediaCall();

  test('never nests a constraint inside a constraint', () => {
    // `{ ideal: { … } }` or `{ ideal: model.fps }` are both the bug.
    assert.equal(/ideal:\s*\{/.test(call), false, 'a constraint value must not be an object literal');
    assert.equal(
      /(?:frameRate|width|height):\s*(?:model|spec)\.\w+/.test(call.replace(/\{\s*ideal:[^}]*\}/g, '')),
      false,
      'a model field must not be used as a bare constraint value without review',
    );
  });

  test('requests explicit numeric dimensions', () => {
    assert.match(call, /width:\s*\{\s*ideal:\s*\d+/, 'width should be an explicit ideal');
    assert.match(call, /height:\s*\{\s*ideal:\s*\d+/, 'height should be an explicit ideal');
  });

  test('never requests the microphone', () => {
    assert.match(call, /audio:\s*false/, 'try-on has no use for the microphone');
  });

  test('asks for the front camera', () => {
    assert.match(call, /facingMode:\s*'user'/);
  });
});
