#!/usr/bin/env python3
"""
Zenith & Sky — vending location data pipeline.

Turns a spreadsheet of companies into the enriched data/companies.json the web
app reads: geocodes every address, routes real driving distance and time from
home, classifies each business into a venue type, and computes the sub-scores
and unit economics.

    python3 scripts/pipeline.py "data/General List.xlsx"
    python3 scripts/pipeline.py "data/List.xlsx" --home "123 Main St, Colorado Springs, CO"

Needs: openpyxl (or pandas) and requests, plus an internet connection.
    pip3 install openpyxl requests

Services used, all free and keyless:
  * US Census Bureau batch geocoder — https://geocoding.geo.census.gov
  * OpenStreetMap Nominatim (fallback) — https://nominatim.openstreetmap.org
  * OSRM demo router — https://router.project-osrm.org
"""
import argparse, csv, io, json, math, os, re, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HOME_DEFAULT = "3544 Cape Romain Dr, Colorado Springs, CO 80920"
AVG_PRICE = 2.75
MARGIN = 0.52

# =============================================================== venue types
# fit      how well vending converts at this venue type (0-100)
# dwell    captive audience — how hard is it to walk out for food (0-100)
# onsite   share of the reported headcount actually at this address
# visitors daily non-employee footfall, as a multiple of on-site staff
# alwaysOn operates seven days / multiple shifts
CATS = {
 "healthcare":   {"label":"Healthcare & Hospitals",     "fit":95,"dwell":98,"onsite":0.75,"visitors":0.90,"alwaysOn":True, "color":"#e0466c","icon":"H"},
 "manufacturing":{"label":"Manufacturing & Industrial", "fit":95,"dwell":95,"onsite":0.85,"visitors":0.05,"alwaysOn":True, "color":"#f4791f","icon":"M"},
 "logistics":    {"label":"Logistics & Warehousing",    "fit":92,"dwell":90,"onsite":0.60,"visitors":0.10,"alwaysOn":True, "color":"#8d6e63","icon":"L"},
 "aerospace":    {"label":"Aerospace & Defense",        "fit":90,"dwell":92,"onsite":0.85,"visitors":0.05,"alwaysOn":False,"color":"#3d5afe","icon":"A"},
 "callcenter":   {"label":"Call Center & Back Office",  "fit":90,"dwell":88,"onsite":0.90,"visitors":0.03,"alwaysOn":False,"color":"#00acc1","icon":"C"},
 "education":    {"label":"Education & Campus",         "fit":85,"dwell":80,"onsite":0.80,"visitors":1.60,"alwaysOn":False,"color":"#7cb342","icon":"E"},
 "hospitality":  {"label":"Hotels & Hospitality",       "fit":85,"dwell":88,"onsite":0.70,"visitors":2.20,"alwaysOn":True, "color":"#ec407a","icon":"T"},
 "fitness":      {"label":"Fitness, Sports & Venues",   "fit":82,"dwell":60,"onsite":0.60,"visitors":3.00,"alwaysOn":False,"color":"#26a69a","icon":"G"},
 "utilities":    {"label":"Utilities & Energy",         "fit":82,"dwell":78,"onsite":0.60,"visitors":0.05,"alwaysOn":True, "color":"#fbc02d","icon":"U"},
 "senior":       {"label":"Senior Living & Care",       "fit":80,"dwell":85,"onsite":0.65,"visitors":0.60,"alwaysOn":True, "color":"#c77dff","icon":"S"},
 "government":   {"label":"Government & Public",        "fit":80,"dwell":75,"onsite":0.80,"visitors":0.70,"alwaysOn":False,"color":"#5c6bc0","icon":"P"},
 "automotive":   {"label":"Automotive & Dealerships",   "fit":78,"dwell":70,"onsite":0.85,"visitors":1.40,"alwaysOn":False,"color":"#ff7043","icon":"V"},
 "residential":  {"label":"Residential & Apartments",   "fit":75,"dwell":85,"onsite":0.30,"visitors":6.00,"alwaysOn":True, "color":"#9575cd","icon":"R"},
 "tech":         {"label":"Tech & Software",            "fit":60,"dwell":65,"onsite":0.72,"visitors":0.05,"alwaysOn":False,"color":"#29b6f6","icon":"D"},
 "finance":      {"label":"Finance & Insurance",        "fit":58,"dwell":55,"onsite":0.85,"visitors":0.20,"alwaysOn":False,"color":"#78909c","icon":"F"},
 "professional": {"label":"Professional Services",      "fit":55,"dwell":55,"onsite":0.78,"visitors":0.10,"alwaysOn":False,"color":"#90a4ae","icon":"B"},
 "construction": {"label":"Construction & Trades",      "fit":50,"dwell":40,"onsite":0.25,"visitors":0.05,"alwaysOn":False,"color":"#a1887f","icon":"K"},
 "fieldservices":{"label":"Field & Facility Services",  "fit":45,"dwell":40,"onsite":0.15,"visitors":0.05,"alwaysOn":False,"color":"#b0846c","icon":"J"},
 "nonprofit":    {"label":"Nonprofit & Religious",      "fit":45,"dwell":45,"onsite":0.70,"visitors":1.10,"alwaysOn":False,"color":"#bdbdbd","icon":"N"},
 "retail":       {"label":"Retail & Food Service",      "fit":35,"dwell":45,"onsite":0.85,"visitors":2.00,"alwaysOn":False,"color":"#d4a373","icon":"X"},
 "other":        {"label":"Other / Unclassified",       "fit":50,"dwell":50,"onsite":0.70,"visitors":0.20,"alwaysOn":False,"color":"#9e9e9e","icon":"?"},
}

