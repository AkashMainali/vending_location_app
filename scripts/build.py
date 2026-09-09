#!/usr/bin/env python3
"""Inline src/styles.css, src/app.js and data/companies.json into a single
self-contained index.html that opens straight from the filesystem.

    python3 scripts/build.py
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src')
DATA = os.path.join(ROOT, 'data', 'companies.json')
OUT = os.path.join(ROOT, 'index.html')

# The classification rules the in-browser importer uses. Kept in sync with
# scripts/pipeline.py — edit there, then re-run this build.
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from pipeline import RULES  # noqa: E402


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def main():
    tpl = read(os.path.join(SRC, 'index.template.html'))
    css = read(os.path.join(SRC, 'styles.css'))
    js = read(os.path.join(SRC, 'app.js'))
    data = read(DATA)
    rules = json.dumps([[p, f, c] for p, f, c in RULES], separators=(',', ':'))

    out = tpl
    out = out.replace('/*__LEAFLET_CSS__*/', read(os.path.join(ROOT, 'vendor', 'leaflet.css')))
    out = out.replace('/*__LEAFLET_JS__*/', read(os.path.join(ROOT, 'vendor', 'leaflet.js')))
    out = out.replace('/*__CSS__*/', css)
    out = out.replace('/*__DATA__*/', data)
    out = out.replace('/*__RULES__*/', rules)
    out = out.replace('/*__JS__*/', js)

    for token in ('__CSS__', '__DATA__', '__JS__', '__RULES__', '__LEAFLET_CSS__', '__LEAFLET_JS__'):
        if '/*%s*/' % token in out:
            raise SystemExit('build failed: placeholder %s was not replaced' % token)

    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(out)
    print('built %s  (%.0f KB)' % (OUT, os.path.getsize(OUT) / 1024))


if __name__ == '__main__':
    main()
