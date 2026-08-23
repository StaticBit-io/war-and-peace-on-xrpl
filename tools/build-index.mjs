/**
 * Builds the ledger index for the reader.
 *
 * This is the only script that ever touches the book text. It emits a map —
 * chapter offsets, transaction hashes, checksums — and never the text itself.
 * The site reconstructs every character from XRPL transactions at read time.
 *
 * Usage:
 *   node tools/build-index.mjs <book.txt> <run-dataset.json> [outDir]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chunkRangeFor } from '../js/offsets.mjs';

const [, , bookPath, datasetPath, outDir = 'data'] = process.argv;

if (!bookPath || !datasetPath) {
  console.error('usage: node tools/build-index.mjs <book.txt> <run-dataset.json> [outDir]');
  process.exit(1);
}

const book = readFileSync(bookPath);
const run = JSON.parse(readFileSync(datasetPath, 'utf8'));

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex').toUpperCase();

/**
 * Latin-1 keeps one byte per character, so string offsets are byte offsets.
 * The headings are pure ASCII, so matching against this view is exact.
 */
const scan = book.toString('latin1');

const BOOK_HEADING = /^[ \t]*(BOOK [A-Z]+(?:: [^\n]*)?|FIRST EPILOGUE[^\n]*|SECOND EPILOGUE[^\n]*)[ \t]*$/gm;
const CHAPTER_HEADING = /^[ \t]*(CHAPTER [IVXLC]+)[ \t]*$/gm;

/** The table of contents repeats every heading; the body starts at the second "BOOK ONE". */
function findBodyStart() {
  const first = scan.indexOf('BOOK ONE');
  const second = scan.indexOf('BOOK ONE', first + 1);
  if (second < 0) throw new Error('cannot locate body start: "BOOK ONE" appears only once');
  return second;
}

function collect(regex, from) {
  const found = [];
  regex.lastIndex = 0;
  for (const match of scan.matchAll(regex)) {
    if (match.index >= from) found.push({ offset: match.index, title: match[1].trim() });
  }
  return found;
}

const bodyStart = findBodyStart();
const books = collect(BOOK_HEADING, bodyStart);
const chapterHeads = collect(CHAPTER_HEADING, bodyStart);

if (books.length === 0 || chapterHeads.length === 0) {
  throw new Error(`heading scan failed: ${books.length} books, ${chapterHeads.length} chapters`);
}

/**
 * A chapter ends at the next chapter or book heading, whichever comes first, and starts
 * where the previous one ended. A book heading sitting between two chapters therefore
 * opens the chapter that follows it, which is also how it reads on the page.
 */
const boundaries = [...chapterHeads.map((c) => c.offset), ...books.map((b) => b.offset), book.length]
  .sort((a, b) => a - b);

const bookTitleAt = (offset) => {
  let title = books[0].title;
  for (const b of books) {
    if (b.offset <= offset) title = b.title;
    else break;
  }
  return title;
};

const chunkSize = run.ChunkSize;

function entry(id, bookTitle, title, start, end) {
  const slice = book.subarray(start, end);
  const { firstChunk, lastChunk } = chunkRangeFor(start, end, chunkSize);
  return {
    id,
    book: bookTitle,
    title,
    byteStart: start,
    byteEnd: end,
    byteLength: end - start,
    firstChunk,
    lastChunk,
    sha256: sha256(slice),
    words: slice.toString('utf8').split(/\s+/).filter(Boolean).length,
  };
}

// Front matter — title page and table of contents — is in the ledger too, so it gets an entry.
const frontMatterEnd = chapterHeads[0].offset;
const chapters = [entry(0, 'Front matter', 'Title & Contents', 0, frontMatterEnd)];

let cursor = frontMatterEnd;
chapterHeads.forEach((head, i) => {
  // Start where the previous entry ended so a book heading in between opens this chapter.
  const start = cursor;
  const end = boundaries.find((b) => b > head.offset) ?? book.length;
  chapters.push(entry(i + 1, bookTitleAt(head.offset), head.title, start, end));
  cursor = end;
});

