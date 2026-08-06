/* Serverless proxy: fetches the five Monday.com boards live and shapes them into
   the same {group, item, sub} record layout the dashboard's client-side logic
   (buildRow / buildDallas / duplicate detection) already expects. The Monday.com
   API token stays server-side only — it is never sent to the browser. */

const MONDAY_API_URL = "https://api.monday.com/v2";

/* board key -> { id, name } — name is used only as a friendly "loaded from" label */
const BOARDS = {
  SCS: { id: 2683952804, name: "4.1 SCS Orders 订单" },
  VIP: { id: 8111094762, name: "VIP CTN" },
  NAVIP: { id: 8503068145, name: "NORTH AMERICAN VIP-CTN" },
  FL: { id: 8089648863, name: "Florida Customer -CTN Tracking" },
  NACTN: { id: 8111460049, name: "NORTH AMERICAN-CTN" },
};

const PAGE_SIZE = 100;

async function mondayFetch(token, query, variables) {
  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    const msg = (json.errors && json.errors.map(e => e.message).join("; ")) || ("HTTP " + res.status);
    throw new Error("Monday.com API error: " + msg);
  }
  return json.data;
}

const ITEMS_PAGE_QUERY = `
  query($boardId: [ID!], $limit: Int!) {
    boards(ids: $boardId) {
      items_page(limit: $limit) {
        cursor
        items {
          name
          group { title }
          column_values { title text }
          subitems { name column_values { title text } }
        }
      }
    }
  }
`;

const NEXT_PAGE_QUERY = `
  query($cursor: String!, $limit: Int!) {
    next_items_page(limit: $limit, cursor: $cursor) {
      cursor
      items {
        name
        group { title }
        column_values { title text }
        subitems { name column_values { title text } }
      }
    }
  }
`;

function colValuesToObject(item) {
  const obj = { Name: item.name };
  for (const cv of item.column_values || []) {
    if (cv.title && !(cv.title in obj)) obj[cv.title] = cv.text;
  }
  return obj;
}

/* One output record per subitem/container — items with zero subitems produce
   no records, matching the original Excel-export pipeline's behavior. */
function itemsToRecords(items) {
  const out = [];
  for (const it of items) {
    const group = it.group ? it.group.title : null;
    const itemObj = colValuesToObject(it);
    for (const sub of it.subitems || []) {
      out.push({ group, item: itemObj, sub: colValuesToObject(sub) });
    }
  }
  return out;
}

async function fetchBoard(token, boardId) {
  const first = await mondayFetch(token, ITEMS_PAGE_QUERY, { boardId: [String(boardId)], limit: PAGE_SIZE });
  const board = first.boards && first.boards[0];
  if (!board) return [];
  let records = itemsToRecords(board.items_page.items);
  let cursor = board.items_page.cursor;
  while (cursor) {
    const next = await mondayFetch(token, NEXT_PAGE_QUERY, { cursor, limit: PAGE_SIZE });
    records = records.concat(itemsToRecords(next.next_items_page.items));
    cursor = next.next_items_page.cursor;
  }
  return records;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    res.status(500).json({ error: "Server is missing MONDAY_API_TOKEN — set it in the Vercel project's Environment Variables." });
    return;
  }

  const boardKeys = Object.keys(BOARDS);
  const results = await Promise.allSettled(
    boardKeys.map(key => fetchBoard(token, BOARDS[key].id))
  );

  const out = {};
  const errors = [];
  results.forEach((r, i) => {
    const key = boardKeys[i];
    if (r.status === "fulfilled") {
      out[key] = { fname: BOARDS[key].name, records: r.value };
    } else {
      errors.push(key + ": " + (r.reason && r.reason.message ? r.reason.message : String(r.reason)));
    }
  });

  if (errors.length) console.error("monday-data partial failure:", errors.join(" | "));

  if (Object.keys(out).length === 0) {
    res.status(502).json({ error: "Could not load any board from Monday.com. " + errors.join(" | ") });
    return;
  }

  res.status(200).json(out);
};
