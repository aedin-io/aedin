'use strict';

/**
 * Map a taxonomic lineage to a bio_category. Extracted verbatim from sync-gbif.js
 * (was bioCategoryFromTaxonomy) so GloBI-sourced and GBIF-API-sourced lineage
 * classify identically. Accepts { kingdom, phylum, class }.
 */
function bioCategoryFromLineage(match) {
  const kingdom = (match.kingdom || '').toLowerCase();
  const phylum = (match.phylum || '').toLowerCase();
  const cls = (match.class || '').toLowerCase();

  if (kingdom === 'plantae') return 'plantae';
  if (kingdom === 'fungi') return 'fungi';
  if (kingdom === 'bacteria' || kingdom === 'archaea' || kingdom === 'chromista'
      || kingdom === 'protozoa' || kingdom === 'viruses') return 'microbe';

  if (kingdom === 'animalia') {
    if (['mammalia', 'aves', 'reptilia', 'amphibia', 'actinopterygii',
         'chondrichthyes', 'cephalaspidomorphi', 'myxini', 'sarcopterygii'].includes(cls)) {
      return 'vertebrate';
    }
    if (phylum === 'chordata') return 'vertebrate';
    return 'invertebrate';
  }

  return 'other';
}

module.exports = { bioCategoryFromLineage };
