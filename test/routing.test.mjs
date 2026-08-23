import assert from 'node:assert/strict';
import test from 'node:test';

import { chapterRoute, parseChapterRoute } from '../js/routing.mjs';

test('parses a chapter id', () => {
  assert.equal(parseChapterRoute('#/chapter/42'), 42);
});

test('chapter 0 is the front matter, not a missing route', () => {
  // A truthiness check here would drop the front matter — the bug this test exists for.
  assert.equal(parseChapterRoute('#/chapter/0'), 0);
  assert.notEqual(parseChapterRoute('#/chapter/0'), null);
});

test('returns null for anything that is not a chapter route', () => {
  for (const hash of ['', '#', '#/', '#/chapter', '#/chapter/', '#/chapter/x', '#/chapter/-1', '#/chapter/1/2', '#/about']) {
    assert.equal(parseChapterRoute(hash), null, `expected null for ${JSON.stringify(hash)}`);
  }
});

test('survives a missing hash', () => {
  assert.equal(parseChapterRoute(undefined), null);
  assert.equal(parseChapterRoute(null), null);
});

test('round-trips through the route builder', () => {
  for (const id of [0, 1, 365]) {
    assert.equal(parseChapterRoute(chapterRoute(id)), id);
  }
});
