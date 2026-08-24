/**
 * Minimal XRPL WebSocket client — batched history reads plus single lookups by hash.
 *
 * No SDK, no dependencies: the whole point of this site is that anyone can see
 * exactly what it asks the network for, and that nothing else feeds the reader.
 */
import { hexToBytes } from './offsets.mjs';

const REQUEST_TIMEOUT_MS = 15000;

export class LedgerError extends Error {
  constructor(message, { hash = null, cause = null } = {}) {
    super(message);
    this.name = 'LedgerError';
    this.hash = hash;
    this.cause = cause;
  }
}

export class LedgerClient {
  /**
   * @param {string[]} endpoints public nodes to try, most complete history first
   * @param {(state: {endpoint: string, status: string}) => void} [onStatus]
   */
  constructor(endpoints, onStatus = () => {}) {
    if (!endpoints?.length) throw new Error('at least one endpoint is required');
    this.endpoints = endpoints;
    this.onStatus = onStatus;
    this.endpointIndex = 0;
    this.socket = null;
    this.connecting = null;
    this.nextId = 1;
    this.pending = new Map();
    this.lastClose = null;
  }

  get endpoint() {
    return this.endpoints[this.endpointIndex];
  }

  /**
   * Moves to the next endpoint, wrapping around once so a node that was busy earlier gets a
   * second chance. Returns false when every endpoint has been tried for this operation.
   */
  rotateEndpoint() {
    this.tried = this.tried ?? new Set();
    this.tried.add(this.endpointIndex);

    if (this.tried.size >= this.endpoints.length) {
      this.tried = null;
      return false;
    }

    this.endpointIndex = (this.endpointIndex + 1) % this.endpoints.length;
    this.close();
    return true;
  }

  /** Called after a successful call so the next failure starts its own rotation. */
  markHealthy() {
    this.tried = null;
  }

