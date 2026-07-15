#!/usr/bin/env bash
# Phase Grounding end-to-end smoke. Operates on a /tmp copy — never the live DB.
set -euo pipefail
cd "$(dirname "$0")"

SMOKE_DB="${TMPDIR:-/tmp}/grounding-smoke.sqlite"
cp globi.sqlite "$SMOKE_DB"
export GROUNDING_SMOKE_DB="$SMOKE_DB"

run_node() { node -e "$1"; }

echo "== apply migrations 044 + 045 =="
run_node "const s=require('sqlite'),s3=require('sqlite3');(async()=>{const db=await s.open({filename:process.env.GROUNDING_SMOKE_DB,driver:s3.Database});await require('./migrations/044_entity_resolution_columns').runMigration(db);await require('./migrations/045_entity_dedup_candidates').runMigration(db);await db.close();})().catch(e=>{console.error(e);process.exit(1);});"

echo "== dedup sweep (must precede backfill) =="
run_node "const s=require('sqlite'),s3=require('sqlite3'),{sweepDedup}=require('./sweep-entity-dedup');(async()=>{const db=await s.open({filename:process.env.GROUNDING_SMOKE_DB,driver:s3.Database});const n=await sweepDedup(db);console.log('flagged',n,'candidate pairs');await db.close();})().catch(e=>{console.error(e);process.exit(1);});"

echo "== postrag backfill (dry-run) =="
run_node "const s=require('sqlite'),s3=require('sqlite3'),{backfillClaims}=require('./postrag-backfill');(async()=>{const db=await s.open({filename:process.env.GROUNDING_SMOKE_DB,driver:s3.Database});const r=await backfillClaims(db,{dryRun:true});console.log('histogram',JSON.stringify(r.histogram));await db.close();})().catch(e=>{console.error(e);process.exit(1);});"

echo "== forward-path postrag-resolve over any staging rows =="
run_node "const s=require('sqlite'),s3=require('sqlite3'),{resolveStagingRows}=require('./postrag-resolve');(async()=>{const db=await s.open({filename:process.env.GROUNDING_SMOKE_DB,driver:s3.Database});const n=await resolveStagingRows(db);console.log('resolved',n,'staging rows');await db.close();})().catch(e=>{console.error(e);process.exit(1);});"

echo "== PreRAG candidate block renders for a known binomial =="
run_node "const s=require('sqlite'),s3=require('sqlite3'),{renderCandidateBlock}=require('./lib/candidate-entities');(async()=>{const db=await s.open({filename:process.env.GROUNDING_SMOKE_DB,driver:s3.Database,mode:s3.OPEN_READONLY});const ents=await db.all('SELECT id,scientific_name,common_name,synonyms,bio_category,primary_role,genus FROM entities WHERE genus=\"Apis\" LIMIT 50');const md=renderCandidateBlock('Apis mellifera pollinates crops.',ents,15);if(!md.includes('Apis mellifera')){console.error('PreRAG block missing expected candidate');process.exit(1);}console.log('PreRAG block OK');await db.close();})().catch(e=>{console.error(e);process.exit(1);});"

rm -f "$SMOKE_DB"
echo "SMOKE TEST PASSED"
