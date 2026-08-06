/* Serverless proxy: fetches the five Monday.com boards live and shapes them into
   the same {group, item, sub} record layout the dashboard's client-side logic
   (buildRow / buildDallas / duplicate detection) already expects. The Monday.com
   API token stays server-side only — it is never sent to the browser.

   Column IDs below were resolved once against the live schema (board columns +
   linked subitems-board columns), filtered down to exactly the titles the
   dashboard's FIELDS mapping reads. Fetching only these — instead of every
   column on the board (60+ on some boards, including file attachments and
   unused formulas) — cuts NACTN's response from ~14MB/~34s to a few hundred
   KB and ~15-20s. The remaining time is Monday's own per-item subitem
   resolution cost for that board's ~620 items and isn't reducible via paging
   or column selection; if it needs to be faster later, the fix is caching
   (fetch on a schedule, serve the cached copy) rather than more query tuning. */

const MONDAY_API_URL = "https://api.monday.com/v2";
const PAGE_SIZE = 500; /* Monday's documented max for items_page */

const BOARDS = {
  SCS: {
    id: 2683952804, name: "4.1 SCS Orders 订单",
    itemIds: ["last_updated"],
    subIds: ["color_mm21wkyt", "status", "text86__1", "text__1", "link__1", "text0__1", "text6__1",
      "mbl3__1", "dup__of_etd__1", "dup__of_etd_mkm19sdc", "color_mknmjc2y", "text64__1", "date0",
      "date", "date_1", "date_mkzhsdrq", "date_mkrmkp60", "date_mkvwkpaf", "text2__1", "text09", "date_mm35tc4t"],
  },
  VIP: {
    id: 8111094762, name: "VIP CTN",
    itemIds: ["last_updated_mkkcvcay", "text_mkn48ej3"],
    subIds: ["text_mkkpqxne", "date_mkkpwrzr", "date_mkkcjb0d", "status", "dup__of_carrier_mkkhe4nm",
      "dup__of_shipping_status_mkkh19tb", "dup__of_cariier_mkkhr1sk", "dup__of_hbl_mkkhja5z",
      "link_mkkcecb2", "date_mkkcwyj1", "text_mkkdp9nz", "date_2_mkkcs1my", "date_3_mkkcj9kf",
      "date_1_mkkca3z2", "date_mkkhsy66", "text_mkkhyvt5", "dup__of_carrier_mkkp3wj",
      "dup__of_warehouse_mkkha3b1", "dup__of_ctn_size_mkkh99h0", "numbers_mkkhw6rr",
      "date_mkkhdcdc", "text_mkkspr6v"],
  },
  NAVIP: {
    id: 8503068145, name: "NORTH AMERICAN VIP-CTN",
    itemIds: ["last_updated_mkkcvcay", "text_mkky48c3"],
    subIds: ["text_mkkjgx0x", "dup__of_deliver_date_mkkjy7fe", "date_mkkcjb0d", "date_mkkhsy66",
      "date_3_mkkcj9kf", "date_mkvw98fd", "status", "dup__of_carrier_mkkhe4nm", "dup__of_cariier_mkkhr1sk",
      "link_mkkcecb2", "numbers_mkkhw6rr", "dup__of_shipping_status_mkkh19tb", "color_mkrrrm29",
      "label_mkkc10ya", "date_1_mkkca3z2", "date_mkkcwyj1", "date_2_mkkcs1my", "text_mkkdp9nz",
      "text_mknry791", "dup__of_hbl_mkkhja5z", "dup__of_warehouse_mkkha3b1", "dup__of_ctn_size_mkkh99h0",
      "date_mkkhdcdc", "date_mm358tbf"],
  },
  FL: {
    id: 8089648863, name: "Florida Customer -CTN Tracking",
    itemIds: ["status_mkkcv6d3", "last_updated_mkkcvcay", "text_mkn5g4vc"],
    subIds: ["text_mm09bwma", "status", "color_mm47d3fk", "date_mkkcjb0d", "date_3_mkkcj9kf",
      "date_mkwfh8vy", "date_mkvwmgmk", "date_mkkcwyj1", "dup__of_bkg_date_mkn5w1m7", "date_2_mkkcs1my",
      "link_mkkcecb2", "text_mkkdp9nz", "text_mkmcd152", "text_mkvwqwmh", "dup__of_bkg__mknc81dm",
      "date_mks9edqg", "label_mkkc10ya", "color_mkrkgkjg", "date_mm354094"],
  },
  NACTN: {
    id: 8111460049, name: "NORTH AMERICAN-CTN",
    itemIds: ["last_updated_mkkcvcay"],
    subIds: ["text_mkkjgx0x", "dup__of_deliver_date_mkkjy7fe", "date_mkkcjb0d", "date_mkkhsy66",
      "date_3_mkkcj9kf", "date_mkkhdcdc", "status", "date_mks2s8v6", "dup__of_cariier_mkkhr1sk",
      "dup__of_carrier_mkkhe4nm", "link_mkkcecb2", "dup__of_shipping_status_mkkh19tb", "label_mkkc10ya",
      "numbers_mkkhw6rr", "date_mkkcwyj1", "date_1_mkkca3z2", "text_mkkdp9nz", "date_2_mkkcs1my",
      "text_mkkhyvt5", "dup__of_hbl_mkkhja5z", "dup__of_warehouse_mkkha3b1", "dup__of_shipping_status_mkkhnxp3",
      "dup__of_ctn_size_mkkh99h0", "date_mm346bcf"],
  },
};

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

/* ColumnValue has no direct "title" field — title lives on the nested Column
   object it belongs to. items_page itself accepts an optional cursor, so one
   query template covers every page. column_values(ids:) filters server-side
   to only the columns this board actually needs. */
const ITEMS_PAGE_QUERY = `
  query($boardId: [ID!], $limit: Int!, $cursor: String, $itemIds: [String!], $subIds: [String!]) {
    boards(ids: $boardId) {
      items_page(limit: $limit, cursor: $cursor) {
        cursor
        items {
          name
          group { title }
          column_values(ids: $itemIds) { column { title } text }
          subitems { name column_values(ids: $subIds) { column { title } text } }
        }
      }
    }
  }
`;

function colValuesToObject(item) {
  const obj = { Name: item.name };
  for (const cv of item.column_values || []) {
    const title = cv.column && cv.column.title;
    if (title && !(title in obj)) obj[title] = cv.text;
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

async function fetchBoard(token, board) {
  let records = [];
  let cursor = null;
  do {
    const data = await mondayFetch(token, ITEMS_PAGE_QUERY, {
      boardId: [String(board.id)], limit: PAGE_SIZE, cursor,
      itemIds: board.itemIds, subIds: board.subIds,
    });
    const b = data.boards && data.boards[0];
    if (!b) break;
    records = records.concat(itemsToRecords(b.items_page.items));
    cursor = b.items_page.cursor;
  } while (cursor);
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
    boardKeys.map(key => fetchBoard(token, BOARDS[key]))
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