  close() {
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    this.connecting = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new LedgerError('connection closed while the request was in flight'));
    }
    this.pending.clear();
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      this.onStatus({ endpoint: this.endpoint, status: 'connecting' });
      const socket = new WebSocket(this.endpoint);

      const failed = (reason) => {
        this.connecting = null;
        this.onStatus({ endpoint: this.endpoint, status: 'failed' });
        reject(new LedgerError(`cannot reach ${this.endpoint}: ${reason}`));
      };

      socket.onopen = () => {
        this.socket = socket;
        this.connecting = null;
        this.onStatus({ endpoint: this.endpoint, status: 'connected' });
        resolve();
      };
      socket.onerror = () => failed('websocket error');
      socket.onclose = (event) => {
        // A node may accept the socket and drop it a moment later — xrplcluster answers
        // code 1008 "Connection (public) IP limit reached" that way. The reason has to
        // survive, otherwise the next request fails with a meaningless "socket is null".
        this.lastClose = event.reason || `closed with code ${event.code}`;
        if (this.socket === socket) {
          this.socket = null;
          this.onStatus({ endpoint: this.endpoint, status: 'disconnected' });
        }
        if (this.connecting) failed(this.lastClose);
      };
      socket.onmessage = (event) => this.receive(event.data);
    });

    return this.connecting;
  }

  receive(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const waiting = this.pending.get(message.id);
    if (!waiting) return;

    clearTimeout(waiting.timer);
    this.pending.delete(message.id);

    if (message.status === 'error') {
      waiting.reject(new LedgerError(message.error_message || message.error || 'request failed'));
      return;
    }
    waiting.resolve(message.result ?? message);
  }

  async request(payload) {
    await this.connect();

    // The socket can die between connect() and send() — a node that refuses on policy
    // grounds closes immediately after the handshake.
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new LedgerError(`${this.endpoint} dropped the connection: ${this.lastClose ?? 'unknown reason'}`);
    }

    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LedgerError(`no answer from ${this.endpoint} within ${REQUEST_TIMEOUT_MS} ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ ...payload, id }));
    });
  }

  /**
   * Switches to a specific endpoint, dropping the current connection.
   * @param {number} index position in the endpoint list
   */
  async useEndpoint(index) {
    if (index < 0 || index >= this.endpoints.length) throw new LedgerError(`no endpoint at position ${index}`);
    this.endpointIndex = index;
    this.close();
    await this.connect();
  }

  /**
   * Reads a run of the account's transactions in one message.
   *
   * This is the cheap path: a node returns up to 400 transactions per call, where fetching by
   * hash costs one message each. ledgerIndexMin keeps unrelated history out — an account may
   * hold several uploads, and the clip starts at a known ledger.
   *
   * @param {{account: string, ledgerIndexMin: number, limit: number, marker: object|null}} query
   * @returns {Promise<{entries: {bytes: Uint8Array, hash: string, ledger: number}[], marker: object|null}>}
   */
  async accountBatch({ account, ledgerIndexMin, limit = 400, marker = null }) {
    for (;;) {
      try {
        const result = await this.request({
          command: 'account_tx',
          account,
          ledger_index_min: ledgerIndexMin,
          ledger_index_max: -1,
          limit,
          forward: true,
          ...(marker ? { marker } : {}),
        });

        const entries = [];
        for (const record of result.transactions ?? []) {
          const tx = record.tx_json ?? record.tx ?? {};
          const outcome = record.meta?.TransactionResult ?? record.metaData?.TransactionResult;

          // A failed transaction still sits in the ledger with its memo attached; taking it
          // would splice garbage into the middle of the stream.
          if (outcome && outcome !== 'tesSUCCESS') continue;

          const hex = tx.Memos?.[0]?.Memo?.MemoData;
          if (!hex) continue;

          entries.push({
            bytes: hexToBytes(hex),
            hash: record.hash ?? tx.hash,
            ledger: record.ledger_index ?? tx.ledger_index,
            // Ticketed uploads carry Sequence 0 and their real position in TicketSequence.
            sequence: (tx.TicketSequence ?? 0) || tx.Sequence,
          });
        }
        this.markHealthy();
        return { entries, marker: result.marker ?? null };
      } catch (error) {
        if (!this.rotateEndpoint()) {
          throw new LedgerError(`no configured node could serve this batch (last error: ${error.message})`, { cause: error });
        }
        this.onStatus({ endpoint: this.endpoint, status: 'retrying' });
      }
    }
  }

  /**
   * Fetches one transaction and returns its memo payload plus the raw record.
   * @param {string} hash transaction hash
   * @returns {Promise<{bytes: Uint8Array, hex: string, tx: object}>}
   */
  async fetchChunk(hash) {
    const result = await this.request({ command: 'tx', transaction: hash, binary: false });
    const tx = result.tx_json ?? result;
    const memos = tx.Memos ?? result.Memos;

    if (!memos?.length) {
      throw new LedgerError('transaction carries no memo', { hash });
    }
    const hex = memos[0].Memo?.MemoData;
    if (!hex) throw new LedgerError('memo has no MemoData field', { hash });

    const validated = result.validated ?? true;
    const outcome = result.meta?.TransactionResult ?? result.metaData?.TransactionResult;
    if (outcome && outcome !== 'tesSUCCESS') {
      throw new LedgerError(`transaction did not succeed (${outcome})`, { hash });
    }

    return {
      bytes: hexToBytes(hex),
      hex,
      validated,
      tx: { ...tx, hash, ledger_index: result.ledger_index ?? tx.ledger_index, meta: result.meta ?? null },
    };
  }

  /**
   * Fetches many chunks concurrently, rotating to another node if one cannot serve them.
   * @param {string[]} hashes
   * @param {(done: number, total: number) => void} [onProgress]
   */
  async fetchChunks(hashes, onProgress = () => {}) {
    for (;;) {
      try {
        let done = 0;
        const results = await Promise.all(
          hashes.map(async (hash) => {
            const chunk = await this.fetchChunk(hash);
            onProgress((done += 1), hashes.length);
            return chunk;
          }),
        );
        return results;
      } catch (error) {
        if (!this.rotateEndpoint()) {
          throw new LedgerError(
            `no configured node could serve these transactions (last error: ${error.message})`,
            { cause: error },
          );
        }
        this.onStatus({ endpoint: this.endpoint, status: 'retrying' });
      }
    }
  }
}