const hashes = run.Transactions
  .slice()
  .sort((a, b) => a.Sequence - b.Sequence)
  .map((t) => t.Hash);

if (hashes.length !== run.ChunksApplied) {
  throw new Error(`hash count ${hashes.length} does not match ChunksApplied ${run.ChunksApplied}`);
}

const ledgers = run.Ledgers.map((l) => ({
  ledger: l.Ledger,
  ourTx: l.OurTxCount,
  totalTx: l.TotalTxCount,
  sharePercent: l.OurSharePercent,
  closeTime: l.CloseTimeIso,
}));

const networkKey = run.Network.toLowerCase().includes('test') ? 'testnet' : 'mainnet';

/** Public nodes the reader may query, most complete history first. */
const ENDPOINTS = {
  testnet: ['wss://s.altnet.rippletest.net:51233', 'wss://testnet.xrpl-labs.com'],
  mainnet: ['wss://xrplcluster.com', 'wss://s2.ripple.com', 'wss://s1.ripple.com'],
};

const manifest = {
  network: run.Network,
  networkKey,
  endpoints: ENDPOINTS[networkKey],
  explorer: run.Explorer,
  account: run.Account,
  accountUrl: run.AccountUrl,
  book: {
    title: 'War and Peace',
    author: 'Leo Tolstoy',
    translation: 'Louise and Aylmer Maude',
    source: 'Project Gutenberg ebook #2600',
    bytes: run.SourceBytes,
    sha256: run.SourceSha256,
    chapters: chapters.length,
    books: books.length,
    frontMatterBytes: frontMatterEnd,
  },
  ledger: {
    chunkSize,
    transactions: run.ChunksApplied,
    startSequence: run.StartSequence,
    firstLedger: run.FirstLedger,
    lastLedger: run.LastLedger,
    ledgersUsed: run.LedgersUsed,
    payloadBytesPerTx: chunkSize,
    bytesInLedgerPerTx: 1323.1,
    feeDropsPerTx: run.FeeAvgDrops,
    feeBurnedDrops: run.FeeBurnedDrops,
    feeBurnedXrp: run.FeeBurnedXrp,
    submitMinutes: run.SubmitMinutes,
    readBackSeconds: run.ReadBackSeconds,
    firstCloseTime: ledgers[0]?.closeTime ?? null,
    lastCloseTime: ledgers.at(-1)?.closeTime ?? null,
  },
  verification: {
    rebuiltBytes: run.RebuiltBytes,
    rebuiltSha256: run.RebuiltSha256,
    byteForByteMatch: run.ByteForByteMatch,
  },
  generatedFrom: datasetPath.split(/[\\/]/).pop(),
};

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(join(outDir, 'chapters.json'), JSON.stringify(chapters));
writeFileSync(join(outDir, 'tx-hashes.json'), JSON.stringify(hashes));
writeFileSync(join(outDir, 'ledgers.json'), JSON.stringify(ledgers));

// Sanity: the entries must tile the whole book with no gaps and no overlaps.
let covered = 0;
for (const c of chapters) {
  if (c.byteStart !== covered) throw new Error(`gap before entry ${c.id}: ${covered} != ${c.byteStart}`);
  covered = c.byteEnd;
}
if (covered !== book.length) throw new Error(`entries end at ${covered}, book is ${book.length}`);

console.log(`entries  : ${chapters.length} (front matter + ${chapters.length - 1} chapters) across ${books.length} books/epilogues`);
console.log(`hashes   : ${hashes.length}`);
console.log(`coverage : ${covered} B tiled with no gaps (book is ${book.length} B) OK`);
console.log(`chunks   : median ${median(chapters.map((c) => c.lastChunk - c.firstChunk + 1))} per chapter, max ${Math.max(...chapters.map((c) => c.lastChunk - c.firstChunk + 1))}`);

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
