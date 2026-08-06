# Container Tracking Dashboard (live)

A self-contained dashboard that reads five Monday.com boards live and renders
them with no login required. `index.html` is a single self-contained page
(React/Recharts inlined); `api/monday-data.js` is a Vercel serverless function
that holds the Monday.com API token server-side and proxies the live data —
the token never reaches the browser.

## One-time setup

1. **Generate a Monday.com API token**: in Monday.com, click your avatar →
   **Admin** → **API** (or **Developers** → **My Access Tokens**). Copy the
   token.
2. **Import this repo into Vercel**: from the Vercel dashboard, "Add New →
   Project", pick this repo.
3. **Add the token as an environment variable**: in the new Vercel project →
   **Settings → Environment Variables**, add:
   - Name: `MONDAY_API_TOKEN`
   - Value: (paste the token you generated)
   - Apply to Production (and Preview if you want preview deploys to work too)

   Enter it directly in Vercel's UI — don't paste it anywhere else.
4. Deploy. Every push to the connected branch redeploys automatically.

## What it does

- On every page load, the browser calls `/api/monday-data`.
- That function fetches the five boards from Monday.com's GraphQL API,
  paginating as needed, and reshapes each into `{ group, item, sub }` records
  — one record per container (subitem).
- The browser then runs the same field-mapping/merge/duplicate-detection
  logic the dashboard has always used, unchanged.

## Board IDs (hardcoded in `api/monday-data.js`)

| Key | Board | ID |
|---|---|---|
| SCS | 4.1 SCS Orders 订单 | 2683952804 |
| VIP | VIP CTN | 8111094762 |
| NAVIP | NORTH AMERICAN VIP-CTN | 8503068145 |
| FL | Florida Customer -CTN Tracking | 8089648863 |
| NACTN | NORTH AMERICAN-CTN | 8111460049 |

If a board gets recreated (new ID), update the `BOARDS` map in
`api/monday-data.js`.
