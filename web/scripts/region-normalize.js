/**
 * region-normalize (web ESM shim) — re-exports the canonical CommonJS normalizer
 * in backend/lib so the atlas build and backend gate/drop scripts share one
 * region vocabulary. Edit the rules in backend/lib/region-normalize.js.
 */
import regionLib from '../../backend/lib/region-normalize.js';

export const normalizeRegion = regionLib.normalizeRegion;
export const getRegionsJson = regionLib.getRegionsJson;
export const hasResolvableLocality = regionLib.hasResolvableLocality;
