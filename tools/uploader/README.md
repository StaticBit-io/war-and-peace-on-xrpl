# Uploader

The tool that put the book into the ledger. Kept here so the write side of the experiment is as
inspectable as the read side.

It cuts a file into 1,019-byte chunks, signs one `AccountSet` transaction per chunk locally, submits
them over a single WebSocket connection, then reads everything back through `account_tx` and checks
the result against the source byte for byte. The run dataset it writes — transaction hashes, ledger
numbers, fees, per-ledger statistics — is what `tools/build-index.mjs` turns into the site's index.

## Why AccountSet

An `AccountSet` with no fields set changes nothing about the account. It is the cheapest way to get
a memo into the ledger: one signature to verify, one `AccountRoot` to touch, and the smallest
metadata of any transaction type. A `Payment` would work equally well for carrying data but writes
roughly twice the metadata.

## Why 1,019 bytes

rippled caps the whole serialized `Memos` array at 1024 bytes. With a lone `MemoData` field the
serialization overhead is 5 bytes, leaving 1,019. Adding a `MemoType` tag eats into that: an
11-byte tag pushes the array over the cap and the transaction is rejected with `fails local checks`
before it ever reaches a validator.

## Chunk order

Nothing encodes the order of the chunks. Chunk *i* is sent as sequence `startSequence + i`, and the
account's sequence numbers are strictly ordered by the protocol, so reading transactions in sequence
order reproduces the file. This is why the tool refuses to resume without its state file: a restart
under a fresh sequence would break that mapping while looking perfectly healthy.

## Usage

```powershell
# 1. create a wallet — the seed goes to a file, only the address is printed
dotnet run -c Release -- --new-wallet "C:\keys\book.seed"

# 2. fund that address (1 XRP reserve + fees), then upload
$env:XRPL_SEED = Get-Content "C:\keys\book.seed"
dotnet run -c Release -- --file book.txt --out run --network mainnet --max-fee 50 --budget-xrp 0.5 --yes
```

```bash
# same thing from a POSIX shell
XRPL_SEED=$(cat /keys/book.seed) dotnet run -c Release -- \
  --file book.txt --out run --network mainnet --max-fee 50 --budget-xrp 0.5 --yes
```

## Flags

| flag | meaning |
|---|---|
| `--file` | file to upload (required) |
| `--out` | directory for the dataset and state file (default `.`) |
| `--network` | `testnet` or `mainnet` (default `testnet`) |
| `--seed-env` | environment variable holding the seed (default `XRPL_SEED`) |
| `--new-wallet <path>` | generate a wallet, write the seed to `<path>`, print only the address |
| `--limit` | upload only the first N chunks — useful for a rehearsal |
| `--batch` | chunks per burst before re-checking network load (default 40) |
| `--max-fee` | ceiling on the per-transaction fee in drops (default 50) |
| `--budget-xrp` | refuse to start if the worst case exceeds this (default 1.0) |
| `--dry-run` | print the cost estimate and exit |
| `--yes` | required to write to a live network |
| `--resume` | continue an interrupted run using `run-state.json` |

On testnet, omitting the seed asks the faucet for a funded wallet. On mainnet that is an error —
a live account has to be funded deliberately.

## What it writes to `--out`

| file | content |
|---|---|
| `run-dataset.json` | the whole run: transaction hashes, ledgers, fees, per-ledger statistics, verification result — this is what `build-index.mjs` consumes |
| `transactions.csv` | one row per transaction: sequence, hash, ledger, fee, payload size, explorer URL |
| `ledgers.csv` | one row per ledger: our transactions, total transactions, our share, close time |
| `fee_samples.csv` | network load sampled before each burst: open-ledger fee, queue size, ledger size |
| `rebuilt-from-ledger.txt` | the file as read back out of the ledger, for an external diff |
| `run-state.json` | start sequence and source digest, needed by `--resume` |
| `wallet.txt` | written only when the faucet created the wallet (testnet) |

## Safety rails

- The seed is read from an environment variable, never from an argument, so it does not land in
  shell history.
- Writing to a live network needs `--yes`; the worst-case cost is printed before anything is sent.
- The run aborts if the balance would not survive the worst case plus the 1 XRP account reserve.
- `--resume` refuses to continue if the source file changed since the interrupted run.
- Reading back is filtered to this run's sequence range, so an account with prior history does not
  contaminate the rebuilt file.

## Building

Needs .NET 10 and the `Xrpl` package from NuGet. If you are working against a modified SDK, swap the
`PackageReference` for a `ProjectReference` to your local `Xrpl.csproj`.
