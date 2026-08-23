using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Xrpl.Client;
using Xrpl.Models.Common;
using Xrpl.Models.Ledger;
using Xrpl.Models.Methods;
using Xrpl.Wallet;

namespace LedgerUploader;

internal static class Program
{
    private const int ChunkSize = 1019;

    private sealed record Network(string Name, string Ws, string Explorer);

    private static readonly Dictionary<string, Network> Networks = new(StringComparer.OrdinalIgnoreCase)
    {
        ["testnet"] = new("XRPL Testnet", "wss://s.altnet.rippletest.net:51233", "https://testnet.xrpl.org"),
        ["mainnet"] = new("XRPL Mainnet", "wss://xrplcluster.com", "https://livenet.xrpl.org"),
    };

    private static readonly JsonSerializerOptions JsonOut = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static async Task<int> Main(string[] args)
    {
        var flags = ParseFlags(args);

        // Generates a wallet without ever printing the seed: it goes straight to a file
        // the operator controls, and only the public address reaches the console.
        if (flags.TryGetValue("new-wallet", out string walletPath))
        {
            XrplWallet fresh = XrplWallet.Generate();
            await File.WriteAllTextAsync(walletPath, fresh.Seed);
            Log($"address : {fresh.ClassicAddress}");
            Log($"seed    : written to {walletPath} — keep it, it is the only key to this account");
            Log($"next    : fund the address, then run with {flags.GetValueOrDefault("seed-env", "XRPL_SEED")} set from that file");
            return 0;
        }

        string filePath = Require(flags, "file");
        string outDir = flags.GetValueOrDefault("out", ".");
        string networkKey = flags.GetValueOrDefault("network", "testnet");
        int limit = int.Parse(flags.GetValueOrDefault("limit", int.MaxValue.ToString()));
        int batchSize = int.Parse(flags.GetValueOrDefault("batch", "40"));
        int maxFeeDrops = int.Parse(flags.GetValueOrDefault("max-fee", "50"));
        decimal budgetXrp = decimal.Parse(flags.GetValueOrDefault("budget-xrp", "1.0"), System.Globalization.CultureInfo.InvariantCulture);
        bool dryRun = flags.ContainsKey("dry-run");
        bool confirmed = flags.ContainsKey("yes");

        if (!Networks.TryGetValue(networkKey, out Network network))
            throw new ArgumentException($"unknown network '{networkKey}' — use testnet or mainnet");

        // The seed never travels on the command line: it would land in shell history.
        string seedEnvName = flags.GetValueOrDefault("seed-env", "XRPL_SEED");
        string seedArg = Environment.GetEnvironmentVariable(seedEnvName);
        if (string.IsNullOrWhiteSpace(seedArg)) seedArg = null;

        byte[] payload = await File.ReadAllBytesAsync(filePath);
        int count = Math.Min((payload.Length + ChunkSize - 1) / ChunkSize, limit);
        string payloadHash = Convert.ToHexString(SHA256.HashData(payload));

        long worstCaseDrops = (long)count * maxFeeDrops;
        Log($"network  : {network.Name} ({network.Ws})");
        Log($"payload  : {payload.Length:N0} B -> {count:N0} transactions of {ChunkSize} B");
        Log($"fees     : up to {maxFeeDrops} drops each, worst case {worstCaseDrops:N0} drops = {worstCaseDrops / 1_000_000m:F6} XRP");
        Log($"budget   : hard stop at {budgetXrp} XRP");

        if (dryRun)
        {
            Log("dry run — nothing was submitted");
            return 0;
        }

        if (!network.Name.Contains("Testnet") && !confirmed)
        {
            Log("refusing to write to a live network without --yes");
            return 2;
        }

        if (worstCaseDrops / 1_000_000m > budgetXrp)
        {
            Log($"worst-case cost exceeds the budget — raise --budget-xrp or lower --max-fee");
            return 2;
        }

        var options = new XrplClient.ClientOptions
        {
            RequestTimeout = TimeSpan.FromMinutes(3),
            InactivityTimeout = TimeSpan.FromMinutes(10),
        };
        IXrplClient client = new XrplClient(network.Ws, options);
        await client.Connect();
        Log($"connected to {network.Ws}");

        // --- кошелёк ---
        XrplWallet wallet;
        if (seedArg is not null)
        {
            wallet = XrplWallet.FromSeed(seedArg);
            Log($"wallet from seed: {wallet.ClassicAddress}");
        }
        else if (networkKey.Equals("mainnet", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"mainnet needs a funded account: set {seedEnvName} to its seed");
        }
        else
        {
            WalletSugar.Funded funded = await client.FundWallet();
            wallet = funded.Wallet;
            Log($"funded new wallet: {wallet.ClassicAddress}, balance {funded.Balance} XRP, seed {wallet.Seed}");
            await File.WriteAllTextAsync(System.IO.Path.Combine(outDir, "wallet.txt"), $"{wallet.ClassicAddress}\n{wallet.Seed}\n");
        }

        JsonElement acct = await Send(client, new AccountInfoRequest(wallet.ClassicAddress) { LedgerIndex = new LedgerIndex(LedgerIndexType.Current) });
        uint accountSeq = acct.GetProperty("account_data").GetProperty("Sequence").GetUInt32();

        // chunk i always rides on sequence startSeq + i. On resume we recover startSeq from the
        // state file so that mapping survives an interrupted run; without it a restart would
        // re-send chunk 0 under a fresh sequence and silently corrupt the index.
        string statePath = System.IO.Path.Combine(outDir, "run-state.json");
        uint startSeq;
        int alreadySent = 0;

        if (flags.ContainsKey("resume"))
        {
            if (!File.Exists(statePath))
                throw new InvalidOperationException($"--resume needs {statePath} from the interrupted run");

            JsonElement state = JsonSerializer.Deserialize<JsonElement>(await File.ReadAllTextAsync(statePath));
            startSeq = state.GetProperty("startSequence").GetUInt32();
            if (state.GetProperty("sourceSha256").GetString() != payloadHash)
                throw new InvalidOperationException("the file changed since the interrupted run — refusing to resume");

            alreadySent = (int)(accountSeq - startSeq);
            Log($"resuming: {alreadySent:N0} of {count:N0} chunks already on chain");
        }
        else
        {
            startSeq = accountSeq;
            Directory.CreateDirectory(outDir);
            await File.WriteAllTextAsync(statePath, JsonSerializer.Serialize(
                new { startSequence = startSeq, chunks = count, sourceSha256 = payloadHash, network = network.Name }, JsonOut));
        }
        long balanceBefore = long.Parse(acct.GetProperty("account_data").GetProperty("Balance").GetString()!);
        Log($"start sequence {startSeq}, balance {balanceBefore:N0} drops = {balanceBefore / 1_000_000m:F6} XRP");

        long needed = (long)count * maxFeeDrops;
        if (balanceBefore - needed < 1_000_000)
        {
            Log($"balance too low: {count:N0} transactions may cost up to {needed:N0} drops and 1 XRP must stay as reserve");
            await client.Disconnect();
            return 2;
        }
        Log($"file {System.IO.Path.GetFileName(filePath)}: {payload.Length:N0} B, sha256 {payloadHash}, chunks {count}");

        var feeSamples = new List<FeeSample>();
        var submits = new List<SubmitRecord>();
        uint firstLedgerSeen = 0;
        int feeDrops = 12;

        Stopwatch total = Stopwatch.StartNew();
        int sent = alreadySent, requeued = 0;

        while (sent < count)
        {
            // замер состояния сети перед каждой пачкой
            FeeSample sample = await SampleFee(client);
            feeSamples.Add(sample);
            if (firstLedgerSeen == 0) firstLedgerSeen = sample.LedgerIndex;

            // комиссия: чуть выше открытой, но не выше потолка
            feeDrops = (int)Math.Min(maxFeeDrops, Math.Max(12, sample.OpenLedgerFeeDrops + 2));

            int batch = 0;
            bool blocked = false;
            while (sent < count && batch < batchSize && !blocked)
            {
                int i = sent;
                int len = Math.Min(ChunkSize, payload.Length - i * ChunkSize);
                var tx = new Dictionary<string, object>
                {
                    ["TransactionType"] = "AccountSet",
                    ["Account"] = wallet.ClassicAddress,
                    ["Sequence"] = (uint)(startSeq + i),
                    ["Fee"] = feeDrops.ToString(),
                    ["SigningPubKey"] = wallet.PublicKey,
                    ["Memos"] = new List<object>
                    {
                        new Dictionary<string, object>
                        {
                            ["Memo"] = new Dictionary<string, object>
                            {
                                ["MemoData"] = Convert.ToHexString(payload.AsSpan(i * ChunkSize, len)),
                            },
                        },
                    },
                };
                SignatureResult signed = wallet.Sign(tx);

                JsonElement r;
                try
                {
                    r = await Send(client, new SubmitRequest { TxBlob = signed.TxBlob });
                }
                catch (Exception ex)
                {
                    Log($"submit error at {i}: {ex.GetType().Name}: {ex.Message} — pausing");
                    await Task.Delay(5000);
                    blocked = true;
                    continue;
                }

                string code = r.TryGetProperty("engine_result", out JsonElement e) ? e.GetString()! : "unknown";
                if (code is "tesSUCCESS" or "terQUEUED")
                {
                    submits.Add(new SubmitRecord(i, (uint)(startSeq + i), signed.Hash, feeDrops, code));
                    sent++;
                    batch++;
                }
                else if (code.StartsWith("tel") || code.StartsWith("ter"))
                {
                    requeued++;
                    blocked = true;      // сеть просит подождать — ждём следующего леджера
                }
                else
                {
                    Log($"unexpected {code} at chunk {i}: {r.GetRawText()[..Math.Min(200, r.GetRawText().Length)]}");
                    blocked = true;
                    await Task.Delay(3000);
                }
            }

            if (sent % 200 < 40 || blocked)
                Log($"{sent}/{count} sent ({sent * 100.0 / count:F1}%), fee={feeDrops} drops, open_ledger={sample.OpenLedgerFeeDrops}, queue={sample.QueueSize}, elapsed {total.Elapsed.TotalMinutes:F1} min");

            if (blocked) await Task.Delay(4000);
        }
        total.Stop();
        Log($"submit phase done: {sent} tx in {total.Elapsed.TotalMinutes:F2} min, {requeued} backoffs");

        // --- ждём валидации всего ---
        Log("waiting for validation…");
        await Task.Delay(12000);

        // --- собираем фактические данные из account_tx ---
        var applied = new SortedDictionary<uint, TxRecord>();
        int pages = 0;
        object marker = null;
        Stopwatch readTimer = Stopwatch.StartNew();
        while (true)
        {
            var req = new AccountTransactionsRequest(wallet.ClassicAddress)
            {
                LedgerIndexMin = -1,
                LedgerIndexMax = -1,
                Limit = 200,
                Forward = true,
                Marker = marker,
            };
            JsonElement page = await Send(client, req);
            pages++;
            foreach (JsonElement t in page.GetProperty("transactions").EnumerateArray())
            {
                JsonElement txj = t.TryGetProperty("tx_json", out JsonElement tj) ? tj : t.GetProperty("tx");
                if (!txj.TryGetProperty("Memos", out JsonElement memos) || memos.GetArrayLength() == 0) continue;
                uint thisSeq = txj.GetProperty("Sequence").GetUInt32();
                if (thisSeq < startSeq || thisSeq >= startSeq + count) continue;   // this run only
                JsonElement meta = t.GetProperty("meta");
                string result = meta.GetProperty("TransactionResult").GetString()!;
                if (result != "tesSUCCESS") continue;

                uint seq = txj.GetProperty("Sequence").GetUInt32();
                uint ledger = t.TryGetProperty("ledger_index", out JsonElement li) ? li.GetUInt32() : txj.GetProperty("ledger_index").GetUInt32();
                string hash = t.TryGetProperty("hash", out JsonElement h) ? h.GetString()! : txj.GetProperty("hash").GetString()!;
                int fee = int.Parse(txj.TryGetProperty("Fee", out JsonElement f) ? f.GetString()! : t.GetProperty("tx_json").GetProperty("Fee").GetString()!);
                string data = memos[0].GetProperty("Memo").GetProperty("MemoData").GetString()!;
                string closeTime = t.TryGetProperty("close_time_iso", out JsonElement ct) && ct.ValueKind == JsonValueKind.String ? ct.GetString() : null;
                applied[seq] = new TxRecord(seq, hash, ledger, fee, result, data.Length / 2, closeTime, data);
            }
            if (!page.TryGetProperty("marker", out JsonElement m)) break;
            marker = JsonSerializer.Deserialize<object>(m.GetRawText());
        }
        readTimer.Stop();
        Log($"read back: {applied.Count} tx over {pages} pages in {readTimer.Elapsed.TotalSeconds:F1}s");

        // --- восстановление файла ---
        byte[] rebuilt = applied.Values
            .OrderBy(r => r.Sequence)
            .SelectMany(r => Convert.FromHexString(r.MemoHex))
            .ToArray();
        string rebuiltHash = Convert.ToHexString(SHA256.HashData(rebuilt));
        bool byteMatch = rebuilt.Length <= payload.Length && rebuilt.AsSpan().SequenceEqual(payload.AsSpan(0, rebuilt.Length));
        bool complete = rebuilt.Length == payload.Length;
        await File.WriteAllBytesAsync(System.IO.Path.Combine(outDir, "rebuilt_from_testnet.txt"), rebuilt);
        Log($"rebuilt {rebuilt.Length:N0} B, complete={complete}, sha256 match={rebuiltHash == payloadHash}, byte-for-byte={byteMatch}");

        JsonElement after = await Send(client, new AccountInfoRequest(wallet.ClassicAddress) { LedgerIndex = new LedgerIndex(LedgerIndexType.Validated) });
        long balanceAfter = long.Parse(after.GetProperty("account_data").GetProperty("Balance").GetString()!);

        Log("collecting per-ledger stats…");
        var groups = applied.Values.GroupBy(t => t.Ledger).OrderBy(g => g.Key).ToList();
        var ledgerRecords = new List<LedgerRecord>();
        foreach (IGrouping<uint, TxRecord> g in groups)
        {
            int totalTx = 0;
            string closeIso = null;
            try
            {
                JsonElement led = await Send(client, new LedgerRequest { LedgerIndex = new LedgerIndex(g.Key), Transactions = true });
                JsonElement lj = led.GetProperty("ledger");
                totalTx = lj.TryGetProperty("transactions", out JsonElement tarr) ? tarr.GetArrayLength() : 0;
                closeIso = lj.TryGetProperty("close_time_iso", out JsonElement ci) && ci.ValueKind == JsonValueKind.String
                    ? ci.GetString() : null;
            }
            catch (Exception ex) { Log($"ledger {g.Key} stats failed: {ex.GetType().Name}"); }

            ledgerRecords.Add(new LedgerRecord(g.Key, g.Count(), totalTx,
                totalTx > 0 ? Math.Round(g.Count() * 100.0 / totalTx, 1) : 0,
                g.Sum(x => (long)x.FeeDrops), closeIso, $"{network.Explorer}/ledgers/{g.Key}"));
        }
        var byLedger = ledgerRecords.ToDictionary(l => l.Ledger);

        var dataset = new Dataset(
            Network: network.Name,
            WsEndpoint: network.Ws,
            Explorer: network.Explorer,
            Account: wallet.ClassicAddress,
            AccountUrl: $"{network.Explorer}/accounts/{wallet.ClassicAddress}",
            SourceFile: System.IO.Path.GetFileName(filePath),
            SourceBytes: payload.Length,
            SourceSha256: payloadHash,
            ChunkSize: ChunkSize,
            ChunksPlanned: count,
            ChunksApplied: applied.Count,
            StartSequence: startSeq,
            FirstLedger: byLedger.Keys.DefaultIfEmpty(0u).Min(),
            LastLedger: byLedger.Keys.DefaultIfEmpty(0u).Max(),
            LedgersUsed: byLedger.Count,
            SubmitMinutes: Math.Round(total.Elapsed.TotalMinutes, 2),
            Backoffs: requeued,
            BalanceBeforeDrops: balanceBefore,
            BalanceAfterDrops: balanceAfter,
            FeeBurnedDrops: balanceBefore - balanceAfter,
            FeeBurnedXrp: (balanceBefore - balanceAfter) / 1_000_000m,
            FeeMinDrops: applied.Count > 0 ? applied.Values.Min(t => t.FeeDrops) : 0,
            FeeMaxDrops: applied.Count > 0 ? applied.Values.Max(t => t.FeeDrops) : 0,
            FeeAvgDrops: applied.Count > 0 ? Math.Round(applied.Values.Average(t => (double)t.FeeDrops), 2) : 0,
            RebuiltBytes: rebuilt.Length,
            RebuiltSha256: rebuiltHash,
            ByteForByteMatch: byteMatch,
            ReadBackSeconds: Math.Round(readTimer.Elapsed.TotalSeconds, 2),
            ReadBackPages: pages,
            FeeSamples: feeSamples,
            Ledgers: ledgerRecords,
            Transactions: applied.Values.Select(t => new TxLink(t.Sequence, t.Hash, t.Ledger, t.FeeDrops, t.PayloadBytes,
                $"{network.Explorer}/transactions/{t.Hash}")).ToList());

        await File.WriteAllTextAsync(System.IO.Path.Combine(outDir, "testnet_dataset.json"), JsonSerializer.Serialize(dataset, JsonOut));

        var csv = new System.Text.StringBuilder("sequence,hash,ledger,fee_drops,payload_bytes,url\n");
        foreach (TxLink t in dataset.Transactions)
            csv.Append($"{t.Sequence},{t.Hash},{t.Ledger},{t.FeeDrops},{t.PayloadBytes},{t.Url}\n");
        await File.WriteAllTextAsync(System.IO.Path.Combine(outDir, "transactions.csv"), csv.ToString());

        var lcsv = new System.Text.StringBuilder("ledger,our_tx,total_tx,our_share_pct,fee_drops,close_time,url\n");
        foreach (LedgerRecord l in ledgerRecords)
            lcsv.Append($"{l.Ledger},{l.OurTxCount},{l.TotalTxCount},{l.OurSharePercent},{l.FeeDropsTotal},{l.CloseTimeIso},{l.Url}\n");
        await File.WriteAllTextAsync(System.IO.Path.Combine(outDir, "ledgers.csv"), lcsv.ToString());

        var fcsv = new System.Text.StringBuilder("utc,ledger,open_ledger_fee,median_fee,minimum_fee,current_size,expected_size,queue\n");
        foreach (FeeSample f in feeSamples)
            fcsv.Append($"{f.Utc},{f.LedgerIndex},{f.OpenLedgerFeeDrops},{f.MedianFeeDrops},{f.MinimumFeeDrops},{f.CurrentLedgerSize},{f.ExpectedLedgerSize},{f.QueueSize}\n");
        await File.WriteAllTextAsync(System.IO.Path.Combine(outDir, "fee_samples.csv"), fcsv.ToString());
        Log($"dataset written: {applied.Count} tx, {byLedger.Count} ledgers, {dataset.FeeBurnedXrp} XRP burned");

        await client.Disconnect();
        return byteMatch ? 0 : 1;
    }

