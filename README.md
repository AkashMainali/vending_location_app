# Zenith & Sky — Vending Location Intelligence

A location-analysis tool for placing AI smart vending machines around Colorado Springs.
It takes a spreadsheet of companies with addresses, employee counts and HR contacts, and
turns it into a ranked, mapped, filterable view of where a machine is most likely to pay.

Home base: **3544 Cape Romain Dr, Colorado Springs, CO 80920** — editable in the app; each
person who opens the file keeps their own.
Current dataset: **365 companies**, every address geocoded, routed and cross-checked.

---

## Open it

Double-click **`index.html`**. That's the whole thing — no install, no build step, no server.

The file is self-contained: all data, styles, logic **and the map library** are inlined.
The only thing it fetches from the internet is map tiles — everything else (ranking,
filtering, analytics, the detail panel, CSV export) works with no connection at all.

Optionally, `./serve.command` starts a local web server at <http://localhost:8777> if you
prefer a real origin (handy if a browser extension interferes with `file://`).

---

## What's in it

| Tab | What it's for |
|---|---|
| **Map** | Every site plotted, coloured by distance band, with 5 / 10 / 15-mile rings around home. Marker size scales with estimated daily audience. Switch the colouring to industry type, click any pin for the full record. |
| **Ranked list** | Sortable table of every site. Click a column header to sort, click a row for the detail panel, star a row to shortlist it. |
| **Top picks** | The best twelve under the current filters and weights, each with a one-line explanation of *why* it ranks there. |
| **Shortlist** | The sites you starred, as a working call sheet — HR contact and phone in the table, totals for audience, net and round-trip servicing time, and its own CSV export. |
| **Analytics** | Distance and drive-time distribution, industry breakdown with average score, audience-vs-score scatter, and top 15 by projected monthly net. |
| **Method** | Diagrams and plain-English notes on exactly how every number is produced — and what the tool cannot tell you. |

### Sorting

The sidebar has a **multi-level sort builder**. Add up to four levels, choose a field for
each, flip the direction, reorder them. Sorting is applied in the order shown, so
*Industry (A–Z), then Placement score ↓* groups by industry and ranks within each group.

Fields: placement score, drive distance, drive time, straight-line distance, employees,
daily audience, estimated monthly net, estimated monthly revenue, industry fit, captive
audience, route density, industry, company name, city, ZIP.

### Filters

Search box, four distance bands, twenty industry types, employee range, maximum drive
time, minimum score, "staff actually on site" toggle, and a shortlist-only toggle.
Filters and sorts compose — everything on screen respects both.

### Record confidence

Every company was cross-checked against an OpenStreetMap extract of El Paso and Teller
counties (9,486 named places) plus seven consistency checks on the spreadsheet itself.
Each site carries a badge: **59 verified**, **268 consistent**, **38 with one flag**, none
worse. Filter on it in the sidebar; read the specific flags in any site's detail panel.

A missing OpenStreetMap record is *not* evidence a company is fake — most ordinary offices
are unmapped — so it never raises a warning. The flag worth acting on is the out-of-state
phone number: 33 records list a national HR line rather than a local one.

### Changing your home base

Click the ★ chip in the top bar, type an address, press **Set home base**. All 365 sites
re-route on the real road network in about ten seconds and every distance, band, proximity
score and servicing cost updates. Stored per browser, so different people using the same
file each keep their own. **Reset to original** undoes it instantly.

### Score weights

Five sliders control the composite score. Move one and every ranking, map marker and
chart updates immediately. Defaults: audience 30%, proximity 25%, industry fit 25%,
captive audience 12%, route density 8%.

---

## The one thing worth knowing about the data

**Reported headcount is not the number of people at that address.** A janitorial firm
with 650 employees has almost nobody at its office — the staff are at client sites. A
hospital with 650 has most of them under one roof, plus patients and visitors on top.

Every venue type carries an *on-site share* and a *visitor multiplier*, and the
**daily audience** figure you sort and map on is the corrected number. This is why a
650-person facilities company ranks below a 250-person hospital. The Method tab spells
out the full model.

---

## Loading a different spreadsheet

**In the browser** — click **Import Excel**, drop in any `.xlsx` or `.csv`. Columns are
matched by name, so `Company Name`, `Address`, `City`, `ZIP`, `Number of Employees` and a
description column are picked up automatically. It geocodes through the US Census
geocoder, falls back to OpenStreetMap for anything the Census can't match, then routes
real driving distances through OSRM. A few hundred rows takes a couple of minutes;
results are cached so a re-import is fast.

To make an import permanent, click the `{ }` button to export the enriched dataset, save
it over `data/companies.json`, and run `python3 scripts/build.py`.

**From the command line** — faster and more thorough, since it uses the Census *batch*
endpoint:

```bash
pip3 install openpyxl requests
python3 scripts/pipeline.py "data/Your New List.xlsx"
python3 scripts/build.py
```

To bake a different *default* home base into `index.html` for everyone who opens it (the
in-app button is per-person):

```bash
python3 scripts/pipeline.py "data/Your List.xlsx" --home "123 Main St, Colorado Springs, CO"
python3 scripts/build.py
```

---

## Project layout

```
Location_web_app/
├── index.html              ← the app. Double-click this. Generated by build.py.
├── GUIDE.html              ← the operator's manual (also linked from the app's top bar)
├── serve.command           ← optional: double-click to serve on localhost:8777
├── README.md
├── data/
│   ├── companies.json      ← enriched dataset (geocodes, routes, scores)
│   └── General List - Akash Mainali 80920.xlsx
├── src/
│   ├── index.template.html ← page shell
│   ├── styles.css          ← design tokens and layout
│   └── app.js              ← all application logic
├── vendor/
│   ├── leaflet.js          ← map library, bundled so the map works offline
│   └── leaflet.css
└── scripts/
    ├── pipeline.py         ← spreadsheet → geocode → route → classify → score
    └── build.py            ← inlines src/ + data/ into index.html
```

Edit anything under `src/`, then run `python3 scripts/build.py` to rebuild `index.html`.

---

## Where the numbers come from

| Layer | Source |
|---|---|
| Companies, addresses, headcount, HR contacts | your spreadsheet |
| Coordinates | US Census Bureau TIGER geocoder, OpenStreetMap Nominatim as fallback |
| Driving distance and time | OSRM, routed on the real road network |
| Industry classification | NAICS code + business description + company name |
| On-site share, visitor multiplier, industry fit, capture rate | modelled per venue type — see the Method tab |

All three services are free and need no API key.

Of the 365 addresses: 305 matched to an exact rooftop, 27 to a nearby address range, 31
via OpenStreetMap, and 2 fell back to a ZIP-code centroid. Every site's match quality is
shown in its detail panel, so you know which pins to trust to the metre and which to
eyeball before driving out.

---

## Honest limits

- Employee counts are as supplied and may be company-wide rather than site-specific.
- The tool doesn't know whether a building already has vending, has a cafeteria next
  door, or whether the landlord permits machines.
- Revenue projections rank sites against each other. They are not a business plan.
- Use the ranking to decide **who to call first**. The HR contact for every site is one
  click away in the detail panel. The calls settle the rest.
