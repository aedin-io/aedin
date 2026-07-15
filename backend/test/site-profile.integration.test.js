// Run via: npm run test:integration (the script sets --test-force-exit, which
// is required because server.js keeps the event loop alive via app.listen()).
// Do not run `npm start` in another terminal while this runs — the require
// below will throw EADDRINUSE on port 3001.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

let baseUrl;

function waitForServer(url, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http
        .get(url, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => {
          if (Date.now() - start >= timeoutMs) {
            reject(new Error(`server not ready at ${url} after ${timeoutMs}ms`));
          } else {
            setTimeout(attempt, intervalMs);
          }
        });
    };
    attempt();
  });
}

before(async () => {
  // server.js calls app.listen(process.env.PORT) at module load; we require it
  // for that side effect and talk to the listener over HTTP.
  process.env.PORT = '3001'; // server.js reads this; must match baseUrl below.
  require('../server.js');
  baseUrl = 'http://127.0.0.1:3001';
  await waitForServer(`${baseUrl}/api/status`);
});

after(async () => {
  // No explicit shutdown: server.js does not export a server handle, and
  // --test-force-exit (in the npm script) tears the listener down.
});

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${path}`, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          reject(new Error(`bad JSON at ${path}: ${body.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

test('GET /api/site/profile without lat → 400', async () => {
  const r = await getJson('/api/site/profile?lon=0');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /lat/);
});

test('GET /api/site/profile without lon → 400', async () => {
  const r = await getJson('/api/site/profile?lat=0');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /lon/);
});

test('GET /api/site/profile with non-numeric lat → 400', async () => {
  const r = await getJson('/api/site/profile?lat=abc&lon=0');
  assert.equal(r.status, 400);
});

test('GET /api/site/profile with lat=95 → 400', async () => {
  const r = await getJson('/api/site/profile?lat=95&lon=0');
  assert.equal(r.status, 400);
});

test('GET /api/site/profile with lon=-200 → 400', async () => {
  const r = await getJson('/api/site/profile?lat=0&lon=-200');
  assert.equal(r.status, 400);
});

test('GET /api/site/profile inland farm (Salinas) → exact, all groups populated', async () => {
  const r = await getJson('/api/site/profile?lat=36.65&lon=-121.80');
  assert.equal(r.status, 200);
  assert.deepEqual(
    Object.keys(r.body).sort(),
    ['bioclim', 'climate', 'coverage', 'matched_cell', 'phenology', 'query', 'soil', 'zones']
  );
  assert.equal(r.body.matched_cell.coverage_confidence, 'exact');
  assert.equal(r.body.coverage.climate, true);
  assert.equal(r.body.coverage.bioclim, true);
  assert.equal(r.body.coverage.phenology, true);
  assert.equal(r.body.coverage.soil, true);
  assert.equal(r.body.coverage.soil_depth_bedrock, false);
  assert.ok(r.body.matched_cell.distance_km <= 14);
  assert.ok(typeof r.body.climate.annual_mean_temp_c === 'number');
  assert.equal(r.body.climate.monthly_temp_high_c.length, 12);
});

test('GET /api/site/profile coastal/island (Guam) → exact or nearby', async () => {
  const r = await getJson('/api/site/profile?lat=13.50&lon=144.80');
  assert.equal(r.status, 200);
  assert.ok(['exact', 'nearby'].includes(r.body.matched_cell.coverage_confidence),
    `got ${r.body.matched_cell.coverage_confidence}`);
  assert.ok(r.body.matched_cell.distance_km <= 50);
  // Soil may or may not be present for a small island cell — both are valid;
  // just assert the flag and the soil block agree.
  if (r.body.coverage.soil) {
    assert.ok(typeof r.body.soil.ph_surface === 'number');
  } else {
    assert.equal(r.body.soil.ph_surface, null);
  }
});

test('GET /api/site/profile mid-ocean (0, -150) → distant', async () => {
  const r = await getJson('/api/site/profile?lat=0&lon=-150');
  assert.equal(r.status, 200);
  assert.equal(r.body.matched_cell.coverage_confidence, 'distant');
  assert.ok(r.body.matched_cell.distance_km > 50,
    `expected > 50 km, got ${r.body.matched_cell.distance_km}`);
});

test('GET /api/site/profile response shape is stable (no extra top-level keys)', async () => {
  const r = await getJson('/api/site/profile?lat=36.65&lon=-121.80');
  const expected = ['bioclim', 'climate', 'coverage', 'matched_cell', 'phenology', 'query', 'soil', 'zones'];
  assert.deepEqual(Object.keys(r.body).sort(), expected);
  assert.deepEqual(
    Object.keys(r.body.coverage).sort(),
    ['bioclim', 'climate', 'phenology', 'soil', 'soil_depth_bedrock']
  );
});

test('GET /api/site/profile old /api/climate/profile path is gone → 404', async () => {
  // Express returns its default 404 HTML when no route matches. We just
  // check the status code; the body may not be JSON.
  const opts = { hostname: '127.0.0.1', port: 3001, path: '/api/climate/profile?lat=0&lon=0' };
  const status = await new Promise((resolve, reject) => {
    http.get(opts, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 404);
});