    /// <summary>Parses --key value and --flag arguments.</summary>
    private static Dictionary<string, string> ParseFlags(string[] args)
    {
        var flags = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < args.Length; i++)
        {
            if (!args[i].StartsWith("--", StringComparison.Ordinal)) continue;
            string key = args[i][2..];
            bool hasValue = i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal);
            flags[key] = hasValue ? args[++i] : "true";
        }
        return flags;
    }

    private static string Require(Dictionary<string, string> flags, string key) =>
        flags.TryGetValue(key, out string value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new ArgumentException($"--{key} is required");

    private static void Log(string message) =>
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {message}");

    private static async Task<JsonElement> Send<TRequest>(IXrplClient client, TRequest request)
        where TRequest : BaseRequest
    {
        XrplResponse<object> response = await client.GRequest<object, TRequest>(request);
        return response.Raw.ToJsonElement();
    }

    private static async Task<FeeSample> SampleFee(IXrplClient client)
    {
        JsonElement f = await Send(client, new BaseRequest { Command = "fee" });
        JsonElement drops = f.GetProperty("drops");
        return new FeeSample(
            DateTime.UtcNow.ToString("O"),
            f.GetProperty("ledger_current_index").GetUInt32(),
            int.Parse(drops.GetProperty("open_ledger_fee").GetString()!),
            int.Parse(drops.GetProperty("median_fee").GetString()!),
            int.Parse(drops.GetProperty("minimum_fee").GetString()!),
            int.Parse(f.GetProperty("current_ledger_size").GetString()!),
            int.Parse(f.GetProperty("expected_ledger_size").GetString()!),
            int.Parse(f.GetProperty("current_queue_size").GetString()!));
    }

    private sealed record SubmitRecord(int Index, uint Sequence, string Hash, int FeeDrops, string EngineResult);

    private sealed record TxRecord(uint Sequence, string Hash, uint Ledger, int FeeDrops, string Result,
        int PayloadBytes, string CloseTime, string MemoHex);

    private sealed record FeeSample(string Utc, uint LedgerIndex, int OpenLedgerFeeDrops, int MedianFeeDrops,
        int MinimumFeeDrops, int CurrentLedgerSize, int ExpectedLedgerSize, int QueueSize);

    private sealed record LedgerRecord(uint Ledger, int OurTxCount, int TotalTxCount, double OurSharePercent,
        long FeeDropsTotal, string CloseTimeIso, string Url);

    private sealed record TxLink(uint Sequence, string Hash, uint Ledger, int FeeDrops, int PayloadBytes, string Url);

    private sealed record Dataset(
        string Network, string WsEndpoint, string Explorer, string Account, string AccountUrl,
        string SourceFile, int SourceBytes, string SourceSha256, int ChunkSize, int ChunksPlanned, int ChunksApplied,
        uint StartSequence, uint FirstLedger, uint LastLedger, int LedgersUsed, double SubmitMinutes, int Backoffs,
        long BalanceBeforeDrops, long BalanceAfterDrops, long FeeBurnedDrops, decimal FeeBurnedXrp,
        int FeeMinDrops, int FeeMaxDrops, double FeeAvgDrops,
        int RebuiltBytes, string RebuiltSha256, bool ByteForByteMatch, double ReadBackSeconds, int ReadBackPages,
        List<FeeSample> FeeSamples, List<LedgerRecord> Ledgers, List<TxLink> Transactions);
}
