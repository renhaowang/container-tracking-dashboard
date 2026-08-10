/* Runs once a day via .github/workflows/daily-snapshot.yml, independent of
   whether anyone opens the dashboard. Pulls live data through the same
   serverless proxy the browser uses, computes the same KPI snapshot the
   client computes in computeSnapshot() (Container Tracking Dashboard.jsx),
   and commits it into data/history.json — which Vercel serves as a static
   file at /data/history.json for every browser to merge into its own
   (never-deleted) local trend history. */

const fs = require("fs");
const path = require("path");

const SITE_URL = process.env.DASHBOARD_URL || "https://container-tracking-dashboard.vercel.app";
const HISTORY_PATH = path.join(__dirname, "..", "data", "history.json");

const BOARD_LIST = [{ id: "SCS" }, { id: "VIP" }, { id: "NAVIP" }, { id: "FL" }, { id: "NACTN" }];

/* Only the fields computeSnapshot() needs — a trimmed copy of FIELDS from the
   dashboard source, kept in sync by hand since this script has no bundler to
   share code with the browser build. */
const FIELDS = {
  status: { SCS: ["S", "Container Status"], VIP: ["S", "Ship Status"], NAVIP: ["S", "Ship Status"], FL: ["S", "Shipping Status"], NACTN: ["S", "Ship Status"] },
  railEta: { SCS: ["S", "ETA to Rail"], VIP: ["S", "Rail ETA"], NAVIP: ["S", "Rail ETA"], NACTN: ["S", "Rail ETA"] },
  lfd: { "*": ["S", "LFD"] },
  deliveryDate: { SCS: ["S", "Delivery Date"], VIP: ["S", "Deliver Date"], NAVIP: ["S", "Deliver Date"], FL: ["S", "Delivery Date"], NACTN: ["S", "Deliver Date"] },
  pulloutDate: { SCS: ["S", "PULLOUTDATE"], NAVIP: ["S", "PULLOUTDATE"], FL: ["S", "PULLOUTDATE"], NACTN: ["S", "PULLOUTDATE"] },
};

const blank = v => v === null || v === undefined || v === "";
const excludedGroup = g => { g = (g || "").trim().toLowerCase(); return g.startsWith("received") || g.startsWith("projects completed"); };
const isDate = v => v instanceof Date && !isNaN(v);
const dkey = d => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
const fmtD = v => isDate(v) ? `${v.getMonth() + 1}/${v.getDate()}/${v.getFullYear()}` : (v == null ? "" : String(v));

function normDate(v) {
  if (blank(v)) return null;
  if (typeof v === "string") {
    const s = v.trim();
    let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) { let y = +m[3]; if (y < 100) y += 2000; return new Date(y, +m[1] - 1, +m[2]); }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    return s;
  }
  return v;
}

function canonicalStatus(raw) {
  const s = String(raw || "").trim();
  if (!s) return "(blank)";
  const stripped = s.replace(/^\d+\.?\s*/, "").trim() || s;
  if (/on water/i.test(stripped)) return "On Water";
  if (/^delivered$/i.test(stripped)) return "Delivered";
  return stripped;
}

function fieldValue(key, boardId, sub) {
  const m = FIELDS[key][boardId] || FIELDS[key]["*"];
  if (!m) return null;
  const v = sub[m[1]];
  return v === undefined ? null : v;
}

async function main() {
  const res = await fetch(`${SITE_URL}/api/monday-data`);
  if (!res.ok) throw new Error(`monday-data fetch failed: HTTP ${res.status}`);
  const matched = await res.json();

  const rows = [];
  for (const b of BOARD_LIST) {
    const m = matched[b.id];
    if (!m) continue;
    for (const rec of m.records) {
      if (excludedGroup(rec.group)) continue;
      const status = fieldValue("status", b.id, rec.sub);
      rows.push({
        status: status == null ? null : String(status).trim(),
        railEta: normDate(fieldValue("railEta", b.id, rec.sub)),
        lfd: normDate(fieldValue("lfd", b.id, rec.sub)),
        deliveryDate: normDate(fieldValue("deliveryDate", b.id, rec.sub)),
        pulloutDate: normDate(fieldValue("pulloutDate", b.id, rec.sub)),
      });
    }
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayK = dkey(today);

  let delivered = 0, passedRail = 0, demurrage = 0;
  const statusCounts = {};
  for (const r of rows) {
    const st = String(r.status || "").toLowerCase();
    const isDelivered = isDate(r.deliveryDate) || st.includes("deliver");
    if (String(r.status || "").trim() === "Delivered") delivered++;
    if (isDate(r.railEta) && dkey(r.railEta) < todayK && !isDelivered) passedRail++;
    if (isDate(r.lfd) && dkey(r.lfd) < todayK && !isDate(r.deliveryDate) && !isDate(r.pulloutDate)) demurrage++;
    const cs = canonicalStatus(r.status);
    statusCounts[cs] = (statusCounts[cs] || 0) + 1;
  }

  const snapshot = {
    date: fmtD(today),
    dateKey: todayK,
    loadedAt: now.toISOString(),
    total: rows.length,
    delivered, passedRail, demurrage,
    statusCounts,
  };

  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")); } catch (e) { history = []; }
  if (!Array.isArray(history)) history = [];
  history = history.filter(s => s.dateKey !== snapshot.dateKey);
  history.push(snapshot);
  history.sort((a, b) => a.dateKey - b.dateKey);

  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");
  console.log(`Snapshot recorded for ${snapshot.date}: total=${snapshot.total} delivered=${delivered} passedRail=${passedRail} demurrage=${demurrage}`);
}

main().catch(e => { console.error(e); process.exit(1); });
