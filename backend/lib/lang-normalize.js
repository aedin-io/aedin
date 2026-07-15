'use strict';
// GBIF vernacularNames use ISO 639-2 (3-letter: eng, spa). Wikidata uses BCP-47
// (en, es, zh-hans). Normalize to a canonical short code; strip region/script.
//
// ISO3_TO_2: complete ISO 639-2 → ISO 639-1 mapping for all ~184 languages
// that have a 639-1 (2-letter) equivalent. Both bibliographic (639-2/B) and
// terminological (639-2/T) 3-letter variants are included where they differ,
// since GBIF uses both (e.g. ger+deu→de, fre+fra→fr).
// A 639-2 code with NO 639-1 equivalent passes through as-is (see normalizeLang).
const ISO3_TO_2 = {
  // A
  aar: 'aa', // Afar
  abk: 'ab', // Abkhazian
  afr: 'af', // Afrikaans
  aka: 'ak', // Akan
  alb: 'sq', // Albanian (639-2/B)
  amh: 'am', // Amharic
  ara: 'ar', // Arabic
  arg: 'an', // Aragonese
  arm: 'hy', // Armenian (639-2/B)
  asm: 'as', // Assamese
  ava: 'av', // Avaric
  ave: 'ae', // Avestan
  aym: 'ay', // Aymara
  aze: 'az', // Azerbaijani
  // B
  bak: 'ba', // Bashkir
  bam: 'bm', // Bambara
  baq: 'eu', // Basque (639-2/B)
  bel: 'be', // Belarusian
  ben: 'bn', // Bengali
  bih: 'bh', // Bihari languages
  bis: 'bi', // Bislama
  bos: 'bs', // Bosnian
  bre: 'br', // Breton
  bul: 'bg', // Bulgarian
  bur: 'my', // Burmese (639-2/B)
  // C
  cat: 'ca', // Catalan
  cha: 'ch', // Chamorro
  che: 'ce', // Chechen
  chi: 'zh', // Chinese (639-2/B)
  chu: 'cu', // Church Slavic
  chv: 'cv', // Chuvash
  cor: 'kw', // Cornish
  cos: 'co', // Corsican
  cre: 'cr', // Cree
  ces: 'cs', // Czech (639-2/T)
  cze: 'cs', // Czech (639-2/B)
  // D
  dan: 'da', // Danish
  div: 'dv', // Divehi
  dut: 'nl', // Dutch (639-2/B)
  dzo: 'dz', // Dzongkha
  // E
  ell: 'el', // Greek, Modern (639-2/T)
  eng: 'en', // English
  epo: 'eo', // Esperanto
  est: 'et', // Estonian
  eus: 'eu', // Basque (639-2/T)
  ewe: 'ee', // Ewe
  // F
  fao: 'fo', // Faroese
  fas: 'fa', // Persian (639-2/T)
  fij: 'fj', // Fijian
  fin: 'fi', // Finnish
  fra: 'fr', // French (639-2/T)
  fre: 'fr', // French (639-2/B)
  fry: 'fy', // Western Frisian
  ful: 'ff', // Fulah
  // G
  geo: 'ka', // Georgian (639-2/B)
  deu: 'de', // German (639-2/T)
  ger: 'de', // German (639-2/B)
  gla: 'gd', // Gaelic, Scottish
  gle: 'ga', // Irish
  glg: 'gl', // Galician
  glv: 'gv', // Manx
  gre: 'el', // Greek, Modern (639-2/B)
  grn: 'gn', // Guarani
  guj: 'gu', // Gujarati
  // H
  hat: 'ht', // Haitian Creole
  hau: 'ha', // Hausa
  heb: 'he', // Hebrew
  her: 'hz', // Herero
  hin: 'hi', // Hindi
  hmo: 'ho', // Hiri Motu
  hrv: 'hr', // Croatian
  hun: 'hu', // Hungarian
  hye: 'hy', // Armenian (639-2/T)
  // I
  ibo: 'ig', // Igbo
  ice: 'is', // Icelandic (639-2/B)
  ido: 'io', // Ido
  iii: 'ii', // Sichuan Yi
  iku: 'iu', // Inuktitut
  ile: 'ie', // Interlingue
  ina: 'ia', // Interlingua
  ind: 'id', // Indonesian
  ipk: 'ik', // Inupiaq
  isl: 'is', // Icelandic (639-2/T)
  ita: 'it', // Italian
  // J
  jav: 'jv', // Javanese
  jpn: 'ja', // Japanese
  // K
  kal: 'kl', // Kalaallisut
  kan: 'kn', // Kannada
  kas: 'ks', // Kashmiri
  kat: 'ka', // Georgian (639-2/T)
  kau: 'kr', // Kanuri
  kaz: 'kk', // Kazakh
  khm: 'km', // Khmer
  kik: 'ki', // Kikuyu
  kin: 'rw', // Kinyarwanda
  kir: 'ky', // Kirghiz
  kom: 'kv', // Komi
  kon: 'kg', // Kongo
  kor: 'ko', // Korean
  kua: 'kj', // Kuanyama
  kur: 'ku', // Kurdish
  // L
  lao: 'lo', // Lao
  lat: 'la', // Latin
  lav: 'lv', // Latvian
  lim: 'li', // Limburgish
  lin: 'ln', // Lingala
  lit: 'lt', // Lithuanian
  lub: 'lu', // Luba-Katanga
  lug: 'lg', // Ganda
  // M
  mac: 'mk', // Macedonian (639-2/B)
  mah: 'mh', // Marshallese
  mal: 'ml', // Malayalam
  mao: 'mi', // Maori (639-2/B)
  mar: 'mr', // Marathi
  may: 'ms', // Malay (639-2/B)
  mkd: 'mk', // Macedonian (639-2/T)
  mlg: 'mg', // Malagasy
  mlt: 'mt', // Maltese
  mon: 'mn', // Mongolian
  mri: 'mi', // Maori (639-2/T)
  msa: 'ms', // Malay (639-2/T)
  mya: 'my', // Burmese (639-2/T)
  // N
  nau: 'na', // Nauru
  nav: 'nv', // Navajo
  nbl: 'nr', // Ndebele, South
  nde: 'nd', // Ndebele, North
  ndo: 'ng', // Ndonga
  nep: 'ne', // Nepali
  nld: 'nl', // Dutch (639-2/T)
  nno: 'nn', // Norwegian Nynorsk
  nob: 'nb', // Norwegian Bokmål
  nor: 'no', // Norwegian
  nya: 'ny', // Chichewa
  // O
  oci: 'oc', // Occitan
  oji: 'oj', // Ojibwa
  ori: 'or', // Oriya
  orm: 'om', // Oromo
  oss: 'os', // Ossetian
  // P
  pan: 'pa', // Punjabi
  per: 'fa', // Persian (639-2/B)
  pli: 'pi', // Pali
  pol: 'pl', // Polish
  por: 'pt', // Portuguese
  pus: 'ps', // Pushto
  // Q
  que: 'qu', // Quechua
  // R
  roh: 'rm', // Romansh
  ron: 'ro', // Romanian (639-2/T)
  rum: 'ro', // Romanian (639-2/B)
  run: 'rn', // Rundi
  rus: 'ru', // Russian
  // S
  sag: 'sg', // Sango
  san: 'sa', // Sanskrit
  sin: 'si', // Sinhala
  slk: 'sk', // Slovak (639-2/T)
  slo: 'sk', // Slovak (639-2/B)
  slv: 'sl', // Slovenian
  sme: 'se', // Northern Sami
  smo: 'sm', // Samoan
  sna: 'sn', // Shona
  snd: 'sd', // Sindhi
  som: 'so', // Somali
  sot: 'st', // Sotho, Southern
  spa: 'es', // Spanish
  sqi: 'sq', // Albanian (639-2/T)
  srd: 'sc', // Sardinian
  srp: 'sr', // Serbian
  ssw: 'ss', // Swati
  sun: 'su', // Sundanese
  swa: 'sw', // Swahili
  swe: 'sv', // Swedish
  // T
  tah: 'ty', // Tahitian
  tam: 'ta', // Tamil
  tat: 'tt', // Tatar
  tel: 'te', // Telugu
  tgk: 'tg', // Tajik
  tgl: 'tl', // Tagalog
  tha: 'th', // Thai
  bod: 'bo', // Tibetan (639-2/T)
  tib: 'bo', // Tibetan (639-2/B)
  tir: 'ti', // Tigrinya
  ton: 'to', // Tonga
  tsn: 'tn', // Tswana
  tso: 'ts', // Tsonga
  tuk: 'tk', // Turkmen
  tur: 'tr', // Turkish
  twi: 'tw', // Twi
  // U
  uig: 'ug', // Uighur
  ukr: 'uk', // Ukrainian
  urd: 'ur', // Urdu
  uzb: 'uz', // Uzbek
  // V
  ven: 've', // Venda
  vie: 'vi', // Vietnamese
  vol: 'vo', // Volapük
  // W
  cym: 'cy', // Welsh (639-2/T)
  wel: 'cy', // Welsh (639-2/B)
  wln: 'wa', // Walloon
  wol: 'wo', // Wolof
  // X
  xho: 'xh', // Xhosa
  // Y
  yid: 'yi', // Yiddish
  yor: 'yo', // Yoruba
  // Z
  zha: 'za', // Zhuang
  zho: 'zh', // Chinese (639-2/T)
  zul: 'zu', // Zulu
};

function normalizeLang(code) {
  if (!code || typeof code !== 'string') return null;
  const c = code.trim().toLowerCase();
  if (!c) return null;
  const base = c.split(/[-_]/)[0];
  if (base.length === 3 && ISO3_TO_2[base]) return ISO3_TO_2[base];
  if (base.length === 2) return base;
  return base; // unknown 3-letter / other → base passthrough
}

module.exports = { normalizeLang };
