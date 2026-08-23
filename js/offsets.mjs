/**
 * Byte-offset arithmetic shared by the index builder and the reader.
 *
 * The book was cut into fixed-size chunks, one per transaction, with no regard
 * for chapter boundaries. A chapter therefore starts and ends mid-chunk, and
 * rebuilding it means fetching a run of transactions and trimming both ends.
 */

/**
 * Which chunks cover the byte range [byteStart, byteEnd)?
 *
 * @param {number} byteStart inclusive start offset in the book
 * @param {number} byteEnd exclusive end offset in the book
 * @param {number} chunkSize payload bytes per transaction
 * @returns {{firstChunk: number, lastChunk: number}} inclusive chunk indices
 */
export function chunkRangeFor(byteStart, byteEnd, chunkSize) {
  if (!Number.isInteger(byteStart) || byteStart < 0) throw new RangeError(`byteStart must be a non-negative integer, got ${byteStart}`);
  if (!Number.isInteger(byteEnd) || byteEnd <= byteStart) throw new RangeError(`byteEnd (${byteEnd}) must be greater than byteStart (${byteStart})`);
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new RangeError(`chunkSize must be a positive integer, got ${chunkSize}`);

  return {
    firstChunk: Math.floor(byteStart / chunkSize),
    lastChunk: Math.floor((byteEnd - 1) / chunkSize),
  };
}

/**
 * Where does the wanted range sit inside the concatenated chunks?
 *
 * @returns {{sliceStart: number, sliceEnd: number}} offsets into the joined buffer
 */
export function sliceWithinChunks(byteStart, byteEnd, chunkSize) {
  const { firstChunk } = chunkRangeFor(byteStart, byteEnd, chunkSize);
  const base = firstChunk * chunkSize;
  return { sliceStart: byteStart - base, sliceEnd: byteEnd - base };
}

/**
 * Joins chunk payloads and trims them down to the requested byte range.
 *
 * @param {Uint8Array[]} chunks payloads for firstChunk..lastChunk, in order
 * @param {number} byteStart inclusive start offset in the book
 * @param {number} byteEnd exclusive end offset in the book
 * @param {number} chunkSize payload bytes per transaction
 * @returns {Uint8Array} exactly the bytes of the requested range
 */
export function assembleRange(chunks, byteStart, byteEnd, chunkSize) {
  const { sliceStart, sliceEnd } = sliceWithinChunks(byteStart, byteEnd, chunkSize);

  let total = 0;
  for (const chunk of chunks) total += chunk.length;

  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }

  if (sliceEnd > joined.length) {
    throw new RangeError(`need ${sliceEnd} bytes but only ${joined.length} were fetched — a chunk is missing`);
  }
  return joined.subarray(sliceStart, sliceEnd);
}

/** Decodes an XRPL hex blob (MemoData) into raw bytes. */
export function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error(`hex string has odd length ${hex.length}`);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex at position ${i * 2}`);
    bytes[i] = byte;
  }
  return bytes;
}
