const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Sheet config ──────────────────────────────────────────────────────────────
const SHEET_ID = '1Uo7OtHVekjsuTSfVodzUNqkL5dtOneM1GwPn85OG_gM';
const STORES = {
  hyderabad: { gid: '0',          label: 'Hyderabad' },
  delhi:     { gid: '2053559649', label: 'Delhi'     },
  pune:      { gid: '688522673',  label: 'Pune'      },
};

function csvUrl(gid) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
}

// ── Only these columns are kept in memory — everything else is discarded ──────
// Keeps memory ~70% lower than storing all 22 columns.
const KEEP_COLS = new Set([
  'BARCODE', 'Brand', 'Vendor Article Name', 'Item Name',
  'Size', 'MRP', 'Expiry Date', 'Ware house stock', 'Store stock',
]);

// ── In-memory cache ───────────────────────────────────────────────────────────
const cache = {
  hyderabad: [],
  delhi: [],
  pune: [],
  lastFetched: null,
  status: 'empty',
};

// Parse CSV and keep ONLY the needed columns.
// Returns array of lean objects: { bc, brand, van, iname, size, mrp, exp, wh, floor }
function parseCSVLean(text) {
  const lines = text.split('\n');
  if (lines.length < 2) return [];

  // Parse one CSV line, respecting quoted fields
  const parseLine = (line) => {
    const result = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; }
      else if (c === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
      else { cur += c; }
    }
    result.push(cur.trim());
    return result;
  };

  const rawHeaders = parseLine(lines[0]).map(h => h.replace(/^\uFEFF/, '').trim());

  // Build an index map: only for columns we want
  const idx = {};
  rawHeaders.forEach((h, i) => { if (KEEP_COLS.has(h)) idx[h] = i; });

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const v = parseLine(line);
    // Store as a compact object with short keys to save memory
    const row = {
      bc:    (v[idx['BARCODE']]             || '').trim(),
      brand: (v[idx['Brand']]               || '').trim(),
      van:   (v[idx['Vendor Article Name']] || '').trim(),
      iname: (v[idx['Item Name']]           || '').trim(),
      size:  (v[idx['Size']]                || '').trim(),
      mrp:   (v[idx['MRP']]                 || '').trim(),
      exp:   (v[idx['Expiry Date']]         || '').trim(),
      wh:    (v[idx['Ware house stock']]    || '0').trim(),
      floor: (v[idx['Store stock']]         || '0').trim(),
    };
    // Skip completely empty rows
    if (!row.bc && !row.iname && !row.van) continue;
    rows.push(row);
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

// Fetch stores ONE AT A TIME to avoid 3x memory spike from parallel fetches
async function refreshCache() {
  cache.status = 'loading';
  const t0 = Date.now();
  try {
    cache.hyderabad = await fetchStore('hyderabad');
    cache.delhi     = await fetchStore('delhi');
    cache.pune      = await fetchStore('pune');
    cache.lastFetched = new Date();
    cache.status = 'ready';
    console.log(`[cache] All done in ${Date.now()-t0}ms total | heap:${Math.round(process.memoryUsage().heapUsed/1024/1024)}MB`);
  } catch (err) {
    cache.status = 'error';
    console.error('[cache] Refresh failed:', err.message);
  }
}

function scheduleDailyRefresh() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(4, 30, 0, 0); // 10:00 AM IST
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const ms = next - now;
  console.log(`[cache] Next auto-refresh in ${Math.round(ms / 60000)} min`);
  setTimeout(() => {
    refreshCache();
    setInterval(refreshCache, 24 * 60 * 60 * 1000);
  }, ms);
}

// ── Search helpers ────────────────────────────────────────────────────────────
function norm(s) { return (s || '').toLowerCase().trim(); }

