#!/usr/bin/env python3
"""Add a record-confidence block to every company in data/companies.json.

Two independent kinds of evidence:

  1. External  — does OpenStreetMap know a business by this name at this point?
                 (matched offline against an Overpass extract of the region)
  2. Internal  — deterministic consistency checks on the spreadsheet itself:
                 geocode quality, shared phone numbers, shared addresses,
                 out-of-region area codes, missing or mismatched websites,
                 addresses with no street number.

A missing OSM record is NOT evidence a company is fake — OpenStreetMap's
coverage of ordinary offices is thin. It is treated as "unconfirmed", and only
the internal checks ever raise a warning.
"""
import json, re, collections, sys, os

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, '..', 'data', 'companies.json')

d = json.load(open(DATA))
C = d['companies']

# ---------------------------------------------------------------- OSM matches
osm = {}
for part in open(os.path.join(ROOT, 'osm-places.txt')).read().strip().split('|'):
    f = part.split('~')
    i = int(f[0])
    if f[1] == 'n':
        osm[i] = None
    else:
        osm[i] = {'kind': 'name' if f[1] == 'm' else 'addr',
                  'sim': float(f[2]), 'dist': int(f[3]), 'name': f[4]}

# ----------------------------------------------------------- shared resources
def digits(s):
    return re.sub(r'\D', '', s or '')


def norm_addr(c):
    """Street address with any suite / unit / floor suffix removed, plus ZIP5."""
    a = c['address'].lower()
    a = re.split(r'\s+(?:ste|suite|unit|apt|bldg|building|fl|floor|rm|room|#)\b', a)[0]
    a = re.sub(r'[^a-z0-9 ]', ' ', a)
    a = re.sub(r'\s+', ' ', a).strip()
    return (a, c['zip'][:5])

phone_map = collections.defaultdict(list)
addr_map = collections.defaultdict(list)
name_map = collections.defaultdict(list)
for c in C:
    p = digits(c['phone'])
    if len(p) >= 10:
        phone_map[p[-10:]].append(c['id'])
    addr_map[norm_addr(c)].append(c['id'])
    name_map[re.sub(r'[^a-z0-9]', '', c['company'].lower())].append(c['id'])

LOCAL_AREA = {'719', '720', '303', '970', '983'}
STOP = {'the', 'inc', 'llc', 'ltd', 'corp', 'co', 'company', 'of', 'and', 'group',
        'services', 'service', 'incorporated', 'corporation', 'international',
        'associates', 'holdings', 'usa', 'us', 'llp', 'lp', 'pc'}

def name_tokens(s):
    return {t for t in re.split(r'[^a-z0-9]+', s.lower()) if len(t) > 2 and t not in STOP}

# ------------------------------------------------------------------ per record
FLAG_TEXT = {
    'osm-name':      ('good', 'Confirmed on OpenStreetMap'),
    'osm-address':   ('info', 'Address exists on OpenStreetMap under a different business name'),
    'osm-none':      ('info', 'No OpenStreetMap record — common for ordinary offices, not a red flag on its own'),
    'geo-approx':    ('warn', 'Location is approximate — the pin may be off by a block or more'),
    'geo-range':     ('info', 'Located by address range rather than an exact rooftop'),
    'no-street-num': ('warn', 'Address has no street number'),
    'shared-phone':  ('warn', 'Phone number is shared with another company in the list'),
    'shared-addr':   ('info', 'Other listed companies share this exact address'),
    'repeat-name':   ('info', 'This company appears more than once in the list'),
    'far-area-code': ('warn', 'Phone area code is outside Colorado'),
    'no-website':    ('info', 'No website in the source data'),
    'domain-mismatch': ('info', 'Website domain does not resemble the company name'),
}

summary = collections.Counter()

