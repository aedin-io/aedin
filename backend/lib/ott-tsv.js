'use strict';
/**
 * ott-tsv.js — parsers for the Open Tree Taxonomy dump files.
 *
 * FORMAT (verified against OTT 3.7, 2026-08-25): fields are separated by the
 * three-character sequence TAB PIPE TAB, and every line ends with a trailing
 * separator. A naive split('\t') yields the wrong column count.
 *
 *   taxonomy.tsv  uid | parent_uid | name | rank | sourceinfo | uniqname | flags |
 *   synonyms.tsv  name | uid | type | uniqname | sourceinfo |
 *
 * The root row ('life') has an EMPTY parent_uid, which becomes null, not 0.
 */
const SEP = '\t|\t';

function fields(line) {
  if (!line) return null;
  const trimmed = line.endsWith(SEP) ? line.slice(0, -SEP.length) : line;
  return trimmed.split(SEP);
}

function parseTaxonomyLine(line) {
  const f = fields(line);
  if (!f || f.length < 7 || f[0] === 'uid') return null;
  return {
    ott_id: Number(f[0]),
    parent_ott_id: f[1] === '' ? null : Number(f[1]),
    name: f[2],
    rank: f[3],
    source_info: f[4],
    uniqname: f[5],
    flags: f[6],
  };
}

function parseSynonymLine(line) {
  const f = fields(line);
  if (!f || f.length < 3 || f[0] === 'name') return null;
  return { name: f[0], ott_id: Number(f[1]), type: f[2] };
}

module.exports = { parseTaxonomyLine, parseSynonymLine, SEP };