function tokenize(s) {
  // Split on spaces/hyphens/underscores, drop empty tokens
  return norm(s).split(/[\s\-_/]+/).filter(t => t.length > 0);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99; // early exit — too different
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

// Returns true if query token fuzzy-matches a target token
function tokenFuzzy(qt, tt) {
  if (tt.includes(qt)) return true;           // substring match
  if (qt.length <= 2) return qt === tt;        // short tokens must be exact
  const maxDist = qt.length <= 4 ? 1 : 2;     // 1 typo for short, 2 for long
  return levenshtein(qt, tt) <= maxDist;
}

// Core fuzzy scorer — returns a score (higher = better match), 0 = no match
// Strategy:
//   1. Full string substring match  → score 100
//   2. All query tokens found in target tokens (fuzzy) → score 80+
//   3. Most query tokens match → score 50+ (partial match)
function fuzzyScore(query, target) {
  const q = norm(query);
  const t = norm(target);
  if (!q || !t) return 0;

  // 1. Direct substring
  if (t.includes(q)) return 100;

  const qTokens = tokenize(query);
  const tTokens = tokenize(target);
  if (qTokens.length === 0) return 0;

  // 2. Token matching — for each query token, find best match in target tokens
  let matchedCount = 0;
  for (const qt of qTokens) {
    for (const tt of tTokens) {
      if (tokenFuzzy(qt, tt)) { matchedCount++; break; }
    }
  }

  const ratio = matchedCount / qTokens.length;
  if (ratio === 1) return 80;     // all tokens matched
  if (ratio >= 0.7) return 50;    // most tokens matched (e.g. 2 of 3)
  return 0;
}

// Brand search: fuzzy on brand field only
function brandMatch(query, brand) {
  return fuzzyScore(query, brand) > 0;
}

// Product search: fuzzy on item name + vendor article name, return best score
function productMatch(query, iname, van) {
  return Math.max(fuzzyScore(query, iname), fuzzyScore(query, van)) > 0;
}

function toCard(row, storeName) {
  return {
    barcode:           row.bc,
    brand:             row.brand,
    vendorArticleName: row.van,
    itemName:          row.iname,
    size:              row.size,
    mrp:               row.mrp,
    expiryDate:        row.exp,
    warehouseStock:    row.wh,
    storeStock:        row.floor,
    store:             storeName,
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
    if (type === 'barcode') {
      if (norm(row.bc).includes(qn)) score = 100;
    } else if (type === 'brand') {
      score = fuzzyScore(q, row.brand);
    } else if (type === 'product') {
      score = Math.max(fuzzyScore(q, row.iname), fuzzyScore(q, row.van));
    }
    if (score > 0) scored.push({ score, card: toCard(row, storeName) });
  }

  // Sort: in-stock first, then by match score descending within each group
  scored.sort((a, b) => {
    const aStock = hasStock(a.card) ? 1 : 0;
    const bStock = hasStock(b.card) ? 1 : 0;
    if (bStock !== aStock) return bStock - aStock; // in-stock first
    return b.score - a.score;                       // then by relevance
  });
  return scored.map(s => s.card);
}

// Find all sizes of the same product — matched by itemName or vendorArticleName
function getSizes(rows, itemName, van, storeName) {
  const inorm = norm(itemName);
  const vnorm = norm(van);
  const results = [];
  for (const row of rows) {
    const nameMatch = inorm && norm(row.iname) === inorm;
    const vanMatch  = vnorm && norm(row.van)   === vnorm;
    if (nameMatch || vanMatch) results.push(toCard(row, storeName));
  }
  // Sort: in-stock first, then by size
  results.sort((a, b) => {
    const aStock = hasStock(a) ? 1 : 0;
    const bStock = hasStock(b) ? 1 : 0;
    if (bStock !== aStock) return bStock - aStock;
    return (a.size || '').localeCompare(b.size || '');
  });
  return results;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({
    status: cache.status,
    lastFetched: cache.lastFetched,
    counts: {
      hyderabad: cache.hyderabad.length,
      delhi:     cache.delhi.length,
      pune:      cache.pune.length,
    },
    heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
});

app.post('/api/refresh', (req, res) => {
  refreshCache();
  res.json({ ok: true, message: 'Refresh started' });
});

app.get('/api/search', (req, res) => {
  try {
    const { q, type, store } = req.query;
    if (!q || !type || !store)
      return res.status(400).json({ error: 'Missing q, type, or store.' });
    if (cache.status === 'loading')
      return res.status(503).json({ error: 'Still loading — please wait a moment.' });
    if (cache.status === 'error')
      return res.status(503).json({ error: 'Data failed to load. Click ↺ Refresh.' });
    if (cache.status !== 'ready')
      return res.status(503).json({ error: 'Not ready yet.' });

    const pk = store.toLowerCase();

    const primary   = searchRows(cache[pk] || [], q, type, STORES[pk]?.label || pk);

    res.json({ primary, secondary: [], total: primary.length, lastFetched: cache.lastFetched });
  } catch (err) {
    console.error('[search]', err);
    res.status(500).json({ error: 'Internal error: ' + err.message });
  }
});

// Sizes endpoint — returns all variants (sizes) of a product
app.get('/api/sizes', (req, res) => {
  try {
    const { itemName, van, store } = req.query;
    if (!store) return res.status(400).json({ error: 'Missing store.' });
    if (cache.status !== 'ready') return res.status(503).json({ error: 'Data not ready.' });
    const pk = store.toLowerCase();
    const sizes = getSizes(cache[pk] || [], itemName || '', van || '', STORES[pk]?.label || pk);
    res.json({ sizes, total: sizes.length });
  } catch (err) {
    console.error('[sizes]', err);
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
  if (!RENDER_URL) { console.log('[keep-alive] No RENDER_EXTERNAL_URL — skipping'); return; }

  const isActive = () => {
    const m = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    return m >= 150 && m <= 990;
  };

  setInterval(async () => {
    if (!isActive()) { console.log('[keep-alive] Outside hours'); return; }
    try {
      const r = await fetch(`${RENDER_URL}/api/status`);
      console.log(`[keep-alive] Ping ${r.status}`);
    } catch (e) { console.warn('[keep-alive] Failed:', e.message); }
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
