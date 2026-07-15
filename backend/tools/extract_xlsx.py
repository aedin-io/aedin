#!/usr/bin/env python3
"""
extract_xlsx.py — convert an XLSX workbook to a multi-sheet TSV file.

Stdlib only. Reads the shared-strings table and each sheet, emits one TSV section
per sheet prefixed with `# Sheet: <name>`. Cell-by-cell — no formula resolution.

Usage: python3 tools/extract_xlsx.py <input.xlsx> <output.tsv>
"""
import sys
import zipfile
import xml.etree.ElementTree as ET
import re

NS = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}


def col_to_idx(col: str) -> int:
    n = 0
    for c in col:
        n = n * 26 + (ord(c.upper()) - ord("A") + 1)
    return n - 1


def cell_to_idx(ref: str) -> int:
    m = re.match(r"([A-Z]+)\d+", ref)
    return col_to_idx(m.group(1)) if m else 0


def load_strings(z: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in z.namelist():
        return []
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    out = []
    for si in root.findall("x:si", NS):
        # text may be <t> or split across multiple <r><t>
        parts = [t.text or "" for t in si.iter("{%s}t" % NS["x"])]
        out.append("".join(parts))
    return out


def list_sheets(z: zipfile.ZipFile) -> list[tuple[str, str]]:
    """Returns [(sheet_name, internal_path), ...] in workbook order."""
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    rid_to_target = {r.get("Id"): r.get("Target") for r in rels}
    out = []
    for s in wb.findall("x:sheets/x:sheet", NS):
        name = s.get("name")
        rid = s.get("{%s}id" % NS["r"])
        target = rid_to_target.get(rid, "")
        if target.startswith("/"):
            path = target.lstrip("/")
        else:
            path = "xl/" + target
        out.append((name, path))
    return out


def sheet_rows(z: zipfile.ZipFile, path: str, strings: list[str]):
    root = ET.fromstring(z.read(path))
    for row in root.findall("x:sheetData/x:row", NS):
        cells = []
        max_idx = -1
        for c in row.findall("x:c", NS):
            ref = c.get("r", "")
            idx = cell_to_idx(ref)
            t = c.get("t")  # type: 's' = shared string, 'inlineStr' = inline, others = number/bool
            v = c.find("x:v", NS)
            inline = c.find("x:is", NS)
            if t == "s" and v is not None:
                try:
                    val = strings[int(v.text)]
                except Exception:
                    val = v.text or ""
            elif t == "inlineStr" and inline is not None:
                val = "".join((t.text or "") for t in inline.iter("{%s}t" % NS["x"]))
            elif v is not None:
                val = v.text or ""
            else:
                val = ""
            while len(cells) <= idx:
                cells.append("")
            cells[idx] = val.replace("\t", " ").replace("\n", " ")
            max_idx = max(max_idx, idx)
        yield cells[: max_idx + 1] if max_idx >= 0 else []


def main(src: str, dst: str) -> None:
    with zipfile.ZipFile(src) as z:
        strings = load_strings(z)
        sheets = list_sheets(z)
        out_lines = []
        for name, path in sheets:
            out_lines.append(f"# Sheet: {name}")
            row_count = 0
            for cells in sheet_rows(z, path, strings):
                out_lines.append("\t".join(cells))
                row_count += 1
            out_lines.append(f"# (rows: {row_count})")
            out_lines.append("")
    with open(dst, "w", encoding="utf-8") as f:
        f.write("\n".join(out_lines))
    print(f"EXTRACTED {dst} ({len(out_lines):,} lines, {len(sheets)} sheets)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: extract_xlsx.py <input.xlsx> <output.tsv>", file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
