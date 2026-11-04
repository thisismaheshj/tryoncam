import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

/**
 * Guards against the failure that silently disabled the extension: a `const`
 * arrow function called earlier in the file than it is declared.
 *
 * `const` is not hoisted, so that throws a ReferenceError at load — which in a
 * content script means the message listener never registers and every page
 * reports "not available", with nothing in the page console to explain it.
 * `node --check` passes such a file happily, because the syntax is valid.
 */

const ROOT = path.resolve(process.cwd(), 'extension');

function readScript(name: string): string[] {
  return readFileSync(path.join(ROOT, name), 'utf8').split('\n');
}

/** Strips comments and strings so their contents never count as a usage. */
function stripNoise(line: string): string {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** Indentation of a line, used as a cheap stand-in for scope depth. */
function indent(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Only the outermost scope is checked — the file body and the single wrapping
 * IIFE, i.e. indentation of 0 or 2.
 *
 * A deeper binding is a function local: it is declared and used within the
 * same call, so ordering across the file says nothing about it. Checking those
 * produced only false positives (`overlay`, `push` — distinct locals that
 * happen to share a name with something declared later).
 */
const OUTER = 2;

function useBeforeDeclare(lines: string[]): string[] {
  const problems: string[] = [];
  const declared = new Map<string, number>();

  lines.forEach((raw, index) => {
    const line = stripNoise(raw);
    if (indent(line) > OUTER) return;
    const match = line.match(/^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (match?.[1] && !declared.has(match[1])) declared.set(match[1], index);
  });

  for (const [name, declaredAt] of declared) {
    const called = new RegExp(`\\b${name}\\s*\\(`);
    for (let i = 0; i < declaredAt; i += 1) {
      const line = stripNoise(lines[i] ?? '');
      // Only a statement in the same outer scope runs at load time.
      if (indent(line) > OUTER) continue;
      if (/^\s*(?:function|async function)\s/.test(line)) continue;
      if (called.test(line) && !/^\s*(?:const|let|var)\s/.test(line)) {
        problems.push(`"${name}" is called on line ${i + 1} but declared on line ${declaredAt + 1}`);
        break;
      }
    }
  }
  return problems;
}

describe('extension scripts initialise in order', () => {
  for (const file of ['content.js', 'detector.js', 'background.js', 'popup.js']) {
    test(`${file} has no const used before its declaration`, () => {
      assert.deepEqual(useBeforeDeclare(readScript(file)), []);
    });
  }

  test('the content script registers a message listener unconditionally', () => {
    const source = readScript('content.js').join('\n');
    assert.ok(
      source.includes('chrome.runtime.onMessage.addListener'),
      'the toolbar menu talks to the page through this listener',
    );
    // An early return above the listener is what made every page report
    // "not available on this page".
    const listenerAt = source.indexOf('chrome.runtime.onMessage.addListener');
    const guard = source.slice(0, listenerAt).match(/^\s*if \(![\w.]+\(\)\) return;/m);
    assert.equal(guard, null, 'no early return may sit above the listener registration');
  });
});
