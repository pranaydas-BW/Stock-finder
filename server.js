const express = require('express');
const { parse } = require('csv-parse/sync');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const SHEET_ID = '1Uo7OtHVekjsuTSfVodzUNqkL5dtOneM1GwPn85OG_gM';

const STORES = {
  hyderabad: { label: 'Hyderabad', gid: '0' },
  delhi:     { label: 'Delhi',     gid: '2053559649' },
  pune:      { label: 'Pune',      gid: '688522673'  },
};

async function fetchSheet(gid) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  const text = await res.text();
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
  return rows;
}

function normalize(str) {
  return (str || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function fuzzyScore(query, target) {
  const q = normalize(query);
  const t = normalize(target);
  if (!q || !t) return 0;
  if (t === q) return 1.0;
  if (t.includes(q)) return 0.9;
  const words = q.split(' ');
  const matchedWords = words.filter(w => t.includes(w));
  return matchedWords.length / words.length * 0.7;
}

function mapRow(row, store) {
  return {
    store,
    itemCode:          row['Item Code']           || '',
    barcode:           row['BARCODE']             || '',
    brand:             row['Brand']               || '',
    batchNo:           row['Batch no']            || '',
    expiryDate:        row['Expiry Date']         || '',
    vendorArticleId:   row['Vendor Article ID']   || '',
    vendorArticleName: row['Vendor Article Name'] || '',
    division:          row['Division']            || '',
    section:           row['Section']             || '',
    department:        row['Department']          || '',
    node:              row['Node']                || '',
    itemName:          row['Item Name']           || '',
    sampleFlag:        row['Sample Flag']         || '',
    size:              row['Size']                || '',
    mrp:               row['MRP']                 || '',
    rsp:               row['RSP']                 || '',
    warehouseStock:    parseInt(row['Ware house stock']) || 0,
    storeStock:        parseInt(row['Store stock'])      || 0,
    salesQty60d:       parseInt(row['Sales Qty (60D)'])  || 0,
    firstGrnDate:      row['First GRN Date']      || '',
    lastGrnDate:       row['Last GRN Date']       || '',
    styleGroupId:      row['Style Group ID']      || '',
  };
}

app.get('/api/search', async (req, res) => {
  const { query, type, store } = req.query;
  if (!query || !type || !store) {
    return res.status(400).json({ error: 'query, type and store are required' });
  }

  try {
    const primaryStore = STORES[store];
    if (!primaryStore) return res.status(400).json({ error: 'Invalid store' });

    const otherStores = Object.entries(STORES).filter(([k]) => k !== store);

    const [primaryRows, ...otherRows] = await Promise.all([
      fetchSheet(primaryStore.gid),
      ...otherStores.map(([, s]) => fetchSheet(s.gid)),
    ]);

    const primaryMapped = primaryRows.map(r => mapRow(r, primaryStore.label));
    const otherMapped = otherStores.flatMap(([, s], i) =>
      otherRows[i].map(r => mapRow(r, s.label))
    );

    const allRows = [...primaryMapped, ...otherMapped];
    const q = normalize(query);

    let results = [];

    if (type === 'barcode') {
      results = allRows.filter(r =>
        normalize(r.barcode).includes(q) || r.barcode === query
      );
    } else if (type === 'brand') {
      results = allRows.filter(r =>
        normalize(r.brand).includes(q)
      );
    } else if (type === 'product') {
      results = allRows
        .map(r => ({
          ...r,
          _score: Math.max(
            fuzzyScore(query, r.itemName),
            fuzzyScore(query, r.vendorArticleName)
          ),
        }))
        .filter(r => r._score > 0.3)
        .sort((a, b) => b._score - a._score);
    }

    const primary = results.filter(r => r.store === primaryStore.label);
    const secondary = results.filter(r => r.store !== primaryStore.label);

    res.json({ primary, secondary, store: primaryStore.label });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stores', (req, res) => {
  res.json(Object.entries(STORES).map(([key, val]) => ({ key, label: val.label })));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
