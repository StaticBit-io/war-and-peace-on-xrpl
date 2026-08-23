# Design — War and Peace on the XRP Ledger

Date: 2026-08-23

## Goal

A static site that reads *War and Peace* out of XRPL transaction memos, chapter by chapter, and
proves as it goes that the text came from the ledger untouched. The site must be convincing to a
skeptic: if it quietly served a cached copy of the book, the demonstration would be worthless.

## Constraints that shaped it

- **A memo holds 1024 serialized bytes**, so the book is spread over 3,278 transactions of 1,019
  payload bytes each. Chunk boundaries fall wherever they fall — mid-word, mid-sentence.
- **Public nodes differ in history depth.** A node may not hold a transaction from months ago, and
  `tx` will answer `txNotFound`.
- **GitHub Pages serves static files only.** No server-side code, no build step required.
- **Test networks get reset.** The data backing the site is not permanent.

## Decisions

### The repository stores a map, never the text

`data/` holds chapter byte ranges, transaction hashes, and SHA-256 digests. It does not hold a
single sentence of the book. This is the decision the whole design rests on: it makes "the text
comes from the ledger" verifiable rather than a claim.

The alternative — paging `account_tx` from the beginning with no index — was rejected because
jumping to a late chapter would mean walking the entire pagination, tens of requests deep.
The index costs 300 KB and buys direct access to any chapter in one round of parallel `tx` calls.

### A page is a chapter

365 chapters plus front matter. A chapter is a unit a reader recognizes, it carries a natural
table of contents, and at a median of 9 transactions it fetches in well under a second. Fixed-size
pages were rejected: they would cut mid-sentence, which reads as a bug even when it is not.

### Chunk arithmetic is a separate, tested module

`js/offsets.mjs` holds every calculation that maps byte ranges to chunk indices and back. It is
pure, has no DOM or network dependency, and is shared by the browser and the index builder — the
same code decides the ranges at build time and at read time, so the two cannot drift.

This is where a silent bug would be worst: an off-by-one in the trim produces text that looks
plausible and is wrong. Hence the boundary tests in `test/offsets.test.mjs`.

### Failures are loud

`assembleRange` throws when the fetched chunks cannot cover the requested range, rather than
returning a short buffer. The reader catches it and shows what failed with a retry button. A
partially-loaded chapter must never be presented as the chapter.

`LedgerClient` rotates through the endpoints in the manifest when a node cannot serve a request,
and reports which node it is talking to in the header — the reader can always see where the bytes
are coming from.

### Verification happens in the browser

After assembly, WebCrypto hashes the bytes and compares them against the digest in the index. The
badge says "verified against the index" only when the digest matches. Combined with the raw-data
toggle — which shows the hex exactly as it sits in `MemoData` — a visitor can follow the whole
path from transaction to rendered paragraph.

### Network is configuration, not code

Everything network-specific — name, WebSocket endpoints, explorer URL, account — lives in
`data/manifest.json`. Moving the site from testnet to mainnet is a matter of regenerating the
index from a different run dataset.

## Structure

```
index.html          shell: reader view + dashboard view
css/style.css       one stylesheet, light and dark
js/offsets.mjs      byte/chunk arithmetic (pure, tested, shared with the builder)
js/ledger.mjs       XRPL WebSocket client: tx by hash, endpoint rotation
js/reader.mjs       chapter assembly, SHA-256 verification, paragraph layout
js/app.mjs          state, routing, rendering
tools/build-index.mjs   generates data/ from the book and a run dataset
test/offsets.test.mjs   boundary tests for the arithmetic
```

## Data flow for one chapter

```
chapters.json[id] ──► byteStart, byteEnd, sha256
        │
        ├─► chunkRangeFor() ──► firstChunk..lastChunk
        │                             │
        │                             ▼
        │                     tx-hashes.json ──► hashes
        │                             │
        │                             ▼
        │                   LedgerClient.fetchChunks()  ──► parallel `tx` calls
        │                             │
        ▼                             ▼
    assembleRange(chunks, byteStart, byteEnd) ──► exact bytes
                                      │
                                      ├─► sha256Hex() ──► compare with index ──► badge
                                      └─► TextDecoder ──► paragraphs ──► DOM
```

## What was deliberately left out

- **Full-text search.** It would require a search index in the repository, which is a copy of the
  book by another name — exactly what this design refuses to store.
- **A build step.** Vanilla ES modules keep the deployed code identical to the source, which
  matters for a site whose claim is "look at what it actually requests".
- **Client-side caching of fetched chunks.** Considered and dropped for now: it makes the second
  read fast but muddies the demonstration, since the page could then show text without touching
  the network. Worth revisiting behind an explicit "offline copy" toggle.