# Ordered classification rules — first match wins, so this list runs from most
# specific to most general. field 'n' matches the company name, 'd' the
# NAICS business description. These are also compiled into the web app so an
# in-browser import classifies exactly the same way.
RULES = [
 (r"hospitality|hotel|inn\b|resort|lodge|suites\b", "n", "hospitality"),
 (r"\bhospital\b|medical cent|health system|penrose|memorial hosp|urgent care|orthopaed|orthoped|\bclinic|healthcare|health care|\bhealth\b", "n", "healthcare"),
 (r"hospice|nursing|assisted living|retirement|senior|elder care|life care|brookdale|bethesda|nursecore", "n", "senior"),
 (r"\bymca\b|fitness|\bgym\b|athletic club|golf club|country club|world arena|rodeo|stadium|arena\b", "n", "fitness"),
 (r"apartment|residences|family housing|housing authorit", "n", "residential"),
 (r"school district|\bacademy\b|\bcollege\b|universit|seminary|charter school|library district", "n", "education"),
 (r"church|ministr|chapel|parish|diocese|synagogue|congregation|fellowship|navigators|young life|compassion int|focus on the family|goodwill|salvation army|united way|\bymca\b", "n", "nonprofit"),
 (r"janitorial|maid\b|cleaning|security services|staffing|temp(orary)? help|landscap|canvassing", "n", "fieldservices"),
 (r"bon appetit|food service|kitchens?\b|catering|restaurant|pizza|grill\b", "n", "retail"),
 (r"electric (&|and) |electrical contract|plumbing|roofing|paving|concrete|excavat", "n", "construction"),
 (r"utilit|electric (co|assoc|cooper)|cooperative|energy\b", "n", "utilities"),
 (r"^city of |^county |united states|department of|space force|air force|\bfort carson\b", "n", "government"),

 (r"insurance carrier|insurance agenc|insurance", "d", "finance"),
 (r"\bhospital|physician|outpatient|dental|dentist|optometr|chiropract|diagnostic|imaging cent|ambulance|blood and organ|medical laborator|kidney dialysis|home health care|health practitioner|mental health|substance abuse", "d", "healthcare"),
 (r"nursing care|retirement communit|elderly|assisted living|hospice|continuing care|residential (intellectual|mental|care)|child day care|vocational rehab", "d", "senior"),
 (r"individual and family services|community food|emergency and other relief|temporary shelter", "d", "nonprofit"),
 (r"janitorial|security guard|patrol service|services to buildings|landscaping service|pest control|employment placement|temporary help|professional employer|carpet and upholstery|exterminat", "d", "fieldservices"),
 (r"guided missile|search, detection|navigation|aeronautical|space vehicle|defense|ammunition|ordnance", "d", "aerospace"),
 (r"manufactur|\bmill\b|refin|foundr|printing|bakeri|brewer|ready-mix|fabricat|sawmill|smelting|converted paper|plastics product|machine shop|metal|semiconductor|materials recovery|waste treatment|recycl", "d", "manufacturing"),
 (r"trucking|warehous|freight|courier|moving|logistic|air cargo|airport operation|scheduled passenger air|charter bus|transit system|taxi|limousine|bus transportation|postal|delivery", "d", "logistics"),
 (r"telephone answering|telemarketing|contact cent|collection agenc|document preparation|business support|office administrative|payroll service|billing", "d", "callcenter"),
 (r"\bcollege|universit|\bschool|instruction|educational support|training|librar|museum", "d", "education"),
 (r"hotel|motel|casino|rooming|bed-and-breakfast|\bcaterer|food service contract", "d", "hospitality"),
 (r"golf course|country club|fitness|sports team|\bsports?\b and recreation|amusement|bowling|marina|skiing|promoters of performing|racetrack|recreational and vacation camp", "d", "fitness"),
 (r"electric power|natural gas|water supply|sewage|utilit|pipeline", "d", "utilities"),
 (r"religious|civic and social|grantmaking|advocacy|professional organization|labor union|political organization|other similar organizations|social advocacy", "d", "nonprofit"),
 (r"car dealer|automobile dealer|motor vehicle dealer|car wash|automotive (repair|parts)|tire dealer|truck.*dealer|recreational vehicle dealer", "d", "automotive"),
 (r"software|computer systems design|custom computer program|computer facilities|data processing|hosting|information technolog|internet publishing|media streaming|web search", "d", "tech"),
 (r"lessors of residential|apartment|real estate|property manag|lessors of", "d", "residential"),
 (r"^(commercial |savings )?bank|credit union|securit(y|ies) (broker|contract)|investment|portfolio management|financial|mortgage|title abstract|credit intermediation|trust, fiduciary", "d", "finance"),
 (r"contractor|construction|plumbing|roofing|electrical wiring|masonry|excavat|paving|drywall|glass and glazing|site preparation|framing|siding|structural steel erection|highway, street|water and sewer line|building equipment|finishing contractor|land subdivision", "d", "construction"),
 (r"executive offices|public administration|correctional|police|fire protection|national security|justice|public finance|regulation of|administration of|legislative", "d", "government"),
 (r"engineering service|architect|\blawyer|legal service|accounting|tax preparation|consult|management of companies|advertis|public relations|marketing research|surveying|testing laborator|human resources|graphic design|specialized design|holding compan|photographic|veterinar|broadcast|radio station|television", "d", "professional"),
 (r"restaurant|full-service|limited-service|snack and nonalcoholic|drinking place|grocer|supermarket|convenience (retail|store)|retailer|beauty salon|barber|nail salon|dry ?clean|funeral|repair and maintenance|personal care service|florist|pharmac", "d", "retail"),
]

