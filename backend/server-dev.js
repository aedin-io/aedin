/**
 * Development server - SQLite only, no Neo4j
 * Source: server.js with Neo4j connection disabled
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB, ATTACH_RAW_SQL } = require('./lib/db-paths.cjs');

const app = express();
const port = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

// SQLite only for development
let sqliteDb = null;
async function getSqliteDb() {
  if (!sqliteDb) {
    sqliteDb = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    await sqliteDb.exec(ATTACH_RAW_SQL);
  }
  return sqliteDb;
}

// Health check
app.get('/api/status', (req, res) => {
  res.json({ backend: 'sqlite', mode: 'development' });
});

// GET /api/crops/:cropId/pests
app.get('/api/crops/:cropId/pests', async (req, res) => {
  try {
    const { cropId } = req.params;
    const db = await getSqliteDb();

    const pests = await db.all(
      `SELECT DISTINCT target_name, interaction_type, COUNT(*) as count
       FROM raw.interactions
       WHERE source_name = ?
         AND (interaction_type LIKE '%eats%'
           OR interaction_type LIKE '%pest%'
           OR interaction_type LIKE '%parasit%'
           OR interaction_type LIKE '%pathog%'
           OR interaction_type LIKE '%infect%')
       GROUP BY target_name
       ORDER BY count DESC
       LIMIT 50`,
      [cropId]
    );

    res.json({ crop: cropId, pests, count: pests.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/species/:speciesId/controls
app.get('/api/species/:speciesId/controls', async (req, res) => {
  try {
    const { speciesId } = req.params;

    const controls = [
      {
        name: 'Neem Oil',
        type: 'botanical',
        effectiveness: 'high',
        cost: 'low',
        notes: 'Organic option, multiple applications needed'
      },
      {
        name: 'Insecticidal Soap',
        type: 'organic',
        effectiveness: 'medium',
        cost: 'low',
        notes: 'Safe for beneficial insects'
      }
    ];

    res.json({ species: speciesId, controls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/species/:speciesId/beneficials
app.get('/api/species/:speciesId/beneficials', async (req, res) => {
  try {
    const { speciesId } = req.params;
    const db = await getSqliteDb();

    const beneficials = await db.all(
      `SELECT DISTINCT target_name, interaction_type
       FROM raw.interactions
       WHERE source_name = ?
       LIMIT 30`,
      [speciesId]
    );

    res.json({ species: speciesId, beneficials });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/species/:taxName/common-name
app.get('/api/species/:taxName/common-name', async (req, res) => {
  try {
    const { taxName } = req.params;
    res.json({
      taxonomicName: taxName,
      commonName: taxName
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`✓ AgroEco backend running on http://localhost:${port} [SQLite/Dev]`);
});
