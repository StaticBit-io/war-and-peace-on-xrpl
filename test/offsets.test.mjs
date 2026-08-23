import assert from 'node:assert/strict';
import test from 'node:test';

import { assembleRange, chunkRangeFor, hexToBytes, sliceWithinChunks } from '../js/offsets.mjs';

const CHUNK = 1019;

test('range inside a single chunk stays in that chunk', () => {
  assert.deepEqual(chunkRangeFor(10, 100, CHUNK), { firstChunk: 0, lastChunk: 0 });
});

test('range starting exactly on a chunk boundary starts that chunk', () => {
  assert.deepEqual(chunkRangeFor(CHUNK, CHUNK + 5, CHUNK), { firstChunk: 1, lastChunk: 1 });
});

test('range ending exactly on a chunk boundary does not pull in the next chunk', () => {
  // bytes [0, 1019) are entirely chunk 0 — byte 1019 belongs to chunk 1 and is excluded
  assert.deepEqual(chunkRangeFor(0, CHUNK, CHUNK), { firstChunk: 0, lastChunk: 0 });
});

test('range spanning several chunks covers every one of them', () => {
  assert.deepEqual(chunkRangeFor(CHUNK - 1, CHUNK * 3 + 1, CHUNK), { firstChunk: 0, lastChunk: 3 });
});

test('slice offsets are relative to the first fetched chunk', () => {
  assert.deepEqual(sliceWithinChunks(CHUNK + 7, CHUNK + 20, CHUNK), { sliceStart: 7, sliceEnd: 20 });
});

test('rejects impossible ranges instead of silently misreading', () => {
  assert.throws(() => chunkRangeFor(-1, 10, CHUNK), RangeError);
  assert.throws(() => chunkRangeFor(10, 10, CHUNK), RangeError);
  assert.throws(() => chunkRangeFor(10, 5, CHUNK), RangeError);
  assert.throws(() => chunkRangeFor(0, 10, 0), RangeError);
});

test('assembles the exact byte range out of joined chunks', () => {
  const size = 10;
  const book = Uint8Array.from({ length: size * 4 }, (_, i) => i);
  const chunks = [book.subarray(0, 10), book.subarray(10, 20), book.subarray(20, 30)];

  const got = assembleRange(chunks, 7, 23, size);

  assert.deepEqual([...got], [...book.subarray(7, 23)]);
});

test('assembling a truncated fetch fails loudly rather than returning short text', () => {
  const chunks = [new Uint8Array(10)];
  assert.throws(() => assembleRange(chunks, 5, 25, 10), /a chunk is missing/);
});

test('final chunk may be shorter than chunk size', () => {
  const chunks = [new Uint8Array([1, 2, 3, 4, 5]), new Uint8Array([6, 7])];
  const got = assembleRange(chunks, 1, 7, 5);
  assert.deepEqual([...got], [2, 3, 4, 5, 6, 7]);
});

test('hex decoding round-trips ASCII', () => {
  assert.equal(new TextDecoder().decode(hexToBytes('57415220414E442050454143 45'.replace(/ /g, ''))), 'WAR AND PEACE');
});

test('hex decoding rejects malformed input', () => {
  assert.throws(() => hexToBytes('ABC'), /odd length/);
  assert.throws(() => hexToBytes('ZZ'), /invalid hex/);
});