NAICS_RULES = [
 ("622","healthcare"),("621","healthcare"),("623","senior"),("624","senior"),
 ("3345","aerospace"),("3364","aerospace"),
 ("31","manufacturing"),("32","manufacturing"),("33","manufacturing"),
 ("484","logistics"),("493","logistics"),("488","logistics"),("485","logistics"),("492","logistics"),
 ("5613","fieldservices"),("5617","fieldservices"),("5616","fieldservices"),
 ("5614","callcenter"),("5611","callcenter"),("5619","callcenter"),("5612","callcenter"),
 ("611","education"),("721","hospitality"),("713","fitness"),("711","fitness"),
 ("221","utilities"),("92","government"),
 ("441","automotive"),("8111","automotive"),
 ("531","residential"),("5112","tech"),("5415","tech"),("518","tech"),("516","tech"),
 ("52","finance"),("54","professional"),("55","professional"),("23","construction"),
 ("813","nonprofit"),("44","retail"),("45","retail"),("722","retail"),("81","retail"),
]

BANDS = [
 {"key":"green",  "label":"Under 5 mi", "short":"<5 mi",    "color":"#16a34a"},
 {"key":"yellow", "label":"5 – 10 mi",  "short":"5-10 mi",  "color":"#eab308"},
 {"key":"orange", "label":"10 – 15 mi", "short":"10-15 mi", "color":"#f97316"},
 {"key":"red",    "label":"15 mi +",    "short":"15+ mi",   "color":"#dc2626"},
]


