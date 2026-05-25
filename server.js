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

// ── In-memory cache ───────────────────────────────────────────────────────────
const cache = {
  hyderabad: [],
  delhi: [],
  pune: [],
  lastFetched: null,
  status: 'empty',   // 'empty' | 'loading' | 'ready' | 'error'
};

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  // Parse a single CSV line respecting quoted fields
  const parseLine = (line) => {
    const result = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        result.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    result.push(cur.trim());
    return result;
  };

  const headers = parseLine(lines[0]).map(h => h.replace(/^\uFEFF/, '').trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

async function fetchStore(storeKey) {
  const { gid, label } = STORES[storeKey];
  const url = csvUrl(gid);
  console.log(`[cache] Fetching ${label}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${label}`);
  const text = await res.text();
  const rows = parseCSV(text);
  console.log(`[cache] ${label}: ${rows.length} rows loaded`);
  return rows;
}

async function refreshCache() {
  cache.status = 'loading';
  try {
    const [hyd, del, pun] = await Promise.all([
      fetchStore('hyderabad'),
      fetchStore('delhi'),
      fetchStore('pune'),
    ]);
    cache.hyderabad = hyd;
    cache.delhi     = del;
    cache.pune      = pun;
    cache.lastFetched = new Date();
    cache.status = 'ready';
    console.log(`[cache] All stores refreshed at ${cache.lastFetched.toISOString()}`);
  } catch (err) {
    cache.status = 'error';
    console.error('[cache] Refresh failed:', err.message);
  }
}

// Schedule daily refresh at 10:00 AM IST (04:30 UTC)
function scheduleDailyRefresh() {
  const now = new Date();
  const nextRefresh = new Date();
  nextRefresh.setUTCHours(4, 30, 0, 0); // 10:00 AM IST = 04:30 UTC
  if (nextRefresh <= now) nextRefresh.setUTCDate(nextRefresh.getUTCDate() + 1);
  const msUntil = nextRefresh - now;
  console.log(`[cache] Next auto-refresh in ${Math.round(msUntil / 60000)} minutes`);
  setTimeout(() => {
    refreshCache();
    setInterval(refreshCache, 24 * 60 * 60 * 1000); // then every 24h
  }, msUntil);
}

// ── Search helpers ────────────────────────────────────────────────────────────
function normalize(str) {
  return (str || '').toLowerCase().trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function fuzzyMatch(query, target) {
  const q = normalize(query), t = normalize(target);
  if (t.includes(q)) return true;
  if (q.length <= 3) return false;
  // Allow 1 typo per 5 chars
  const threshold = Math.floor(q.length / 5);
  return levenshtein(q, t.slice(0, q.length + 2)) <= threshold;
}

function mapRow(row) {
  return {
    itemCode:          row['Item Code']           || '',
    barcode:           row['BARCODE']              || '',
    brand:             row['Brand']               || '',
    batchNo:           row['Batch no']            || '',
    expiryDate:        row['Expiry Date']          || '',
    vendorArticleId:   row['Vendor Article ID']   || '',
    vendorArticleName: row['Vendor Article Name'] || '',
    division:          row['Division']            || '',
    section:           row['Section']             || '',
    department:        row['Department']          || '',
    itemName:          row['Item Name']           || '',
    size:              row['Size']                || '',
    mrp:               row['MRP']                 || '',
    rsp:               row['RSP']                 || '',
    warehouseStock:    row['Ware house stock']    || '0',
    storeStock:        row['Store stock']         || '0',
    salesQty60D:       row['Sales Qty (60D)']     || '0',
  };
}

function searchRows(rows, query, type) {
  const q = normalize(query);
  return rows
    .filter(row => {
      const r = mapRow(row);
      if (type === 'barcode') return normalize(r.barcode).includes(q);
      if (type === 'brand')   return normalize(r.brand).includes(q);
      if (type === 'product') return fuzzyMatch(q, r.itemName) || fuzzyMatch(q, r.vendorArticleName);
      return false;
    })
    .map(mapRow);
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Cache status
app.get('/api/status', (req, res) => {
  res.json({
    status: cache.status,
    lastFetched: cache.lastFetched,
    counts: {
      hyderabad: cache.hyderabad.length,
      delhi: cache.delhi.length,
      pune: cache.pune.length,
    }
  });
});

// Manual refresh (admin use)
app.post('/api/refresh', async (req, res) => {
  await refreshCache();
  res.json({ ok: true, lastFetched: cache.lastFetched });
});

// Search
app.get('/api/search', (req, res) => {
  const { q, type, store } = req.query;
  if (!q || !type || !store) {
    return res.status(400).json({ error: 'Missing q, type, or store' });
  }
  if (cache.status !== 'ready') {
    return res.status(503).json({ error: 'Data not ready yet', status: cache.status });
  }

  const primaryKey = store.toLowerCase();
  const secondaryKeys = Object.keys(STORES).filter(k => k !== primaryKey);

  const primaryResults   = searchRows(cache[primaryKey] || [], q, type)
    .map(r => ({ ...r, store: STORES[primaryKey]?.label || primaryKey, isPrimary: true }));

  const secondaryResults = secondaryKeys.flatMap(k =>
    searchRows(cache[k] || [], q, type)
      .map(r => ({ ...r, store: STORES[k]?.label || k, isPrimary: false }))
  );

  res.json({
    primary: primaryResults,
    secondary: secondaryResults,
    total: primaryResults.length + secondaryResults.length,
    lastFetched: cache.lastFetched,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await refreshCache();       // load data immediately on boot
  scheduleDailyRefresh();     // then auto-refresh at 10 AM IST daily
});
