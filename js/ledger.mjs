/**
 * Minimal XRPL WebSocket client — just enough to pull transactions by hash.
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
  }

  get endpoint() {
    return this.endpoints[this.endpointIndex];
  }

  /** Moves to the next endpoint in the list; returns false once they are exhausted. */
  rotateEndpoint() {
    if (this.endpointIndex + 1 >= this.endpoints.length) return false;
    this.endpointIndex += 1;
    this.close();
    return true;
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
        if (this.socket === socket) {
          this.socket = null;
          this.onStatus({ endpoint: this.endpoint, status: 'disconnected' });
        }
        if (this.connecting) failed(`closed with code ${event.code}`);
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
