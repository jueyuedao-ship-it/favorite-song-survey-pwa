"""Render the approved Markdown as an offline, printable plan (stdlib only)."""
from pathlib import Path
import html
import re

ROOT = Path(__file__).resolve().parent.parent
source = ROOT / "docs/superpowers/specs/2026-09-30-favorite-song-survey-design.md"
target = ROOT / "docs/好きな曲アンケートPWA_計画書.html"


def inline(value):
    value = html.escape(value)
    value = re.sub(r"`([^`]+)`", r"<code>\1</code>", value)
    value = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", value)
    return re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r'<a href="\2">\1</a>', value)


lines = source.read_text(encoding="utf-8").splitlines()
body, toc = [], []
i = 0
while i < len(lines):
    line = lines[i]
    if not line.strip():
        i += 1
        continue
    if line.startswith("#"):
        level = len(line) - len(line.lstrip("#"))
        label = line[level:].strip()
        ident = f"section-{i}"
        body.append(f'<h{level} id="{ident}">{inline(label)}</h{level}>')
        if level == 2:
            toc.append(f'<li><a href="#{ident}">{inline(label)}</a></li>')
    elif line.startswith("|"):
        table = []
        while i < len(lines) and lines[i].startswith("|"):
            row = [c.strip() for c in lines[i].strip().strip("|").split("|")]
            if not all(re.fullmatch(r":?-+:?", c) for c in row):
                cell = "th" if not table else "td"
                table.append("<tr>" + "".join(f"<{cell}>{inline(c)}</{cell}>" for c in row) + "</tr>")
            i += 1
        body.append('<div class="table-scroll"><table>' + "".join(table) + "</table></div>")
        continue
    elif line.startswith("- "):
        items = []
        while i < len(lines) and lines[i].startswith("- "):
            items.append("<li>" + inline(lines[i][2:]) + "</li>")
            i += 1
        body.append("<ul>" + "".join(items) + "</ul>")
        continue
    else:
        body.append("<p>" + inline(line) + "</p>")
    i += 1

document = '''<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>好きな曲アンケートPWA 計画書</title>
<style>
:root{color-scheme:light;font-family:system-ui,"Yu Gothic",sans-serif;color:#223248;background:#eef4f8}
body{margin:0;line-height:1.9}main{max-width:1000px;margin:32px auto;padding:36px 48px;background:white;border-radius:20px;box-shadow:0 8px 36px #1939580a}
h1{font-size:2rem;line-height:1.5;color:#153d60}h2{margin-top:3rem;border-bottom:2px solid #dfeaf3;padding-bottom:.5rem}h3{margin-top:2rem}a{color:#1b6095}nav{background:#edf5fb;padding:20px;border-radius:12px}nav ul{margin:0}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;margin:20px 0;font-size:.94rem}th,td{padding:12px 16px;text-align:left;border:1px solid #dfe7ed;vertical-align:top}th{background:#edf5fb}code{background:#f0f4f7;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}li{margin:8px 0}footer{margin-top:3rem;color:#627388;font-size:.88rem}
@media(max-width:700px){main{margin:0;padding:24px 18px;border-radius:0}h1{font-size:1.6rem}th,td{padding:8px}nav{padding:12px}}
@media print{body{background:white}main{box-shadow:none;margin:0;max-width:none;padding:0}nav{display:none}h2,h3{break-after:avoid}tr{break-inside:avoid}.table-scroll{overflow:visible}a{color:inherit;text-decoration:none}table{font-size:9pt}body{font-size:10pt}}
</style></head><body><main><nav aria-label="目次"><strong>目次</strong><ul>__TOC__</ul></nav><article>__BODY__</article><footer>承認済み計画／2026年9月30日。単体で閲覧・印刷できます。実装と検証の状況はREADMEと検証記録を参照してください。</footer></main></body></html>'''
target.write_text(document.replace("__TOC__", "".join(toc)).replace("__BODY__", "\n".join(body)), encoding="utf-8")
print(str(target))
