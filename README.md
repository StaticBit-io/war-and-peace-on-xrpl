# War and Peace on the XRP Ledger

The complete text of Tolstoy's *War and Peace* — 3,339,794 bytes — lives inside the memo fields of
3,278 XRPL transactions. This site reads it back, one chapter at a time, straight from the ledger.

**No copy of the book is stored here.** This repository holds only a map: chapter byte ranges,
transaction hashes and checksums. Every character you read is fetched from a public XRPL node at
read time and verified against a SHA-256 digest before it reaches the page.

## The numbers

| | |
|---|---|
| Book | 3,339,794 bytes (Maude translation, [Project Gutenberg #2600](https://www.gutenberg.org/ebooks/2600)) |
| Transactions | 3,278 `AccountSet`, 1,019 bytes of payload each |
| Ledgers | 378 |
| Fees burned | 0.039336 XRP |
| Time to write | 20.8 minutes |
| Time to read back | 7.4 seconds |
| Round trip | byte-for-byte identical to the source file |

## Why 1,019 bytes

rippled caps the entire serialized `Memos` array at 1024 bytes
([`STTx.cpp`](https://github.com/XRPLF/rippled/blob/develop/src/libxrpl/protocol/STTx.cpp), `isMemoOkay`).
With a single `MemoData` field and no `MemoType`/`MemoFormat`, 1,019 bytes of payload survive the
serialization overhead. Adding an 11-byte `MemoType` tag pushes the array past the cap and the
transaction is rejected with `fails local checks`.

A transaction occupies about 1,323 bytes in the ledger once metadata is counted — a 1.30× overhead
on the payload. The fee does not depend on any of this: 10 drops is the base cost of a transaction
regardless of its size.

## How a chapter is rebuilt

1. `data/chapters.json` gives the chapter's byte range in the book — not its text.
2. The range maps to a run of chunks: `floor(start / 1019)` through `floor((end - 1) / 1019)`.
3. `data/tx-hashes.json` turns those indices into transaction hashes.
4. The browser asks a public node for each transaction with the `tx` command, in parallel.
5. Payloads are concatenated and trimmed to the exact byte range.
6. WebCrypto hashes the result and compares it against the digest in the index.

The order of the chunks is not encoded anywhere: the account's `Sequence` already fixes it.

## Running locally

```bash
npx serve -l 4173 .
```

Then open <http://localhost:4173>. Any static file server works — there is no build step and no
dependencies.

## Tests

```bash
node --test test/offsets.test.mjs
```

The offset arithmetic is where a silent bug would corrupt the text, so it is tested against
boundary cases: ranges that start exactly on a chunk edge, ranges that end on one, truncated
fetches, and short final chunks.

## Rebuilding the index

The index is generated once from the book and the run dataset produced by the upload tool:

```bash
node tools/build-index.mjs path/to/book.txt path/to/run-dataset.json data
```

`build-index.mjs` is the only script that ever reads the book text. It verifies that the chapter
entries tile the whole file with no gaps or overlaps before writing anything.

## Data files

| file | what it holds |
|---|---|
| `data/manifest.json` | network, endpoints, account, book and run statistics |
| `data/chapters.json` | 366 entries: byte range, chunk range, SHA-256, word count |
| `data/tx-hashes.json` | 3,278 transaction hashes ordered by account sequence |
| `data/ledgers.json` | per-ledger transaction counts and close times |

## Pointing it at another network

The reader takes everything from `data/manifest.json` — network name, WebSocket endpoints and
explorer base URL. Re-running `build-index.mjs` against a dataset from a different network is
enough to move the site; no code changes are needed.

Note that public test networks are periodically reset. When that happens the transactions backing
this site disappear and the reader will say so rather than showing partial text.

## Licence

Site code: MIT. The book itself is in the public domain.
