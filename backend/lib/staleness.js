'use strict';

/**
 * Phase Provenance: classify an extractor_runs row against current SHAs.
 *
 * @param {{extractor_md: string, bundle: string}} current
 * @param {{extractor_md_sha: string, prompt_bundle_sha: string}} run
 * @returns {'up_to_date'|'re_vouch_only'|'re_extract_needed'}
 */
function classifyRun(current, run) {
  const mdMatches = current.extractor_md === run.extractor_md_sha;
  const bundleMatches = current.bundle === run.prompt_bundle_sha;
  if (mdMatches && bundleMatches) return 'up_to_date';
  if (!mdMatches) return 're_extract_needed';
  return 're_vouch_only';
}

module.exports = { classifyRun };
