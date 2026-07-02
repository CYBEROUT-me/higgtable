// airtable.js
const BASE_URL = 'https://api.airtable.com/v0';

async function get(url, apiKey, attempt = 0) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (res.status === 429 && attempt < 5) {
    const retryAfter = Number(res.headers?.get?.('Retry-After')) || attempt + 1;
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return get(url, apiKey, attempt + 1);
  }
  if (!res.ok) throw new Error(`Airtable error: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchBases(apiKey) {
  const data = await get(`${BASE_URL}/meta/bases`, apiKey);
  return data.bases;
}

async function fetchTables(apiKey, baseId) {
  const data = await get(`${BASE_URL}/meta/bases/${baseId}/tables`, apiKey);
  return data.tables;
}

async function fetchRecords(apiKey, baseId, tableId) {
  const records = [];
  let offset = null;
  do {
    const url = new URL(`${BASE_URL}/${baseId}/${tableId}`);
    if (offset) url.searchParams.set('offset', offset);
    const data = await get(url.toString(), apiKey);
    records.push(...data.records);
    offset = data.offset || null;
  } while (offset);
  return records;
}

module.exports = { fetchBases, fetchTables, fetchRecords };
