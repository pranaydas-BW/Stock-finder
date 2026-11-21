# Stock Finder App

A mobile-friendly web app for searching stock across Hyderabad, Delhi, and Pune stores.

## Features
- Search by Barcode, Brand, or Product name (fuzzy)
- Live fetch from Google Sheets on every search
- Floor vs Warehouse stock with color-coded badges (green = in stock, red = zero)
- Selected store shown first, other stores as secondary
- Mobile-optimised UI

## Setup & Deploy on Render

### 1. Get the correct Sheet GIDs
Open your Google Sheet and click each tab:
- **BH HYD** tab → look at URL: `...#gid=XXXXXX` → that's the Hyderabad GID
- **VK Delhi** tab → note the GID
- **Pune** tab → note the GID

Update `server.js` lines ~10–14:
```js
const STORES = {
  hyderabad: { label: 'Hyderabad', gid: 'YOUR_HYD_GID' },
  delhi:     { label: 'Delhi',     gid: 'YOUR_DELHI_GID' },
  pune:      { label: 'Pune',      gid: 'YOUR_PUNE_GID'  },
};
```

### 2. Make the Google Sheet public
- Open the sheet → Share → Change to "Anyone with the link can view"

### 3. Deploy on Render (free tier)
1. Push this folder to a GitHub repo
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Environment**: Node
5. Click Deploy

Your app will be live at `https://your-app-name.onrender.com`

## Local development
```bash
npm install
npm start
# Open http://localhost:3000
```

## Offers (from Promo Hub)

Item cards show any offer that is live today for that barcode (or for the whole brand) in the city being searched.

The data comes from Promo Hub's `offers` Supabase Edge Function. Set these in Render → Environment:

| Variable | Value |
|---|---|
| `OFFERS_URL` | the `offers` function URL (`https://<project-ref>.supabase.co/functions/v1/offers`) |
| `OFFERS_SECRET` | the same secret saved as `OFFERS_SECRET` in Supabase → Edge Functions → Secrets |
| `OFFERS_ANON_KEY` | only if the function has "Verify JWT" on: the project's public anon key |

Without `OFFERS_URL` and `OFFERS_SECRET` the feature is off and nothing else changes. The feed refreshes every 15 minutes; if it cannot be refreshed for 12 hours, offers are hidden rather than shown stale. `/api/status` shows the offers feed state (never the secret).
