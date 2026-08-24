/**
 * Reads the transactions of one chapter, in as few requests as the node allows.
 *
 * The first version asked for one transaction per hash: a nine-transaction chapter cost nine
 * messages, and a public node allows roughly a thousand a minute. Reading a few chapters in a
 * row was enough to be told "You are placing too much load on the server".
 *
 * account_tx returns up to 400 transactions per message. Every chapter carries the ledger and
 * sequence where it starts, so a chapter is fetched by asking for that stretch of the account's
 * history — usually a single request — instead of paging the book from the beginning.
 */

/** A node returns at most this many transactions per account_tx call. */
const MAX_BATCH = 400;

/**
 * @param {import('./ledger.mjs').LedgerClient} client
 * @param {string} account the account holding the book
 * @param {{firstChunk: number, lastChunk: number, firstLedger: number, firstSequence: number}} chapter
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{chunks: Uint8Array[], sources: {index: number, hash: string, ledger: number}[], requests: number}>}
 */
export async function readChapterChunks(client, account, chapter, onProgress) {
  const needed = chapter.lastChunk - chapter.firstChunk + 1;

  const chunks = [];
  const sources = [];
  let marker = null;
  let requests = 0;

  while (chunks.length < needed) {
    const page = await client.accountBatch({
      account,
      // Start at the ledger this chapter opens in. Earlier chapters are simply not asked for.
      ledgerIndexMin: chapter.firstLedger,
      limit: Math.min(MAX_BATCH, Math.max(needed - chunks.length, 20)),
      marker,
    });
    requests += 1;

    for (const entry of page.entries) {
      // A ledger holds several transactions, so the first page starts a little before the
      // chapter does. Sequence numbers are strictly ordered, which makes the cut exact.
      if (entry.sequence !== undefined && entry.sequence < chapter.firstSequence) continue;
      if (chunks.length >= needed) break;

      chunks.push(entry.bytes);
      sources.push({ index: chapter.firstChunk + sources.length, hash: entry.hash, ledger: entry.ledger });
    }

    onProgress?.(chunks.length, needed);

    marker = page.marker;
    if (!marker) break;
  }

  if (chunks.length < needed) {
    throw new Error(`the ledger returned ${chunks.length} of ${needed} transactions for this chapter`);
  }
  return { chunks, sources, requests };
}
