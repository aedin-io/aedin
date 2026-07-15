#!/usr/bin/env node
/**
 * extract_corpus.js
 * Extracts text from all PDFs in literature/ into reference markdown files
 * under .claude/agents/agroecologist/reference/ (shared corpus pool for all
 * specialty agents). Skips files that already have a non-empty *_full_text.md.
 *
 * Usage: node tools/extract_corpus.js
 */
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const BOOKS_ROOT = path.resolve(__dirname, '../../literature');
const OUT_DIR = path.resolve(__dirname, '../../.claude/agents/agroecologist/reference');

// Map of source PDF (basename) → output basename (without extension)
// Files already extracted are listed but will be skipped if output exists.
const TARGETS = [
  { src: 'books/agroecology_general/gliessman_agroecology_3rd_2015.pdf', out: 'gliessman' },
  { src: 'books/agroecology_general/gliessman_agroecology_4th_2022.pdf', out: 'gliessman_4th_2022' },
  { src: 'books/agroecology_general/altieri_agroecology_2nd.pdf', out: 'altieri_agroecology' },
  { src: 'books/agroecology_general/rickerl_francis_agroecosystems_analysis_2004.pdf', out: 'ricker_francis' },
  { src: 'books/agroecology_general/medicinal_agroecology.pdf', out: 'medicinal_agroecology' },
  { src: 'books/agroecology_general/giampietro_multi_scale_agroecosystems.pdf', out: 'giampietro_multi_scale' },
  { src: 'books/agroecology_general/chalker_scott_companion_planting_myth.pdf', out: 'chalker_scott_companion_myth' },
  { src: 'books/agroecology_general/vandermeer_ecology_of_agroecosystems_2009.pdf', out: 'vandermeer_ecology_of_agroecosystems' },
  { src: 'books/agroecology_general/toledo_memoria_biocultural_2011.pdf', out: 'toledo_memoria_biocultural' },
  { src: 'books/agroecology_general/nelson_shilling_traditional_ecological_knowledge_2018.pdf', out: 'nelson_shilling_tek' },

  { src: 'books/entomology_ipm/andow_biocontrol_1997.pdf', out: 'andow_biocontrol' },
  { src: 'books/entomology_ipm/pedigo_entomology_pest_management_4th.pdf', out: 'pedigo_entomology_ipm' },
  { src: 'books/entomology_ipm/dent_insect_pest_management_2nd.pdf', out: 'dent_insect_pest_mgmt' },
  { src: 'books/entomology_ipm/omkar_insect_predators_2023.pdf', out: 'omkar_insect_predators' },
  { src: 'books/entomology_ipm/omkar_parasitoids_2023.pdf', out: 'omkar_parasitoids' },
  { src: 'books/entomology_ipm/gurr_wratten_altieri_ecological_engineering_2004.pdf', out: 'gurr_ecological_engineering' },
  { src: 'books/entomology_ipm/michener_bees_of_the_world_2007.pdf', out: 'michener_bees_of_the_world' },
  { src: 'books/entomology_ipm/goulson_bumblebees_2nd_2010.pdf', out: 'goulson_bumblebees' },

  { src: 'books/plant_pathology/agrios_plant_pathology_5th.pdf', out: 'agrios_plant_pathology' },
  { src: 'books/plant_pathology/perry_moens_plant_nematology_3rd_2024.pdf', out: 'perry_moens_plant_nematology' },

  { src: 'books/soil_science/brady_weil_nature_properties_soils_15th.pdf', out: 'brady_weil_soils' },
  { src: 'books/soil_science/magdoff_van_es_building_soils_4th.pdf', out: 'magdoff_van_es_building_soils' },
  { src: 'books/soil_science/smith_read_mycorrhizal_symbiosis_3rd_2008.pdf', out: 'smith_read_mycorrhizal_symbiosis' },
  { src: 'books/soil_science/paul_soil_microbiology_4th_2015.pdf', out: 'paul_soil_microbiology' },

  { src: 'books/crop_ecology_horticulture/loomis_connor_crop_ecology_2nd.pdf', out: 'loomis_connor_crop_ecology' },
  { src: 'books/crop_ecology_horticulture/agroforestry_sustainable_systems.pdf', out: 'agroforestry_sustainable_systems' },
  { src: 'books/crop_ecology_horticulture/rubatzky_yamaguchi_world_vegetables_2nd_1995.pdf', out: 'rubatzky_yamaguchi_world_vegetables' },

  { src: 'books/spatial_ecology/dieckmann_geometry_ecological_2000.pdf', out: 'dieckmann_geometry' },

  { src: 'papers/tamburini_intercropping_biocontrol_2024.pdf', out: 'tamburini_intercropping_biocontrol' },
  { src: 'papers/martinez_polyculture_systematic_map_2024.pdf', out: 'martinez_polyculture_systematic_map' },
  { src: 'papers/wezel_agroecological_practices_review_2014.pdf', out: 'wezel_agroecological_practices_review' },
];

(async () => {
  const summary = [];
  for (const t of TARGETS) {
    const srcPath = path.join(BOOKS_ROOT, t.src);
    const outPath = path.join(OUT_DIR, `${t.out}_full_text.md`);

    if (!fs.existsSync(srcPath)) {
      summary.push({ out: t.out, status: 'MISSING_SRC' });
      continue;
    }

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
      summary.push({ out: t.out, status: 'SKIPPED_EXISTS', bytes: fs.statSync(outPath).size });
      continue;
    }

    try {
      const t0 = Date.now();
      const buf = fs.readFileSync(srcPath);
      const data = await pdfParse(buf);
      fs.writeFileSync(outPath, data.text);
      summary.push({
        out: t.out,
        status: 'EXTRACTED',
        pages: data.numpages,
        chars: data.text.length,
        kb: Math.round(data.text.length / 1024),
        ms: Date.now() - t0,
      });
    } catch (e) {
      summary.push({ out: t.out, status: 'ERROR', err: String(e).slice(0, 200) });
    }
  }

  const lines = summary.map(s => {
    if (s.status === 'EXTRACTED') return `${s.status} ${s.out} (${s.pages}p, ${s.kb}KB, ${s.ms}ms)`;
    if (s.status === 'SKIPPED_EXISTS') return `${s.status} ${s.out} (${Math.round(s.bytes/1024)}KB)`;
    return `${s.status} ${s.out}${s.err ? ' — ' + s.err : ''}`;
  });
  console.log(lines.join('\n'));
})();
