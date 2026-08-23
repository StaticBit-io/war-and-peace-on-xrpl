/**
 * Wires the index, the ledger client and the DOM together.
 */
import { LedgerClient } from './ledger.mjs';
import { layout, readChapter } from './reader.mjs';
import { chapterRoute, parseChapterRoute } from './routing.mjs';

const $ = (id) => document.getElementById(id);

const state = {
  manifest: null,
  chapters: [],
  hashes: [],
  ledgers: [],
  client: null,
  current: null,
  showRaw: false,
};

// ─────────────────────────── boot ───────────────────────────

async function boot() {
  const [manifest, chapters, hashes, ledgers] = await Promise.all([
    fetchJson('data/manifest.json'),
    fetchJson('data/chapters.json'),
    fetchJson('data/tx-hashes.json'),
    fetchJson('data/ledgers.json'),
  ]);

  Object.assign(state, { manifest, chapters, hashes, ledgers });
  state.client = new LedgerClient(manifest.endpoints, renderNetStatus);

  renderAccountLink();
  renderContents();
  renderAbout();
  bindEvents();

  const wanted = parseChapterRoute(location.hash) ?? 1;
  await openChapter(wanted);
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`cannot load ${path}: HTTP ${response.status}`);
  return response.json();
}

// ─────────────────────────── reader ───────────────────────────

async function openChapter(id) {
  const chapter = state.chapters.find((c) => c.id === id);
  if (!chapter) return;

  state.current = chapter;
  history.replaceState(null, '', chapterRoute(id));
  highlightContents(id);

  $('chapter').hidden = true;
  showStatus(`Fetching ${chapter.lastChunk - chapter.firstChunk + 1} transactions from ${state.manifest.network}…`);

  try {
    const result = await readChapter(
      chapter,
      state.hashes,
      state.client,
      state.manifest.ledger.chunkSize,
      (done, total) => showStatus(`Fetched ${done} of ${total} transactions…`),
    );
    renderChapter(chapter, result);
    hideStatus();
  } catch (error) {
    showStatus(
      `<strong>Could not rebuild this chapter.</strong><br>${escapeHtml(error.message)}<br>` +
      `<button id="retry" class="pager-btn">Try again</button>`,
      true,
    );
    $('retry')?.addEventListener('click', () => openChapter(id));
  }
}

