const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const SHEET_ID = '1Uo7OtHVekjsuTSfVodzUNqkL5dtOneM1GwPn85OG_gM';
const STORES = {
  hyderabad: { gid: '0',          label: 'Hyderabad' },
  delhi:     { gid: '2053559649', label: 'Delhi'     },
  pune:     { gid: '688522673',  label: 'Pune'      },
  mumbai:   { gid: '144905209',  label: 'Mumbai'    },
};
function csvUrl(gid) { return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`; }

const KEEP_COLS = new Set(['BARCODE','Brand','Vendor Article Name','Item Name','Size','MRP','RSP','Expiry Date','Ware house stock','Store stock','Style Group ID','Division','Section','Department']);
const cache = { hyderabad:[], delhi:[], pune:[], mumbai:[], lastFetched:null, status:'empty' };
const brandIndex = { hyderabad:[], delhi:[], pune:[], mumbai:[] };
const sizeIndex  = { hyderabad:[], delhi:[], pune:[], mumbai:[] };
const taxIndex   = { hyderabad:{}, delhi:{}, pune:{}, mumbai:{} };

function parseCSVLean(text) {
  // Replace newlines inside quoted fields with a space before splitting
  text = text.replace(/"[^"]*"/g, m => m.replace(/\n/g, ' '));
  const lines = text.split('\n'); if (lines.length < 2) return [];
  const splitLine = (line) => {
    const cols=[]; let start=0, inQ=false;
    for (let i=0;i<=line.length;i++) {
      const c=line[i];
      if (c==='"'){inQ=!inQ;continue;}
      if ((c===','||i===line.length)&&!inQ){cols.push(line.slice(start,i).replace(/^"|"$/g,'').trim());start=i+1;}
    }
    return cols;
  };
  const rawHeaders=splitLine(lines[0]).map(h=>h.replace(/^\uFEFF/,'').trim());
  const idx={}; rawHeaders.forEach((h,i)=>{if(KEEP_COLS.has(h))idx[h]=i;});
  const iBC=idx['BARCODE']??-1,iBrand=idx['Brand']??-1,iVAN=idx['Vendor Article Name']??-1;
  const iName=idx['Item Name']??-1,iSize=idx['Size']??-1,iMRP=idx['MRP']??-1,iRSP=idx['RSP']??-1;
  const iExp=idx['Expiry Date']??-1,iWH=idx['Ware house stock']??-1,iFloor=idx['Store stock']??-1;
  const iStyle=idx['Style Group ID']??-1,iDiv=idx['Division']??-1,iSec=idx['Section']??-1,iDep=idx['Department']??-1;
  const rows=[];
  for (let i=1;i<lines.length;i++) {
    const line=lines[i]; if(!line.trim())continue;
    const v=splitLine(line);
    const bc=iBC>=0?(v[iBC]||'').trim():'',iname=iName>=0?(v[iName]||'').trim():'',van=iVAN>=0?(v[iVAN]||'').trim():'';
    if(!bc&&!iname&&!van)continue;
    rows.push({bc,van,iname,brand:iBrand>=0?(v[iBrand]||'').trim():'',size:iSize>=0?(v[iSize]||'').trim():'',
      mrp:(()=>{const m=iMRP>=0?(v[iMRP]||'').trim():'';const r=iRSP>=0?(v[iRSP]||'').trim():'';return r?m+'|'+r:m;})(),exp:iExp>=0?(v[iExp]||'').trim():'',
      wh:iWH>=0?(v[iWH]||'0').trim():'0',floor:iFloor>=0?(v[iFloor]||'0').trim():'0',
      style:iStyle>=0?(v[iStyle]||'').trim():'',div:iDiv>=0?(v[iDiv]||'').trim():'',
      sec:iSec>=0?(v[iSec]||'').trim():'',dep:iDep>=0?(v[iDep]||'').trim():'',
    });
  }
  return rows;
}

async function fetchStore(storeKey) {
  const {gid,label}=STORES[storeKey]; const t0=Date.now();
  console.log(`[cache] Fetching ${label}...`);
  const res=await fetch(csvUrl(gid)); if(!res.ok)throw new Error(`HTTP ${res.status} for ${label}`);
  const fetchMs=Date.now()-t0; const text=await res.text(); const downloadMs=Date.now()-t0-fetchMs;
  const rows=parseCSVLean(text); const parseMs=Date.now()-t0-fetchMs-downloadMs;
  console.log(`[cache] ${label}: ${rows.length} rows | fetch:${fetchMs}ms download:${downloadMs}ms parse:${parseMs}ms | heap:${Math.round(process.memoryUsage().heapUsed/1024/1024)}MB`);
  return rows;
}

function buildIndexes(storeKey) {
  const brands=new Set(),sizes=new Set(),tax={};
  for (const row of cache[storeKey]) {
    if(row.brand)brands.add(row.brand); if(row.size)sizes.add(row.size);
    const d=row.div||'(No Division)',s=row.sec||'(No Section)',p=row.dep||'(No Department)';
    if(!tax[d])tax[d]={}; if(!tax[d][s])tax[d][s]={}; if(!tax[d][s][p])tax[d][s][p]=new Set();
    if(row.brand)tax[d][s][p].add(row.brand);
  }
  brandIndex[storeKey]=[...brands].sort((a,b)=>a.localeCompare(b));
  sizeIndex[storeKey]=[...sizes].sort((a,b)=>a.localeCompare(b));
  for(const d of Object.keys(tax))for(const s of Object.keys(tax[d]))for(const p of Object.keys(tax[d][s]))tax[d][s][p]=[...tax[d][s][p]].sort();
  taxIndex[storeKey]=tax;
  console.log(`[index] ${storeKey}: ${brandIndex[storeKey].length} brands, ${sizeIndex[storeKey].length} sizes, ${Object.keys(tax).length} divisions`);
}

async function refreshCache() {
  cache.status='loading'; const t0=Date.now();
  try {
    const [hyd,del,pun,mum]=await Promise.all([fetchStore('hyderabad'),fetchStore('delhi'),fetchStore('pune'),fetchStore('mumbai')]);
    cache.hyderabad=hyd;cache.delhi=del;cache.pune=pun;cache.mumbai=mum;
    for(const k of ['hyderabad','delhi','pune','mumbai'])buildIndexes(k);
    cache.lastFetched=new Date();cache.status='ready';
    console.log(`[cache] All done in ${Date.now()-t0}ms | heap:${Math.round(process.memoryUsage().heapUsed/1024/1024)}MB`);
  } catch(err){cache.status='error';console.error('[cache] Refresh failed:',err.message);}
}

function scheduleDailyRefresh() {
  const now=new Date(),next=new Date(); next.setUTCHours(4,30,0,0);
  if(next<=now)next.setUTCDate(next.getUTCDate()+1);
  const ms=next-now; console.log(`[cache] Next auto-refresh in ${Math.round(ms/60000)} min`);
  setTimeout(()=>{refreshCache();setInterval(refreshCache,24*60*60*1000);},ms);
}

function norm(s){return(s||'').toLowerCase().trim();}
function tokenize(s){return norm(s).split(/[\s\-_/]+/).filter(t=>t.length>0);}
function levenshtein(a,b){
  const m=a.length,n=b.length; if(Math.abs(m-n)>3)return 99;
  const dp=Array.from({length:m+1},(_,i)=>Array.from({length:n+1},(_,j)=>i===0?j:j===0?i:0));
  for(let i=1;i<=m;i++)for(let j=1;j<=n;j++)dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}
function tokenFuzzy(qt,tt){if(tt.includes(qt))return true;if(qt.length<=2)return qt===tt;return levenshtein(qt,tt)<=(qt.length<=4?1:2);}
function fuzzyScore(query,target){
  const q=norm(query),t=norm(target); if(!q||!t)return 0; if(t.includes(q))return 100;
  const qT=tokenize(query),tT=tokenize(target); if(!qT.length)return 0;
  let matched=0; for(const qt of qT)for(const tt of tT)if(tokenFuzzy(qt,tt)){matched++;break;}
  const r=matched/qT.length; if(r===1)return 80;if(r>=0.7)return 50;return 0;
}
function toCard(row,storeName){const[mrp,rsp]=(row.mrp||'').split('|');return{barcode:row.bc,brand:row.brand,vendorArticleName:row.van,itemName:row.iname,size:row.size,mrp,rsp:rsp||'',expiryDate:row.exp,warehouseStock:row.wh,storeStock:row.floor,store:storeName,styleId:row.style};}
function hasStock(card){return(parseInt(card.storeStock)||0)>0||(parseInt(card.warehouseStock)||0)>0;}

app.use(express.static(path.join(__dirname,'public')));
app.get('/api/status',(req,res)=>res.json({status:cache.status,lastFetched:cache.lastFetched,counts:{hyderabad:cache.hyderabad.length,delhi:cache.delhi.length,pune:cache.pune.length,mumbai:cache.mumbai.length},heapMB:Math.round(process.memoryUsage().heapUsed/1024/1024)}));
app.post('/api/refresh',(req,res)=>{refreshCache();res.json({ok:true});});
app.get('/api/brands',(req,res)=>{const{store}=req.query;if(!store)return res.status(400).json({error:'Missing store.'});if(cache.status!=='ready')return res.status(503).json({error:'Data not ready.'});res.json({brands:brandIndex[store.toLowerCase()]||[]});});

app.get('/api/taxonomy',(req,res)=>{
  const{store,div,sec}=req.query; if(!store)return res.status(400).json({error:'Missing store.'});
  if(cache.status!=='ready')return res.status(503).json({error:'Data not ready.'});
  const idx=taxIndex[store.toLowerCase()]||{};
  if(!div)return res.json({divisions:Object.keys(idx).sort()});
  const divData=idx[div]||{}; if(!sec)return res.json({sections:Object.keys(divData).sort()});
  return res.json({departments:Object.keys(divData[sec]||{}).sort()});
});

app.get('/api/sizes-list',(req,res)=>{
  const{store,brand,div,sec,dep}=req.query; if(!store)return res.status(400).json({error:'Missing store.'});
  if(cache.status!=='ready')return res.status(503).json({error:'Data not ready.'});
  const pk=store.toLowerCase();
  if(brand||div||sec||dep){
    const pool=cache[pk].filter(r=>{
      if(brand&&norm(r.brand)!==norm(brand))return false;
      if(div&&norm(r.div)!==norm(div))return false;
      if(sec&&norm(r.sec)!==norm(sec))return false;
      if(dep&&norm(r.dep)!==norm(dep))return false;
      return true;
    });
    return res.json({sizes:[...new Set(pool.map(r=>r.size).filter(Boolean))].sort()});
  }
  res.json({sizes:sizeIndex[pk]||[]});
});

app.get('/api/browse',(req,res)=>{
  try {
    const{store,div,sec,dep,brand,size}=req.query; if(!store)return res.status(400).json({error:'Missing store.'});
    if(cache.status!=='ready')return res.status(503).json({error:'Data not ready.'});
    const pk=store.toLowerCase();
    const sizeSet=size?new Set(size.split(',').map(s=>norm(s))):null;
    const pool=cache[pk].filter(r=>{
      if(div&&norm(r.div)!==norm(div))return false;
      if(sec&&norm(r.sec)!==norm(sec))return false;
      if(dep&&norm(r.dep)!==norm(dep))return false;
      if(brand&&norm(r.brand)!==norm(brand))return false;
      if(sizeSet&&!sizeSet.has(norm(r.size)))return false;
      return true;
    });
    const brandMap={};
    for(const row of pool){
      const b=row.brand||'(No Brand)'; if(!brandMap[b])brandMap[b]={brand:b,total:0,inStock:0};
      brandMap[b].total++; if((parseInt(row.floor)||0)>0||(parseInt(row.wh)||0)>0)brandMap[b].inStock++;
    }
    const brands=Object.values(brandMap).sort((a,b)=>b.inStock-a.inStock||a.brand.localeCompare(b.brand));
    res.json({brands,total:brands.length});
  } catch(err){res.status(500).json({error:'Internal error: '+err.message});}
});

app.get('/api/brand-products',(req,res)=>{
  try {
    const{store,brand,div,sec,dep,size}=req.query; if(!store||!brand)return res.status(400).json({error:'Missing store or brand.'});
    if(cache.status!=='ready')return res.status(503).json({error:'Data not ready.'});
    const pk=store.toLowerCase(),storeName=STORES[pk]?.label||pk,bn=norm(brand);
    const sizeSet=size?new Set(size.split(',').map(s=>norm(s))):null;
    const results=cache[pk].filter(r=>{
      if(norm(r.brand)!==bn)return false;
      if(div&&norm(r.div)!==norm(div))return false;
      if(sec&&norm(r.sec)!==norm(sec))return false;
      if(dep&&norm(r.dep)!==norm(dep))return false;
      if(sizeSet&&!sizeSet.has(norm(r.size)))return false;
      return true;
    }).map(r=>toCard(r,storeName));
    results.sort((a,b)=>(hasStock(b)?1:0)-(hasStock(a)?1:0));
    res.json({products:results,total:results.length});
  } catch(err){res.status(500).json({error:'Internal error: '+err.message});}
});

app.get('/api/search',(req,res)=>{
  try {
    const{q,brand,store}=req.query; if(!q||!store)return res.status(400).json({error:'Missing q or store.'});
    if(cache.status==='loading')return res.status(503).json({error:'Still loading — please wait.'});
    if(cache.status==='error')return res.status(503).json({error:'Data failed to load. Click Refresh.'});
    if(cache.status!=='ready')return res.status(503).json({error:'Not ready yet.'});
    const pk=store.toLowerCase();
    const pool=brand?cache[pk].filter(r=>norm(r.brand)===norm(brand)):cache[pk];
    const qn=norm(q),scored=[];
    const isBarcodeQuery=/^\d+$/.test(qn);
    for(const row of pool){
      let score=norm(row.bc).includes(qn)?100:0;
      if(score===0&&!isBarcodeQuery)score=Math.max(fuzzyScore(q,row.iname),fuzzyScore(q,row.van));
      if(score>0)scored.push({score,card:toCard(row,STORES[pk]?.label||pk)});
    }
    if(isBarcodeQuery&&scored.length===0){
      for(const row of pool){
        const score=Math.max(fuzzyScore(q,row.iname),fuzzyScore(q,row.van));
        if(score>0)scored.push({score,card:toCard(row,STORES[pk]?.label||pk)});
      }
    }
    scored.sort((a,b)=>{const aS=hasStock(a.card)?1:0,bS=hasStock(b.card)?1:0;if(bS!==aS)return bS-aS;return b.score-a.score;});
    res.json({primary:scored.map(s=>s.card),total:scored.length,lastFetched:cache.lastFetched});
  } catch(err){res.status(500).json({error:'Internal error: '+err.message});}
});

app.get('/api/style',(req,res)=>{
  try {
    const{styleId,store}=req.query; if(!styleId||!store)return res.status(400).json({error:'Missing styleId or store.'});
    if(cache.status!=='ready')return res.status(503).json({error:'Data not ready.'});
    const pk=store.toLowerCase(),storeName=STORES[pk]?.label||pk;
    const results=cache[pk].filter(r=>norm(r.style)===norm(styleId)).map(r=>toCard(r,storeName));
    results.sort((a,b)=>(hasStock(b)?1:0)-(hasStock(a)?1:0));
    res.json({items:results,total:results.length});
  } catch(err){res.status(500).json({error:'Internal error: '+err.message});}
});

app.use((req,res)=>res.status(404).json({error:'Not found'}));
app.use((err,req,res,next)=>res.status(500).json({error:'Server error: '+(err.message||'Unknown')}));

function startKeepAlive() {
  const RENDER_URL=process.env.RENDER_EXTERNAL_URL;
  if(!RENDER_URL){console.log('[keep-alive] Skipping (local)');return;}
  const isActive=()=>{const m=new Date().getUTCHours()*60+new Date().getUTCMinutes();return m>=150&&m<=990;};
  setInterval(async()=>{
    if(!isActive())return;
    try{const r=await fetch(`${RENDER_URL}/api/status`);console.log(`[keep-alive] Ping ${r.status}`);}
    catch(e){console.warn('[keep-alive] Failed:',e.message);}
  },14*60*1000);
  console.log('[keep-alive] Started');
}

app.listen(PORT,async()=>{
  console.log(`Server on port ${PORT}`);
  await refreshCache(); scheduleDailyRefresh(); startKeepAlive();
});
