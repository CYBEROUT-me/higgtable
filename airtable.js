// airtable.js
const BASE_URL = 'https://api.airtable.com/v0';
const noop = () => {};

async function get(url, apiKey, logger = noop, attempt = 0) {
  const t0 = Date.now();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (res.status === 429 && attempt < 5) {
    const retryAfter = Number(res.headers?.get?.('Retry-After')) || attempt + 1;
    logger(`rate limited (429) on ${url} — retrying in ${retryAfter}s (attempt ${attempt + 1}/5)`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return get(url, apiKey, logger, attempt + 1);
  }
  logger(`GET ${url} → ${res.status} in ${Date.now() - t0}ms`);
  if (!res.ok) throw new Error(`Airtable error: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchBases(apiKey, logger = noop) {
  const data = await get(`${BASE_URL}/meta/bases`, apiKey, logger);
  return data.bases;
}

async function fetchTables(apiKey, baseId, logger = noop) {
  const data = await get(`${BASE_URL}/meta/bases/${baseId}/tables`, apiKey, logger);
  return data.tables;
}

async function fetchRecords(apiKey, baseId, tableId, logger = noop, onPage = noop) {
  const records = [];
  let offset = null;
  let page = 0;
  do {
    page++;
    const url = new URL(`${BASE_URL}/${baseId}/${tableId}`);
    if (offset) url.searchParams.set('offset', offset);
    const data = await get(url.toString(), apiKey, logger);
    records.push(...data.records);
    logger(`table=${tableId} page ${page}: +${data.records.length} records (${records.length} total)`);
    onPage(data.records, records.length, page);
    offset = data.offset || null;
  } while (offset);
  return records;
}

module.exports = { fetchBases, fetchTables, fetchRecords };