function renderChapter(chapter, result) {
  $('chapter-book').textContent = chapter.book;
  $('chapter-title').textContent = chapter.title;
  $('chapter-meta').textContent =
    `${chapter.words.toLocaleString('en-US')} words · ${chapter.byteLength.toLocaleString('en-US')} bytes · ` +
    `chunks ${chapter.firstChunk}–${chapter.lastChunk}`;

  const verify = $('verify');
  const badge = $('verify-badge');
  verify.hidden = false;
  badge.textContent = result.verified ? '✓ verified against the index' : '✗ digest mismatch';
  badge.className = `verify-badge ${result.verified ? 'is-ok' : 'is-bad'}`;
  $('verify-digest').textContent = `SHA-256 ${result.digest.slice(0, 32)}…`;

  const { headings, paragraphs } = layout(result.text);
  $('prose').innerHTML =
    headings.map((h) => `<p class="inline-heading">${escapeHtml(h)}</p>`).join('') +
    paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');

  $('sources-count').textContent = String(result.sources.length);
  $('source-list').innerHTML = result.sources.map(renderSource).join('');

  $('prev-chapter').disabled = chapter.id <= 0;
  $('next-chapter').disabled = chapter.id >= state.chapters.length - 1;

  $('chapter').hidden = false;
  applyRawVisibility();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderSource(source) {
  const url = `${state.manifest.explorer}/transactions/${source.hash}`;
  const ledgerUrl = `${state.manifest.explorer}/ledgers/${source.ledger}`;
  return `
    <li class="source">
      <div class="source-line">
        <span class="source-index">#${source.index}</span>
        <a class="source-hash" href="${url}" target="_blank" rel="noopener">${source.hash.slice(0, 24)}…</a>
        <a class="source-ledger" href="${ledgerUrl}" target="_blank" rel="noopener">ledger ${source.ledger}</a>
        <span class="source-bytes">${(source.hex.length / 2).toLocaleString('en-US')} B</span>
      </div>
      <pre class="source-raw" hidden>${escapeHtml(source.hex)}</pre>
    </li>`;
}

function applyRawVisibility() {
  for (const pre of document.querySelectorAll('.source-raw')) pre.hidden = !state.showRaw;
}

/** Groups consecutive chapters into the book they belong to, preserving order. */
function groupByBook(chapters) {
  const groups = [];
  for (const chapter of chapters) {
    const last = groups.at(-1);
    if (last && last.book === chapter.book) last.chapters.push(chapter);
    else groups.push({ book: chapter.book, chapters: [chapter] });
  }
  return groups;
}

function renderContents() {
  $('contents-count').textContent = `${state.chapters.length - 1} chapters`;

  $('chapter-list').innerHTML = groupByBook(state.chapters)
    .map((group) => {
      // Front matter is a single entry — a collapsible group around it would be noise.
      if (group.chapters.length === 1) return chapterLink(group.chapters[0], 'loose');

      const links = group.chapters.map((chapter) => chapterLink(chapter)).join('');

      return `<li class="book">
        <details class="book-details">
          <summary class="book-summary">
            <span class="book-name">${escapeHtml(group.book)}</span>
            <span class="book-count">${group.chapters.length}</span>
          </summary>
          <ol class="book-chapters">${links}</ol>
        </details>
      </li>`;
    })
    .join('');
}

const chapterLink = (chapter, liClass = '') =>
  `<li${liClass ? ` class="${liClass}"` : ''}><button class="chapter-link" data-id="${chapter.id}">${escapeHtml(chapter.title)}</button></li>`;

function highlightContents(id) {
  for (const link of document.querySelectorAll('.chapter-link')) {
    link.classList.toggle('is-current', Number(link.dataset.id) === id);
  }

  const current = document.querySelector('.chapter-link.is-current');
  if (!current) return;

  // Open the book holding this chapter; leave any other open book as the reader left it.
  current.closest('details')?.setAttribute('open', '');
  current.scrollIntoView({ block: 'nearest' });
}

// ─────────────────────────── dashboard ───────────────────────────

function renderAbout() {
  const { book, ledger, verification, network } = state.manifest;

  $('about-lede').textContent =
    `The complete text of War and Peace — ${book.bytes.toLocaleString('en-US')} bytes — was cut into ` +
    `${ledger.transactions.toLocaleString('en-US')} pieces of ${ledger.chunkSize} bytes and written into the memo field of ` +
    `${ledger.transactions.toLocaleString('en-US')} transactions on ${network}. It took ${ledger.submitMinutes} minutes and ` +
    `${ledger.feeBurnedXrp} XRP in fees. Reading all of it back took ${ledger.readBackSeconds} seconds.`;

  $('chunk-size').textContent = String(ledger.chunkSize);

  $('stats').innerHTML = [
    stat(ledger.transactions.toLocaleString('en-US'), 'transactions'),
    stat(ledger.ledgersUsed.toLocaleString('en-US'), 'ledgers'),
    stat(`${ledger.feeBurnedXrp}`, 'XRP burned'),
    stat(`${(book.bytes / 1048576).toFixed(2)} MB`, 'of book text'),
    stat(`${ledger.submitMinutes} min`, 'to write'),
    stat(`${ledger.readBackSeconds} s`, 'to read back'),
  ].join('');

  const perLedger = state.ledgers.map((l) => l.ourTx);
  const max = Math.max(...perLedger);
  $('chart-note').textContent =
    `${state.ledgers.length} ledgers carried the book, ${max} transactions in the busiest one. ` +
    `Bar height is our transactions per ledger.`;
  $('chart').innerHTML = state.ledgers
    .map((l) => {
      const height = Math.max(2, Math.round((l.ourTx / max) * 100));
      const title = `ledger ${l.ledger}: ${l.ourTx} of ${l.totalTx} transactions (${l.sharePercent}%)`;
      return `<a class="bar" style="height:${height}%" title="${escapeHtml(title)}" href="${state.manifest.explorer}/ledgers/${l.ledger}" target="_blank" rel="noopener"></a>`;
    })
    .join('');

  $('facts').innerHTML = [
    fact('Network', network),
    fact('Account', `<a href="${state.manifest.accountUrl}" target="_blank" rel="noopener">${state.manifest.account}</a>`),
    fact('Payload per transaction', `${ledger.chunkSize} bytes (the protocol caps a memo at 1024)`),
    fact('Stored in the ledger per transaction', `${ledger.bytesInLedgerPerTx} bytes including metadata`),
    fact('Fee per transaction', `${ledger.feeDropsPerTx} drops — a fee does not depend on transaction size`),
    fact('Ledger range', `<a href="${state.manifest.explorer}/ledgers/${ledger.firstLedger}" target="_blank" rel="noopener">${ledger.firstLedger}</a> – <a href="${state.manifest.explorer}/ledgers/${ledger.lastLedger}" target="_blank" rel="noopener">${ledger.lastLedger}</a>`),
    fact('Written', `${ledger.firstCloseTime ?? '—'} → ${ledger.lastCloseTime ?? '—'}`),
    fact('Book SHA-256', `<code>${book.sha256}</code>`),
    fact('Round-trip check', verification.byteForByteMatch ? 'byte-for-byte identical to the source file' : 'MISMATCH'),
    fact('Chapters indexed', `${book.chapters} across ${book.books} books and epilogues`),
  ].join('');
}

const stat = (value, label) => `<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`;
const fact = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;

// ─────────────────────────── chrome ───────────────────────────

function renderAccountLink() {
  const link = $('net-account');
  link.href = state.manifest.accountUrl;
  link.textContent = state.manifest.account;
}

function renderNetStatus({ endpoint, status }) {
  const label = {
    connecting: `connecting to ${endpoint}`,
    connected: `reading from ${endpoint}`,
    retrying: `switching to ${endpoint}`,
    failed: `${endpoint} unreachable`,
    disconnected: 'disconnected',
  }[status] ?? status;

  $('net-status').textContent = label;
  $('net-dot').className = `net-dot is-${status}`;
}

function showStatus(html, isError = false) {
  const node = $('page-status');
  node.innerHTML = html;
  node.className = `page-status${isError ? ' is-error' : ''}`;
  node.hidden = false;
}

function hideStatus() {
  $('page-status').hidden = true;
}

function bindEvents() {
  $('chapter-list').addEventListener('click', (event) => {
    const button = event.target.closest('.chapter-link');
    if (button) openChapter(Number(button.dataset.id));
  });

  $('prev-chapter').addEventListener('click', () => openChapter(state.current.id - 1));
  $('next-chapter').addEventListener('click', () => openChapter(state.current.id + 1));

  $('raw-toggle').addEventListener('change', (event) => {
    state.showRaw = event.target.checked;
    applyRawVisibility();
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) other.classList.toggle('is-active', other === tab);
      for (const view of document.querySelectorAll('.view')) {
        view.classList.toggle('is-active', view.id === `view-${tab.dataset.view}`);
      }
    });
  }

  window.addEventListener('hashchange', () => {
    // Front matter is chapter 0, so test for null — a plain truthiness check drops it.
    const id = parseChapterRoute(location.hash);
    if (id !== null && id !== state.current?.id) openChapter(id);
  });

  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea')) return;
    if (event.key === 'ArrowLeft' && state.current?.id > 0) openChapter(state.current.id - 1);
    if (event.key === 'ArrowRight' && state.current?.id < state.chapters.length - 1) openChapter(state.current.id + 1);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot().catch((error) => {
  document.body.innerHTML = `<div class="fatal"><h1>Could not start</h1><p>${escapeHtml(error.message)}</p></div>`;
});
