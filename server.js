const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const SHEET_ID = '1Uo7OtHVekjsuTSfVodzUNqkL5dtOneM1GwPn85OG_gM';
const STORES = {
  hyderabad: { gid: '0',          label: 'Hyderabad' },
  delhi:     { gid: '2053559649', label: 'Delhi'     },
  pune:      { gid: '688522673',  label: 'Pune'      },
};

function csvUrl(gid) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
}

const KEEP_COLS = new Set([
  'BARCODE', 'Brand', 'Vendor Article Name', 'Item Name',
  'Size', 'MRP', 'Expiry Date', 'Ware house stock', 'Store stock',
]);

const cache = { hyderabad: [], delhi: [], pune: [], lastFetched: null, status: 'empty' };

function parseCSVLean(text) {
  const lines = text.split('\n');
  if (lines.length < 2) return [];

  const splitLine = (line) => {
    const cols = [];
    let start = 0, inQ = false;
    for (let i = 0; i <= line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; continue; }
      if ((c === ',' || i === line.length) && !inQ) {
        cols.push(line.slice(start, i).replace(/^"|"$/g, '').trim());
        start = i + 1;
      }
    }
    return cols;
  };

  const rawHeaders = splitLine(lines[0]).map(h => h.replace(/^\uFEFF/, '').trim());
  const idx = {};
  rawHeaders.forEach((h, i) => { if (KEEP_COLS.has(h)) idx[h] = i; });

  const iBC    = idx['BARCODE']             ?? -1;
  const iBrand = idx['Brand']               ?? -1;
  const iVAN   = idx['Vendor Article Name'] ?? -1;
  const iName  = idx['Item Name']           ?? -1;
  const iSize  = idx['Size']                ?? -1;
  const iMRP   = idx['MRP']                 ?? -1;
  const iExp   = idx['Expiry Date']         ?? -1;
  const iWH    = idx['Ware house stock']    ?? -1;
  const iFloor = idx['Store stock']         ?? -1;

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const v = splitLine(line);
    const bc    = iBC   >= 0 ? (v[iBC]   || '').trim() : '';
    const iname = iName >= 0 ? (v[iName] || '').trim() : '';
    const van   = iVAN  >= 0 ? (v[iVAN]  || '').trim() : '';
    if (!bc && !iname && !van) continue;
    rows.push({
      bc,
      brand: iBrand >= 0 ? (v[iBrand] || '').trim() : '',
      van,
      iname,
      size:  iSize  >= 0 ? (v[iSize]  || '').trim() : '',
      mrp:   iMRP   >= 0 ? (v[iMRP]   || '').trim() : '',
      exp:   iExp   >= 0 ? (v[iExp]   || '').trim() : '',
      wh:    iWH    >= 0 ? (v[iWH]    || '0').trim() : '0',
      floor: iFloor >= 0 ? (v[iFloor] || '0').trim() : '0',
    });
  }
  return rows;
}

