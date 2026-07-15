'use strict';
/** sim-trait-sources.js — the priority-ordered sim-trait source cascade. Each entry is a source
 *  adapter {name, cacheDir, extract}. Order = priority; the fill-if-NULL runner applies them in
 *  order, so earlier sources win. Add BIEN / monograph adapters here (in priority position) later. */
const usda = require('./usda-normalize').adapter;
const trefle = require('./trefle-normalize').adapter;
module.exports = [usda, trefle];