def classify(name, desc, naics=""):
    n, d = (name or "").lower(), (desc or "").lower()
    for pat, field, cat in RULES:
        if re.search(pat, n if field == "n" else d):
            return cat, ("name" if field == "n" else "industry")
    digits = re.sub(r"\D", "", naics or "")
    if digits:
        for p, cat in sorted(NAICS_RULES, key=lambda x: -len(x[0])):
            if digits.startswith(p):
                return cat, "naics"
    return "other", "unclassified"


def haversine(a_lat, a_lon, b_lat, b_lon):
    R = 3958.7613
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    h = (math.sin((p2 - p1) / 2) ** 2 +
         math.cos(p1) * math.cos(p2) * math.sin(math.radians(b_lon - a_lon) / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(h))


def band_of(mi):
    return 0 if mi < 5 else 1 if mi < 10 else 2 if mi < 15 else 3


# ================================================================ spreadsheet
def read_sheet(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".csv":
        with open(path, newline="", encoding="utf-8-sig") as f:
            return list(csv.DictReader(f))
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = list(ws.iter_rows(values_only=True))
    head = [str(h or "").strip() for h in rows[0]]
    return [dict(zip(head, r)) for r in rows[1:]]


def pick(keys, *cands):
    """Match a column by name: exact normalised match first, then substring."""
    norm = {k: re.sub(r"[^a-z]", "", k.lower()) for k in keys}
    for c in cands:
        for k in keys:
            if norm[k] == c:
                return k
    for c in cands:
        for k in keys:
            if c in norm[k]:
                return k
    return None


def normalise(raw):
    keys = list(raw[0].keys())
    m = {
        "company": pick(keys, "companyname", "company", "organization", "business", "name"),
        "addr": pick(keys, "address", "street"), "city": pick(keys, "city"),
        "state": pick(keys, "state"), "zip": pick(keys, "zip", "postal"),
        "phone": pick(keys, "phone", "tel"), "web": pick(keys, "website", "url", "web"),
        "emp": pick(keys, "numberofemployees", "employees", "employee", "headcount"),
        "desc": pick(keys, "businessdescription", "description", "industry"),
        "naics": pick(keys, "naics", "naicscode", "sic", "naicsnumber"),
        "first": pick(keys, "firstname"), "last": pick(keys, "lastname"),
    }
    if not m["company"] or not m["addr"]:
        raise SystemExit("Could not find company-name and address columns in: " + ", ".join(keys))
    out = []
    for i, r in enumerate(raw):
        company = str(r.get(m["company"]) or "").strip()
        addr = str(r.get(m["addr"]) or "").strip()
        if not company or not addr:
            continue
        out.append({
            "id": len(out), "company": company, "addr": addr,
            "city": str(r.get(m["city"]) or "").strip(),
            "state": str(r.get(m["state"]) or "CO").strip(),
            "zip": str(r.get(m["zip"]) or "").strip(),
            "phone": str(r.get(m["phone"]) or "").strip(),
            "web": str(r.get(m["web"]) or "").strip(),
            "emp": int(re.sub(r"\D", "", str(r.get(m["emp"]) or "0")) or 0),
            "desc": str(r.get(m["desc"]) or "").strip(),
            "naics": str(r.get(m["naics"]) or "").strip(),
            "first": str(r.get(m["first"]) or "Human Resources").strip(),
            "last": str(r.get(m["last"]) or "Director").strip(),
        })
    return out


# =================================================================== services
def census_batch(session, recs):
    """Geocode up to 10,000 rows in one POST. Returns {id: (lat, lon, quality)}."""
    buf = io.StringIO()
    w = csv.writer(buf)
    for r in recs:
        w.writerow([r["id"], r["addr"], r["city"], r["state"], r["zip"][:5]])
    files = {"addressFile": ("addresses.csv", buf.getvalue(), "text/csv")}
    resp = session.post("https://geocoding.geo.census.gov/geocoder/locations/addressbatch",
                        files=files, data={"benchmark": "Public_AR_Current"}, timeout=300)
    resp.raise_for_status()
    found = {}
    for row in csv.reader(io.StringIO(resp.text)):
        if len(row) >= 6 and row[2] == "Match" and row[5]:
            lon, lat = row[5].split(",")
            found[int(row[0])] = (float(lat), float(lon), "Exact" if row[3] == "Exact" else "Non_Exact")
    return found


def nominatim(session, query):
    try:
        r = session.get("https://nominatim.openstreetmap.org/search",
                        params={"format": "json", "limit": 1, "countrycodes": "us", "q": query},
                        headers={"User-Agent": "ZenithSkyVending/1.0"}, timeout=30)
        j = r.json()
        return (float(j[0]["lat"]), float(j[0]["lon"])) if j else None
    except Exception:
        return None


def geocode_all(session, recs):
    coords = {}
    for s in range(0, len(recs), 1000):
        chunk = recs[s:s + 1000]
        print("  Census batch %d–%d…" % (s + 1, s + len(chunk)))
        try:
            coords.update(census_batch(session, chunk))
        except Exception as e:
            print("   ! Census batch failed (%s) — falling back to OSM for this chunk" % e)
    missing = [r for r in recs if r["id"] not in coords]
    if missing:
        print("  %d unmatched — retrying via OpenStreetMap (1/sec)…" % len(missing))
        for r in missing:
            for q in ("%(addr)s, %(city)s, %(state)s %(zip)s" % r, "%(addr)s, %(city)s, %(state)s" % r):
                hit = nominatim(session, q)
                time.sleep(1.1)
                if hit:
                    coords[r["id"]] = (hit[0], hit[1], "OSM")
                    break
            else:
                hit = nominatim(session, "%(city)s, %(state)s %(zip)s" % r)
                time.sleep(1.1)
                if hit:
                    coords[r["id"]] = (hit[0], hit[1], "ZIP-approx")
    return coords


def route_all(session, home, recs, coords):
    """One-to-many driving distance/time via the OSRM table service."""
    out = {}
    ids = [r["id"] for r in recs if r["id"] in coords]
    for s in range(0, len(ids), 80):
        chunk = ids[s:s + 80]
        pts = ["%f,%f" % (home[1], home[0])] + ["%f,%f" % (coords[i][1], coords[i][0]) for i in chunk]
        url = "https://router.project-osrm.org/table/v1/driving/" + ";".join(pts)
        try:
            j = session.get(url, params={"sources": 0, "annotations": "distance,duration"}, timeout=120).json()
            if j.get("code") == "Ok":
                for k, i in enumerate(chunk):
                    d, t = j["distances"][0][k + 1], j["durations"][0][k + 1]
                    if d is not None:
                        out[i] = (d / 1609.344, t / 60.0)
        except Exception as e:
            print("   ! routing chunk failed (%s)" % e)
        time.sleep(0.5)
    # straight-line fallback with a 1.28 road factor
    for i in ids:
        if i not in out:
            mi = haversine(home[0], home[1], coords[i][0], coords[i][1]) * 1.28
            out[i] = (mi, mi * 2.2)
    return out


# ==================================================================== scoring
def build(recs, coords, routes, home_label, home_lat, home_lon, source):
    out = []
    for r in recs:
        if r["id"] not in coords:
            continue
        lat, lon, q = coords[r["id"]]
        mi, mn = routes[r["id"]]
        cat, via = classify(r["company"], r["desc"], r["naics"])
        c = CATS[cat]
        emp = r["emp"]

        onsite = emp * c["onsite"]
        audience = onsite * (1 + c["visitors"])
        traffic = min(100.0, max(0.0, (math.log10(max(audience, 1)) - 1.1) / 2.3 * 100))
        proximity = 100 * math.exp(-mi / 11.0)

        capture = 0.05 + c["fit"] / 100.0 * 0.15
        days = 30 if c["alwaysOn"] else 21
        daily = audience * capture
        revenue = daily * AVG_PRICE * days
        gross = revenue * MARGIN
        service = 2 * (mi * 2 * 0.70 + ((mn * 2 + 15) / 60.0) * 28)

        out.append({
            "id": r["id"], "company": r["company"], "address": r["addr"], "city": r["city"],
            "state": r["state"], "zip": r["zip"], "phone": r["phone"], "website": r["web"],
            "contactName": (r["first"] + " " + r["last"]).strip(),
            "employees": emp, "description": r["desc"], "naicsCode": r["naics"],
            "category": cat, "categoryVia": via,
            "lat": round(lat, 6), "lon": round(lon, 6), "geoQuality": q,
            "driveMiles": round(mi, 2), "driveMinutes": round(mn, 1),
            "straightMiles": round(haversine(home_lat, home_lon, lat, lon), 2),
            "band": band_of(mi),
            "onsiteEstimate": round(onsite), "audience": round(audience),
            "sTraffic": round(traffic, 1), "sProximity": round(proximity, 1),
            "sFit": float(c["fit"]), "sDwell": float(c["dwell"]),
            "estDailyVends": round(daily, 1), "estMonthlyRevenue": round(revenue),
            "estMonthlyGross": round(gross), "estServiceCost": round(service),
            "estMonthlyNet": round(gross - service),
        })

    for a in out:
        n = en = 0
        for b in out:
            if a["id"] != b["id"] and haversine(a["lat"], a["lon"], b["lat"], b["lon"]) <= 1.5:
                n += 1
                en += b["employees"]
        a["neighbors"] = n
        a["neighborEmployees"] = en
        a["sCluster"] = round(min(100.0, math.log1p(n) / math.log1p(45) * 100), 1)

    cats = {k: dict(v, count=sum(1 for o in out if o["category"] == k)) for k, v in CATS.items()}
    return {
        "meta": {
            "generated": time.strftime("%Y-%m-%d"), "source": source, "recordCount": len(out),
            "geocoder": "US Census Bureau TIGER + OpenStreetMap Nominatim fallback",
            "router": "OSRM driving profile — real road distance and drive time",
            "avgVendPrice": AVG_PRICE, "grossMarginPct": int(MARGIN * 100),
        },
        "home": {"lat": home_lat, "lon": home_lon, "label": home_label},
        "bands": BANDS, "categories": cats, "companies": out,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spreadsheet", help=".xlsx or .csv of companies")
    ap.add_argument("--home", default=HOME_DEFAULT, help="home base address")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "companies.json"))
    args = ap.parse_args()

    try:
        import requests
    except ImportError:
        raise SystemExit("pip3 install requests openpyxl")
    session = requests.Session()

    print("Reading %s…" % args.spreadsheet)
    recs = normalise(read_sheet(args.spreadsheet))
    print("  %d usable rows" % len(recs))

    print("Locating home base…")
    hg = session.get("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress",
                     params={"address": args.home, "benchmark": "Public_AR_Current", "format": "json"},
                     timeout=60).json()
    m = hg["result"]["addressMatches"]
    if m:
        home_lat, home_lon = m[0]["coordinates"]["y"], m[0]["coordinates"]["x"]
    else:
        hit = nominatim(session, args.home)
        if not hit:
            raise SystemExit("Could not geocode the home address: " + args.home)
        home_lat, home_lon = hit
    print("  %s → %.6f, %.6f" % (args.home, home_lat, home_lon))

    print("Geocoding %d addresses…" % len(recs))
    coords = geocode_all(session, recs)
    print("  located %d of %d" % (len(coords), len(recs)))

    print("Routing driving distances…")
    routes = route_all(session, (home_lat, home_lon), recs, coords)

    print("Classifying and scoring…")
    payload = build(recs, coords, routes, args.home, home_lat, home_lon,
                    os.path.basename(args.spreadsheet))

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    print("Wrote %s (%d sites, %.0f KB)" % (args.out, len(payload["companies"]),
                                            os.path.getsize(args.out) / 1024))
    print("\nNow run:  python3 scripts/build.py")


if __name__ == "__main__":
    main()
