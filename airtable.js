// airtable.js
const BASE_URL = 'https://api.airtable.com/v0';
const noop = () => {};

// Airtable allows ~5 requests/sec per base. Fetching multiple tables fully
// unbounded-in-parallel (tried once before) burst past that and caused 429
// storms. This caps how many requests can be in flight at once — bounded
// parallelism, not unbounded — so e.g. 3-4 tables can each make progress on
// their own pagination concurrently without ever exceeding the real limit.
const MAX_CONCURRENT_REQUESTS = 3;
let activeRequests = 0;
const waitQueue = [];

function acquireSlot() {
  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    activeRequests++;
    return Promise.resolve();
  }
  return new Promise(resolve => waitQueue.push(resolve));
}

function releaseSlot() {
  activeRequests--;
  const next = waitQueue.shift();
  if (next) { activeRequests++; next(); }
}

async function throttledFetch(url, options) {
  await acquireSlot();
  try {
    return await fetch(url, options);
  } finally {
    releaseSlot();
  }
}

async function get(url, apiKey, logger = noop, attempt = 0) {
  const t0 = Date.now();
  const res = await throttledFetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
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

async function uploadAttachment(apiKey, baseId, recordId, fieldName, filename, contentType, base64Data, logger = noop) {
  const url = `https://content.airtable.com/v0/${baseId}/${recordId}/${encodeURIComponent(fieldName)}/uploadAttachment`;
  const t0 = Date.now();
  const res = await throttledFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType, file: base64Data, filename }),
  });
  logger(`POST ${url} → ${res.status} in ${Date.now() - t0}ms`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Airtable upload error: ${res.status} ${res.statusText}${text ? ' — ' + text : ''}`);
  }
  return res.json();
}

async function updateRecord(apiKey, baseId, tableId, recordId, fields, logger = noop) {
  const url = `${BASE_URL}/${baseId}/${tableId}/${recordId}`;
  const t0 = Date.now();
  const res = await throttledFetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  logger(`PATCH ${url} → ${res.status} in ${Date.now() - t0}ms`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Airtable update error: ${res.status} ${res.statusText}${text ? ' — ' + text : ''}`);
  }
  return res.json();
}

// Airtable's batch PATCH endpoint accepts at most 10 records per call.
async function updateRecords(apiKey, baseId, tableId, records, logger = noop) {
  const results = [];
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    const updated = await patchRecordsChunk(apiKey, baseId, tableId, chunk, logger);
    results.push(...updated);
  }
  return results;
}

async function patchRecordsChunk(apiKey, baseId, tableId, records, logger, attempt = 0) {
  const url = `${BASE_URL}/${baseId}/${tableId}`;
  const t0 = Date.now();
  const res = await throttledFetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  });
  if (res.status === 429 && attempt < 5) {
    const retryAfter = Number(res.headers?.get?.('Retry-After')) || attempt + 1;
    logger(`rate limited (429) on batch PATCH ${url} — retrying in ${retryAfter}s (attempt ${attempt + 1}/5)`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return patchRecordsChunk(apiKey, baseId, tableId, records, logger, attempt + 1);
  }
  logger(`PATCH ${url} (batch of ${records.length}) → ${res.status} in ${Date.now() - t0}ms`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Airtable batch update error: ${res.status} ${res.statusText}${text ? ' — ' + text : ''}`);
  }
  const data = await res.json();
  return data.records;
}

module.exports = { fetchBases, fetchTables, fetchRecords, uploadAttachment, updateRecord, updateRecords };
