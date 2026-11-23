import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDemo } from '../scripts/demo-e2e.ts';

test('first-delivery walkthrough over HTTP with two phones (demo catalog + in-memory sheet)', async () => {
  const lines: string[] = [];
  // Force demo mode so the test never depends on credentials or the network.
  const { failed, checks } = await runDemo({ PATH: process.env.PATH }, (s) => lines.push(s));
  assert.equal(failed, 0, lines.join('\n'));
  assert.ok(checks.length >= 15);
});
