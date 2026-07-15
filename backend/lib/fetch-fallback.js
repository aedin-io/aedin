'use strict';
const { isPdfMagic, meetsSizeFloor } = require('./pdf-verify');

async function acquireOne(entry, { fetchImpl = fetch, floor = 10240 } = {}) {
  let lastStatus = 0;
  for (let i = 0; i < entry.fetch_urls.length; i++) {
    const url = entry.fetch_urls[i];
    try {
      const res = await fetchImpl(url);
      lastStatus = res.status;
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!isPdfMagic(buf) || !meetsSizeFloor(buf, floor)) continue;
      return { status: i === 0 ? 'ok' : 'mirror-used', url_used: url, buf, http_status: res.status };
    } catch {
      continue;
    }
  }
  const canonicalInList = entry.fetch_urls.includes(entry.canonical_url);
  return { status: canonicalInList ? 'gate' : 'fail', url_used: null, buf: null, http_status: lastStatus };
}
module.exports = { acquireOne };
