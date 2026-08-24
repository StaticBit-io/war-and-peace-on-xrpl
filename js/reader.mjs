/**
 * Turns a chapter entry from the index into text, by fetching the transactions
 * that carry it and trimming the joined payload down to the chapter's byte range.
 */
import { readChapterChunks } from './chunks.mjs';
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
 * @param {string} account the account holding the book
 * @param {import('./ledger.mjs').LedgerClient} client
 * @param {number} chunkSize payload bytes per transaction
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function readChapter(chapter, account, client, chunkSize, onProgress) {
  const { chunks, sources, requests } = await readChapterChunks(client, account, chapter, onProgress);

  const bytes = assembleRange(chunks, chapter.byteStart, chapter.byteEnd, chunkSize);

  const digest = await sha256Hex(bytes);

  return {
    text: decoder.decode(bytes),
    bytes,
    digest,
    verified: digest === chapter.sha256,
    requests,
    sources: sources.map((source, i) => ({
      ...source,
      hex: [...chunks[i]].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(''),
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
