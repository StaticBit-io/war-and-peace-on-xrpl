/**
 * Turns a chapter entry from the index into text, by fetching the transactions
 * that carry it and trimming the joined payload down to the chapter's byte range.
 */
import { assembleRange } from './offsets.mjs';

const decoder = new TextDecoder('utf-8', { fatal: false });

/** SHA-256 of a byte array, uppercase hex — matches the digests in the index. */
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/**
 * Rebuilds one chapter straight from the ledger.
 *
 * @param {object} chapter entry from chapters.json
 * @param {string[]} hashes all transaction hashes, ordered by account sequence
 * @param {import('./ledger.mjs').LedgerClient} client
 * @param {number} chunkSize payload bytes per transaction
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function readChapter(chapter, hashes, client, chunkSize, onProgress) {
  const wanted = hashes.slice(chapter.firstChunk, chapter.lastChunk + 1);
  if (wanted.length !== chapter.lastChunk - chapter.firstChunk + 1) {
    throw new Error(`index is short: chapter ${chapter.id} needs chunks ${chapter.firstChunk}..${chapter.lastChunk}`);
  }

  const chunks = await client.fetchChunks(wanted, onProgress);
  const bytes = assembleRange(
    chunks.map((c) => c.bytes),
    chapter.byteStart,
    chapter.byteEnd,
    chunkSize,
  );

  const digest = await sha256Hex(bytes);

  return {
    text: decoder.decode(bytes),
    bytes,
    digest,
    verified: digest === chapter.sha256,
    sources: chunks.map((chunk, i) => ({
      index: chapter.firstChunk + i,
      hash: wanted[i],
      hex: chunk.hex,
      tx: chunk.tx,
      ledger: chunk.tx.ledger_index,
    })),
  };
}

/**
 * Splits chapter text into a heading and paragraphs for rendering.
 * Gutenberg's plain text separates paragraphs with a blank line.
 */
export function layout(text) {
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const headings = [];
  while (blocks.length && /^(BOOK [A-Z]+|FIRST EPILOGUE|SECOND EPILOGUE|CHAPTER [IVXLC]+)/.test(blocks[0])) {
    headings.push(blocks.shift());
  }
  return { headings, paragraphs: blocks };
}
