'use strict';

/**
 * critic-router-challenger.js — a hand-authored CHALLENGER variant of the
 * incumbent router, built to exercise the Hermes graduation gate end-to-end
 * (docs/hermes-flexibility-map.md §4, criterion 1 "beats incumbent").
 *
 * It is a THIN WRAPPER: every decision delegates to the incumbent
 * `pickDomainCritic`. It intervenes on exactly ONE documented failure class —
 * the "soil-term overreach" (backlog fixture `arthropod-herbivory-soil-overreach`):
 * an arthropod herbivory/predation/parasitism claim whose text merely MENTIONS
 * soil/nitrogen is grabbed by the incumbent's SOIL_TERM_RE fallback (checked
 * before the arthropod-interaction branch) and mis-routed to soil-scientist,
 * when the arthropod actor means it belongs to the entomologist.
 *
 * Guard rails on the override (so we don't over-steal):
 *   - only fires when the incumbent itself said 'soil-scientist'
 *   - only for arthropod interaction categories
 *   - only when an arthropod actor is named AND no vertebrate is named
 *     (a vertebrate herbivore that mentions soil stays out of entomology)
 *
 * This is exactly the shape of correction a future GEPA mutation would propose
 * automatically; here we author it by hand to prove the gate can evaluate it.
 */

const {
  pickDomainCritic,
  ARTHROPOD_INTERACTIONS,
  ARTHROPOD_NAME_RE,
  VERTEBRATE_NAME_RE,
} = require('./critic-router');

function _ic(payload) {
  const raw = (payload && (
    payload.interaction_category || payload.interaction_type ||
    payload.interactionCategory || payload.interactionType
  )) || '';
  return String(raw).toLowerCase().trim();
}

function pickDomainCriticChallenger(payload, targetTable) {
  const incumbent = pickDomainCritic(payload, targetTable);
  if (incumbent !== 'soil-scientist') return incumbent;
  if (!ARTHROPOD_INTERACTIONS.has(_ic(payload))) return incumbent;
  const hay = JSON.stringify(payload || {});
  if (ARTHROPOD_NAME_RE.test(hay) && !VERTEBRATE_NAME_RE.test(hay)) {
    return 'entomologist';
  }
  return incumbent;
}

module.exports = { pickDomainCriticChallenger };