for c in C:
    flags = []
    m = osm[c['id']]

    if m and m['kind'] == 'name':
        flags.append(('osm-name', f"{m['name']} · {m['dist']} m away"))
    elif m and m['kind'] == 'addr':
        flags.append(('osm-address', f"{m['name']}"))
    else:
        flags.append(('osm-none', ''))

    q = c['geoQuality']
    if q in ('ZIP-approx', 'OSM-approx'):
        flags.append(('geo-approx', q))
    elif q == 'Non_Exact':
        flags.append(('geo-range', ''))

    if not re.match(r'^\d', c['address'].strip()):
        flags.append(('no-street-num', c['address']))

    p = digits(c['phone'])
    if len(p) >= 10:
        p10 = p[-10:]
        others = [i for i in phone_map[p10] if i != c['id']]
        if others:
            names = {C[i]['company'] for i in others}
            flags.append(('shared-phone', f"{len(others)} other record(s): " + '; '.join(sorted(names)[:2])))
        if p10[:3] not in LOCAL_AREA:
            flags.append(('far-area-code', 'area code ' + p10[:3]))

    sharers = [i for i in addr_map[norm_addr(c)] if i != c['id']]
    if sharers:
        flags.append(('shared-addr', f"{len(sharers)} other listed compan{'y' if len(sharers)==1 else 'ies'}"))

    nk = re.sub(r'[^a-z0-9]', '', c['company'].lower())
    if len(name_map[nk]) > 1:
        flags.append(('repeat-name', f"{len(name_map[nk])} locations in this list"))

    web = (c['website'] or '').strip()
    if not web:
        flags.append(('no-website', ''))
    else:
        dom = re.sub(r'^https?://(www\.)?', '', web).split('/')[0].lower()
        stem = re.sub(r'\.(com|org|net|edu|gov|us|co|io|biz)$', '', dom).replace('-', '')
        compact = re.sub(r'[^a-z0-9]', '', c['company'].lower())
        toks = name_tokens(c['company'])
        hit = (stem and (stem in compact or compact in stem)) or \
              any(len(t) > 3 and (t in stem or stem in t) for t in toks)
        if not hit:
            flags.append(('domain-mismatch', dom))

    kinds = {f[0] for f in flags}
    warn = sum(1 for k in kinds if FLAG_TEXT[k][0] == 'warn')

    if 'osm-name' in kinds and warn == 0:
        tier, label = 'verified', 'Verified'
    elif warn >= 2:
        tier, label = 'check', 'Needs a check'
    elif warn == 1:
        tier, label = 'caution', 'One thing to check'
    else:
        tier, label = 'consistent', 'Consistent'

    c['verify'] = {
        'tier': tier, 'label': label, 'warnings': warn,
        'flags': [{'k': k, 'sev': FLAG_TEXT[k][0], 'text': FLAG_TEXT[k][1], 'detail': det}
                  for k, det in flags],
    }
    summary[tier] += 1
    for k in kinds:
        summary['flag:' + k] += 1

d['meta']['verified'] = '2026-09-09'
d['meta']['verifySource'] = 'OpenStreetMap (Overpass extract, El Paso & Teller counties) + internal consistency checks'
d['verifyTiers'] = {
    'verified':   {'label': 'Verified',           'color': '#127a4d', 'icon': '✓', 'note': 'A business of this name is on the map at this location, and nothing else looks off.'},
    'consistent': {'label': 'Consistent',         'color': '#5c6bc0', 'icon': '•', 'note': 'Nothing contradicts the record. Not independently confirmed.'},
    'caution':    {'label': 'One thing to check', 'color': '#d9a800', 'icon': '!', 'note': 'One check failed. Read the flags before you call.'},
    'check':      {'label': 'Needs a check',      'color': '#e05a00', 'icon': '!!', 'note': 'Two or more checks failed. Confirm this one before spending a trip on it.'},
}
d['verifyFlagText'] = {k: {'sev': v[0], 'text': v[1]} for k, v in FLAG_TEXT.items()}

json.dump(d, open(DATA, 'w'), separators=(',', ':'))

print('tiers:')
for t in ('verified', 'consistent', 'caution', 'check'):
    print(f'  {summary[t]:4d}  {t}')
print('\nflags:')
for k in FLAG_TEXT:
    if summary['flag:' + k]:
        print(f"  {summary['flag:'+k]:4d}  [{FLAG_TEXT[k][0]:4s}] {k}")
