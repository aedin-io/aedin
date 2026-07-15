#!/usr/bin/env python3
"""
extract_epub.py — extract plain text from an EPUB into a single markdown file.

EPUB is a zip of XHTML. The reading order is defined by the OPF spine, NOT by
alphabetical filename order — books with naming like `appendix-A.xhtml` would
otherwise sort before `chapter-01.xhtml` and produce out-of-order text.

Resolution order:
  1. META-INF/container.xml → locates the OPF file
  2. OPF manifest gives id → href mapping
  3. OPF spine gives the ordered list of itemref ids = reading order
If any step fails, fall back to alphabetical sort (with a warning).

Usage: python3 tools/extract_epub.py <input.epub> <output.md>
"""
import sys
import re
import os
import zipfile
import xml.etree.ElementTree as ET
from html import unescape

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"[ \t]+")
NL_RE = re.compile(r"\n{3,}")

# EPUB / OPF namespaces
NS_CONTAINER = "{urn:oasis:names:tc:opendocument:xmlns:container}"
NS_OPF = "{http://www.idpf.org/2007/opf}"


def html_to_text(html: str) -> str:
    html = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    html = re.sub(r"</(p|div|h[1-6]|li|br|tr|td)\s*>", "\n", html, flags=re.I)
    html = re.sub(r"<br\s*/?>", "\n", html, flags=re.I)
    text = TAG_RE.sub("", html)
    text = unescape(text)
    text = WS_RE.sub(" ", text)
    text = NL_RE.sub("\n\n", text)
    return text.strip()


def spine_ordered_files(z: zipfile.ZipFile) -> tuple[list[str], str]:
    """Return (ordered_filenames, source_label)."""
    try:
        container_xml = z.read("META-INF/container.xml")
    except KeyError:
        return _alphabetical_fallback(z, "no META-INF/container.xml")

    try:
        container_root = ET.fromstring(container_xml)
        rootfile = container_root.find(f".//{NS_CONTAINER}rootfile")
        if rootfile is None:
            return _alphabetical_fallback(z, "no rootfile element in container.xml")
        opf_path = rootfile.get("full-path")
        if not opf_path:
            return _alphabetical_fallback(z, "no full-path in container.xml")
    except ET.ParseError as e:
        return _alphabetical_fallback(z, f"container.xml parse error: {e}")

    try:
        opf_xml = z.read(opf_path)
        opf_root = ET.fromstring(opf_xml)
    except (KeyError, ET.ParseError) as e:
        return _alphabetical_fallback(z, f"OPF read/parse error: {e}")

    # Build manifest: id -> href (relative to OPF directory)
    manifest = {}
    for item in opf_root.findall(f".//{NS_OPF}manifest/{NS_OPF}item"):
        item_id = item.get("id")
        href = item.get("href")
        if item_id and href:
            manifest[item_id] = href

    # Read spine (ordered itemref ids)
    spine = opf_root.find(f".//{NS_OPF}spine")
    if spine is None:
        return _alphabetical_fallback(z, "no spine in OPF")

    opf_dir = os.path.dirname(opf_path)
    ordered = []
    for itemref in spine.findall(f"{NS_OPF}itemref"):
        idref = itemref.get("idref")
        if not idref or idref not in manifest:
            continue
        href = manifest[idref]
        full = os.path.normpath(os.path.join(opf_dir, href)) if opf_dir else href
        # Normalize to forward slashes (zip uses forward slashes)
        full = full.replace(os.sep, "/")
        if full in z.namelist():
            ordered.append(full)

    if not ordered:
        return _alphabetical_fallback(z, "spine produced no readable files")

    return ordered, f"OPF spine ({len(ordered)} items from {opf_path})"


def _alphabetical_fallback(z: zipfile.ZipFile, reason: str) -> tuple[list[str], str]:
    print(f"WARN: falling back to alphabetical sort — {reason}", file=sys.stderr)
    names = sorted(
        n for n in z.namelist()
        if n.lower().endswith((".xhtml", ".html", ".htm"))
    )
    return names, f"alphabetical sort ({len(names)} files)"


def main(src: str, dst: str) -> None:
    with zipfile.ZipFile(src) as z:
        names, source_label = spine_ordered_files(z)
        chunks = []
        for name in names:
            try:
                raw = z.read(name).decode("utf-8", errors="replace")
            except Exception as e:
                chunks.append(f"\n\n[extract error in {name}: {e}]\n")
                continue
            chunks.append(html_to_text(raw))
    text = "\n\n".join(c for c in chunks if c)
    with open(dst, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"EXTRACTED {dst} ({len(text):,} chars, ordering: {source_label})")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: extract_epub.py <input.epub> <output.md>", file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
