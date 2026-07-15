# Vendored: okf_validate.py

`okf_validate.py` is a **verbatim vendored copy** (not authored here) of the
deterministic OKF v0.1 conformance checker from the `okf` Claude Code plugin.

- **Source:** `scaccogatto/okf-skills` → `skills/validate/scripts/okf_validate.py`
- **Vendored from version:** `0.2.1`
- **License:** MIT — Copyright (c) 2026 Marco Boffo
- **Why vendored:** CI must run the checker without the plugin cache present and
  without a network fetch at run time (deterministic, self-contained). The
  canonical local check remains the `okf:validate` skill; this copy is the CI gate.

## Re-vendoring on upgrade

When the `okf` plugin updates, refresh this copy so CI matches the local skill:

```bash
cp ~/.claude/plugins/cache/scaccogatto/okf/<NEW_VERSION>/skills/validate/scripts/okf_validate.py \
   .github/scripts/okf_validate.py
# update the "Vendored from version" line above
```

Keep the file otherwise unmodified so re-vendoring stays a clean copy.
