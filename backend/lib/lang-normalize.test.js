'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLang } = require('./lang-normalize');

test('maps GBIF ISO-639-2 3-letter codes to 2-letter', () => {
  assert.equal(normalizeLang('aar'), 'aa');  // Afar
  assert.equal(normalizeLang('abk'), 'ab');  // Abkhazian
  assert.equal(normalizeLang('eng'), 'en');
  assert.equal(normalizeLang('spa'), 'es');
  assert.equal(normalizeLang('fra'), 'fr');
  assert.equal(normalizeLang('deu'), 'de');
});

test('passes through 2-letter codes and strips region/script subtags', () => {
  assert.equal(normalizeLang('en'), 'en');
  assert.equal(normalizeLang('zh-hans'), 'zh');
  assert.equal(normalizeLang('pt-BR'), 'pt');
});

test('returns null for empty/missing', () => {
  assert.equal(normalizeLang(''), null);
  assert.equal(normalizeLang(null), null);
  assert.equal(normalizeLang('   '), null);
});

test('passes through unknown base codes lowercased', () => {
  assert.equal(normalizeLang('SWA'), 'sw');   // known 3-letter
  assert.equal(normalizeLang('xyz'), 'xyz');  // unknown 3-letter → base passthrough
});

// NEW: previously-missing codes that must now map correctly
test('maps 639-2/B and 639-2/T bibliographic variants for same language', () => {
  // Slovak (slk=terminological, slo=bibliographic)
  assert.equal(normalizeLang('slk'), 'sk');
  assert.equal(normalizeLang('slo'), 'sk');
  // Czech
  assert.equal(normalizeLang('ces'), 'cs');
  assert.equal(normalizeLang('cze'), 'cs');
  // Dutch
  assert.equal(normalizeLang('nld'), 'nl');
  assert.equal(normalizeLang('dut'), 'nl');
  // Portuguese
  assert.equal(normalizeLang('por'), 'pt');
  // Norwegian
  assert.equal(normalizeLang('nor'), 'no');
  // Romanian (ron=terminological, rum=bibliographic)
  assert.equal(normalizeLang('ron'), 'ro');
  assert.equal(normalizeLang('rum'), 'ro');
  // Ukrainian
  assert.equal(normalizeLang('ukr'), 'uk');
  // Vietnamese
  assert.equal(normalizeLang('vie'), 'vi');
  // Korean
  assert.equal(normalizeLang('kor'), 'ko');
  // Chinese (zho=terminological, chi=bibliographic)
  assert.equal(normalizeLang('zho'), 'zh');
  assert.equal(normalizeLang('chi'), 'zh');
});

test('maps additional common ISO 639-2 codes', () => {
  // German variants
  assert.equal(normalizeLang('ger'), 'de');
  assert.equal(normalizeLang('deu'), 'de');
  // French variants
  assert.equal(normalizeLang('fre'), 'fr');
  assert.equal(normalizeLang('fra'), 'fr');
  // Greek variants
  assert.equal(normalizeLang('gre'), 'el');
  assert.equal(normalizeLang('ell'), 'el');
  // Other languages from the complete map
  assert.equal(normalizeLang('afr'), 'af');  // Afrikaans
  assert.equal(normalizeLang('cat'), 'ca');  // Catalan
  assert.equal(normalizeLang('hrv'), 'hr');  // Croatian
  assert.equal(normalizeLang('bul'), 'bg');  // Bulgarian
  assert.equal(normalizeLang('lat'), 'la');  // Latin
  assert.equal(normalizeLang('msa'), 'ms');  // Malay (terminological)
  assert.equal(normalizeLang('may'), 'ms');  // Malay (bibliographic)
  assert.equal(normalizeLang('fas'), 'fa');  // Persian (terminological)
  assert.equal(normalizeLang('per'), 'fa');  // Persian (bibliographic)
  assert.equal(normalizeLang('isl'), 'is');  // Icelandic (terminological)
  assert.equal(normalizeLang('ice'), 'is');  // Icelandic (bibliographic)
  assert.equal(normalizeLang('mya'), 'my');  // Burmese (terminological)
  assert.equal(normalizeLang('bur'), 'my');  // Burmese (bibliographic)
  assert.equal(normalizeLang('kat'), 'ka');  // Georgian (terminological)
  assert.equal(normalizeLang('geo'), 'ka');  // Georgian (bibliographic)
  assert.equal(normalizeLang('sqi'), 'sq');  // Albanian (terminological)
  assert.equal(normalizeLang('alb'), 'sq');  // Albanian (bibliographic)
  assert.equal(normalizeLang('hye'), 'hy');  // Armenian (terminological)
  assert.equal(normalizeLang('arm'), 'hy');  // Armenian (bibliographic)
  assert.equal(normalizeLang('eus'), 'eu');  // Basque (terminological)
  assert.equal(normalizeLang('baq'), 'eu');  // Basque (bibliographic)
  assert.equal(normalizeLang('cym'), 'cy');  // Welsh (terminological)
  assert.equal(normalizeLang('wel'), 'cy');  // Welsh (bibliographic)
  assert.equal(normalizeLang('mkd'), 'mk');  // Macedonian (terminological)
  assert.equal(normalizeLang('mac'), 'mk');  // Macedonian (bibliographic)
  assert.equal(normalizeLang('mri'), 'mi');  // Maori (terminological)
  assert.equal(normalizeLang('mao'), 'mi');  // Maori (bibliographic)
  assert.equal(normalizeLang('bod'), 'bo');  // Tibetan (terminological)
  assert.equal(normalizeLang('tib'), 'bo');  // Tibetan (bibliographic)
});