async function fetchStore(storeKey) {
  const { gid, label } = STORES[storeKey];
  const t0 = Date.now();
  console.log(`[cache] Fetching ${label}...`);
  const res = await fetch(csvUrl(gid));
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${label}`);
  const fetchMs = Date.now() - t0;
  const text = await res.text();
  const downloadMs = Date.now() - t0 - fetchMs;
  const rows = parseCSVLean(text);
  const parseMs = Date.now() - t0 - fetchMs - downloadMs;
  console.log(`[cache] ${label}: ${rows.length} rows | fetch:${fetchMs}ms download:${downloadMs}ms parse:${parseMs}ms | heap:${Math.round(process.memoryUsage().heapUsed/1024/1024)}MB`);
  return rows;
}

async function refreshCache() {
  cache.status = 'loading';
  const t0 = Date.now();
  try {
    const [hyd, del, pun] = await Promise.all([
      fetchStore('hyderabad'),
      fetchStore('delhi'),
      fetchStore('pune'),
    ]);
    cache.hyderabad   = hyd;
    cache.delhi       = del;
    cache.pune        = pun;
    cache.lastFetched = new Date();
    cache.status      = 'ready';
    console.log(`[cache] All done in ${Date.now()-t0}ms total | heap:${Math.round(process.memoryUsage().heapUsed/1024/1024)}MB`);
  } catch (err) {
    cache.status = 'error';
    console.error('[cache] Refresh failed:', err.message);
  }
}

function scheduleDailyRefresh() {
  const now = new Date(); const next = new Date();
  next.setUTCHours(4, 30, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const ms = next - now;
  console.log(`[cache] Next auto-refresh in ${Math.round(ms / 60000)} min`);
  setTimeout(() => { refreshCache(); setInterval(refreshCache, 24 * 60 * 60 * 1000); }, ms);
}

function norm(s) { return (s || '').toLowerCase().trim(); }
function tokenize(s) { return norm(s).split(/[\s\-_/]+/).filter(t => t.length > 0); }

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function tokenFuzzy(qt, tt) {
  if (tt.includes(qt)) return true;
  if (qt.length <= 2) return qt === tt;
  return levenshtein(qt, tt) <= (qt.length <= 4 ? 1 : 2);
}

function fuzzyScore(query, target) {
  const q = norm(query), t = norm(target);
  if (!q || !t) return 0;
  if (t.includes(q)) return 100;
  const qTokens = tokenize(query), tTokens = tokenize(target);
  if (qTokens.length === 0) return 0;
  let matched = 0;
  for (const qt of qTokens)
    for (const tt of tTokens)
      if (tokenFuzzy(qt, tt)) { matched++; break; }
  const ratio = matched / qTokens.length;
  if (ratio === 1)  return 80;
  if (ratio >= 0.7) return 50;
  return 0;
}

function toCard(row, storeName) {
  return {
    barcode: row.bc, brand: row.brand, vendorArticleName: row.van,
    itemName: row.iname, size: row.size, mrp: row.mrp, expiryDate: row.exp,
    warehouseStock: row.wh, storeStock: row.floor, store: storeName,
  };
}

function hasStock(card) {
  return (parseInt(card.storeStock) || 0) > 0 || (parseInt(card.warehouseStock) || 0) > 0;
}

function searchRows(rows, q, type, storeName) {
  const qn = norm(q);
  const scored = [];
  for (const row of rows) {
    let score = 0;
    if (type === 'barcode')      { if (norm(row.bc).includes(qn)) score = 100; }
    else if (type === 'brand')   { score = fuzzyScore(q, row.brand); }
    else if (type === 'product') { score = Math.max(fuzzyScore(q, row.iname), fuzzyScore(q, row.van)); }
    if (score > 0) scored.push({ score, card: toCard(row, storeName) });
  }
  scored.sort((a, b) => {
    const aS = hasStock(a.card) ? 1 : 0, bS = hasStock(b.card) ? 1 : 0;
    if (bS !== aS) return bS - aS;
    return b.score - a.score;
  });
  return scored.map(s => s.card);
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({
    status: cache.status,
    lastFetched: cache.lastFetched,
    counts: { hyderabad: cache.hyderabad.length, delhi: cache.delhi.length, pune: cache.pune.length },
    heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
});

app.post('/api/refresh', (req, res) => { refreshCache(); res.json({ ok: true }); });

app.get('/api/search', (req, res) => {
  try {
    const { q, type, store } = req.query;
    if (!q || !type || !store) return res.status(400).json({ error: 'Missing q, type, or store.' });
    if (cache.status === 'loading') return res.status(503).json({ error: 'Still loading — please wait.' });
    if (cache.status === 'error')   return res.status(503).json({ error: 'Data failed to load. Click Refresh.' });
    if (cache.status !== 'ready')   return res.status(503).json({ error: 'Not ready yet.' });
    const pk = store.toLowerCase();
    const primary = searchRows(cache[pk] || [], q, type, STORES[pk]?.label || pk);
    res.json({ primary, total: primary.length, lastFetched: cache.lastFetched });
  } catch (err) {
    console.error('[search]', err);
    res.status(500).json({ error: 'Internal error: ' + err.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Server error: ' + (err.message || 'Unknown') });
});

// ── Keep-alive (8 AM–10 PM IST, every 14 min) ────────────────────────────────
function startKeepAlive() {
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (!RENDER_URL) { console.log('[keep-alive] Skipping (local)'); return; }
  const isActive = () => {
    const m = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    return m >= 150 && m <= 990;
  };
  setInterval(async () => {
    if (!isActive()) return;
    try { const r = await fetch(`${RENDER_URL}/api/status`); console.log(`[keep-alive] Ping ${r.status}`); }
    catch (e) { console.warn('[keep-alive] Failed:', e.message); }
  }, 14 * 60 * 1000);
  console.log('[keep-alive] Started');
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Server on port ${PORT}`);
  await refreshCache();
  scheduleDailyRefresh();
  startKeepAlive();
});
