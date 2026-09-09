/* ============================================================================
   Zenith & Sky — Vending Location Intelligence
   Single-page analysis tool. No build step, no server required.
   ========================================================================= */
(function () {
'use strict';

/* ------------------------------------------------------------------ state */
const DATA = window.__DATA__;
const CATS = DATA.categories;
const BANDS = DATA.bands;
const TIERS = DATA.verifyTiers || {};
const DEFAULT_HOME = { ...DATA.home };
let HOME = { ...DATA.home };
const MI = 1609.344;

const LS = {
  get(k, d) { try { const v = localStorage.getItem('zs_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('zs_' + k, JSON.stringify(v)); } catch (e) {} }
};

const SORT_FIELDS = [
  { k: 'score',           label: 'Placement score',        dir: -1, fmt: v => v.toFixed(1) },
  { k: 'driveMiles',      label: 'Drive distance (mi)',    dir:  1, fmt: v => v.toFixed(1) + ' mi' },
  { k: 'driveMinutes',    label: 'Drive time (min)',       dir:  1, fmt: v => v.toFixed(0) + ' min' },
  { k: 'straightMiles',   label: 'Straight-line (mi)',     dir:  1, fmt: v => v.toFixed(1) + ' mi' },
  { k: 'employees',       label: 'Employees (total)',      dir: -1, fmt: v => v.toLocaleString() },
  { k: 'audience',        label: 'Daily on-site audience', dir: -1, fmt: v => v.toLocaleString() },
  { k: 'estMonthlyNet',   label: 'Est. monthly net ($)',   dir: -1, fmt: v => '$' + v.toLocaleString() },
  { k: 'estMonthlyRevenue', label: 'Est. monthly revenue', dir: -1, fmt: v => '$' + v.toLocaleString() },
  { k: 'sFit',            label: 'Industry fit',           dir: -1, fmt: v => v.toFixed(0) },
  { k: 'sDwell',          label: 'Captive / dwell time',   dir: -1, fmt: v => v.toFixed(0) },
  { k: 'neighbors',       label: 'Route density (1.5 mi)', dir: -1, fmt: v => v + ' sites' },
  { k: 'categoryLabel',   label: 'Industry (A–Z)',         dir:  1, fmt: v => v },
  { k: 'company',         label: 'Company name (A–Z)',     dir:  1, fmt: v => v },
  { k: 'city',            label: 'City (A–Z)',             dir:  1, fmt: v => v },
  { k: 'zip',             label: 'ZIP code',               dir:  1, fmt: v => v },
  { k: 'vwarn',           label: 'Record warnings',        dir: -1, fmt: v => v + ' flag' + (v === 1 ? '' : 's') }
];

const WEIGHT_DEFS = [
  { k: 'traffic',   src: 'sTraffic',   label: 'Audience size',   color: 'var(--s1)', hint: 'People on site each day' },
  { k: 'proximity', src: 'sProximity', label: 'Proximity',       color: 'var(--s2)', hint: 'Cheap and fast to restock' },
  { k: 'fit',       src: 'sFit',       label: 'Industry fit',    color: 'var(--s3)', hint: 'How well vending converts here' },
  { k: 'dwell',     src: 'sDwell',     label: 'Captive audience', color: 'var(--s4)', hint: 'Can people easily leave for food?' },
  { k: 'cluster',   src: 'sCluster',   label: 'Route density',   color: 'var(--s5)', hint: 'Other sites nearby on one trip' }
];

const S = {
  rows: DATA.companies.map(c => ({
    ...c, categoryLabel: CATS[c.category].label, score: 0,
    vtier: (c.verify && c.verify.tier) || 'consistent',
    vwarn: (c.verify && c.verify.warnings) || 0
  })),
  view: 'map',
  q: '',
  bands: new Set([0, 1, 2, 3]),
  cats: new Set(Object.keys(CATS)),
  tiers: new Set(Object.keys(TIERS).length ? Object.keys(TIERS) : ['verified','consistent','caution','check']),
  empMin: 50, empMax: 3200, maxDrive: 60, minScore: 0,
  onsiteOnly: false,
  shortlistOnly: false,
  sorts: LS.get('sorts', [{ k: 'score', dir: -1 }]),
  weights: LS.get('weights', { traffic: 30, proximity: 25, fit: 25, dwell: 12, cluster: 8 }),
  shortlist: new Set(LS.get('shortlist', [])),
  selected: null,
  mapColorBy: 'band',
  showRings: true,
  filtered: []
};

const empExtent = S.rows.reduce((a, r) => [Math.min(a[0], r.employees), Math.max(a[1], r.employees)], [1e9, 0]);
S.empMin = empExtent[0]; S.empMax = empExtent[1];

/* --------------------------------------------------------------- utilities */
const $ = s => document.querySelector(s);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + Math.round(n).toLocaleString();
const bandOf = mi => mi < 5 ? 0 : mi < 10 ? 1 : mi < 15 ? 2 : 3;
const bandVar = i => `var(--band-${i})`;

function vTier(r) { return TIERS[r.vtier] || { label: r.vtier, color: 'var(--text-3)', icon: '' }; }
function vBadge(r, big) {
  const t = vTier(r);
  const n = r.vwarn ? ` ${r.vwarn}` : '';
  const title = t.label + (r.vwarn ? ` — ${r.vwarn} flag${r.vwarn === 1 ? '' : 's'} to check` : '');
  return `<span class="vbadge ${r.vtier}${big ? ' lg' : ''}" title="${esc(title)}">${t.icon}${big ? ' ' + esc(t.label) : n}</span>`;
}

let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ------------------------------------------------------------------ scoring
   The composite is a weighted mean of five 0–100 sub-scores. Weights are
   normalised so the result always lands on a 0–100 scale no matter how the
   sliders are set. Each part is stored on the row so the drawer and the
   score-composition chart can show exactly where a number came from.        */
function recomputeScores() {
  const w = S.weights;
  const total = WEIGHT_DEFS.reduce((a, d) => a + (w[d.k] || 0), 0) || 1;
  for (const r of S.rows) {
    let s = 0;
    r.parts = {};
    for (const d of WEIGHT_DEFS) {
      const contrib = (r[d.src] || 0) * (w[d.k] || 0) / total;
      r.parts[d.k] = contrib;
      s += contrib;
    }
    r.score = s;
  }
  const ranked = [...S.rows].sort((a, b) => b.score - a.score);
  ranked.forEach((r, i) => { r.globalRank = i + 1; });
}

/* ---------------------------------------------------------------- filtering */
function applyFilters() {
  const q = S.q.trim().toLowerCase();
  S.filtered = S.rows.filter(r => {
    if (!S.bands.has(r.band)) return false;
    if (!S.cats.has(r.category)) return false;
    if (!S.tiers.has(r.vtier)) return false;
    if (r.employees < S.empMin || r.employees > S.empMax) return false;
    if (r.driveMinutes > S.maxDrive) return false;
    if (r.score < S.minScore) return false;
    if (S.onsiteOnly && CATS[r.category].onsite < 0.5) return false;
    if (S.shortlistOnly && !S.shortlist.has(r.id)) return false;
    if (q) {
      const hay = (r.company + ' ' + r.address + ' ' + r.city + ' ' + r.zip + ' ' +
                   r.description + ' ' + r.categoryLabel + ' ' + r.contactName).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  sortRows(S.filtered);
  S.filtered.forEach((r, i) => { r.rank = i + 1; });
}

function sortRows(arr) {
  const rules = S.sorts.length ? S.sorts : [{ k: 'score', dir: -1 }];
  arr.sort((a, b) => {
    for (const rule of rules) {
      const av = a[rule.k], bv = b[rule.k];
      let c;
      if (typeof av === 'string') c = av.localeCompare(bv, undefined, { sensitivity: 'base' });
      else c = (av || 0) - (bv || 0);
      if (c !== 0) return c * rule.dir;
    }
    return a.company.localeCompare(b.company);
  });
}

/* ------------------------------------------------------------- render: shell */
function render() {
  recomputeScores();
  applyFilters();
  renderSidebar();
  $('#resultCount').innerHTML = `<b>${S.filtered.length}</b> of ${S.rows.length} sites`;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.view === S.view));
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.dataset.view !== S.view; });
  $('#tabShortlistCount').textContent = S.shortlist.size;
  if (S.view === 'map') renderMap();
  else if (S.view === 'list') renderTable();
  else if (S.view === 'top') renderTop();
  else if (S.view === 'shortlist') renderShortlist();
  else if (S.view === 'charts') renderCharts();
  else if (S.view === 'method') renderMethod();
}

/* ----------------------------------------------------------------- sidebar */
function renderSidebar() {
  // band filters
  const bandBox = $('#bandFilters'); bandBox.innerHTML = '';
  BANDS.forEach((b, i) => {
    const n = S.rows.filter(r => r.band === i).length;
    const on = S.bands.has(i);
    const row = el('button', 'filter-row ' + (on ? 'on' : 'off'));
    row.innerHTML = `<span class="swatch" style="background:${bandVar(i)}">${i + 1}</span>
      <span class="lbl">${b.label}</span><span class="cnt">${n}</span>
      <span class="check">✓</span>`;
    row.onclick = () => { S.bands.has(i) ? S.bands.delete(i) : S.bands.add(i); render(); };
    bandBox.appendChild(row);
  });

  // record-confidence filters
  const tierBox = $('#tierFilters');
  if (tierBox) {
    tierBox.innerHTML = '';
    Object.entries(TIERS).forEach(([k, v]) => {
      const n = S.rows.filter(r => r.vtier === k).length;
      const on = S.tiers.has(k);
      const row = el('button', 'filter-row ' + (on ? 'on' : 'off'));
      row.innerHTML = `<span class="swatch" style="background:${v.color};font-size:9px">${v.icon}</span>
        <span class="lbl" title="${esc(v.note)}">${esc(v.label)}</span>
        <span class="cnt">${n}</span><span class="check">✓</span>`;
      row.onclick = () => { S.tiers.has(k) ? S.tiers.delete(k) : S.tiers.add(k); render(); };
      tierBox.appendChild(row);
    });
  }

  // category filters, ordered by count
  const catBox = $('#catFilters'); catBox.innerHTML = '';
  Object.entries(CATS).filter(([, v]) => v.count > 0)
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([k, v]) => {
      const on = S.cats.has(k);
      const row = el('button', 'filter-row ' + (on ? 'on' : 'off'));
      row.innerHTML = `<span class="dot" style="background:${v.color}"></span>
        <span class="lbl" title="${esc(v.label)}">${esc(v.label)}</span>
        <span class="cnt">${v.count}</span><span class="check">✓</span>`;
      row.onclick = () => { S.cats.has(k) ? S.cats.delete(k) : S.cats.add(k); render(); };
      catBox.appendChild(row);
    });

  // sort rules
  const sb = $('#sortRules'); sb.innerHTML = '';
  S.sorts.forEach((rule, i) => {
    const row = el('div', 'sort-rule');
    const opts = SORT_FIELDS.map(f => `<option value="${f.k}"${f.k === rule.k ? ' selected' : ''}>${f.label}</option>`).join('');
    row.innerHTML = `<span class="ord">${i + 1}</span><select>${opts}</select>
      <button class="mini dir" title="Toggle direction">${rule.dir === 1 ? '↑' : '↓'}</button>
      <button class="mini up" title="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
      <button class="mini rm" title="Remove">✕</button>`;
    row.querySelector('select').onchange = e => {
      rule.k = e.target.value;
      rule.dir = (SORT_FIELDS.find(f => f.k === rule.k) || {}).dir || -1;
      saveSorts(); render();
    };
    row.querySelector('.dir').onclick = () => { rule.dir *= -1; saveSorts(); render(); };
    row.querySelector('.up').onclick = () => { if (i > 0) { [S.sorts[i - 1], S.sorts[i]] = [S.sorts[i], S.sorts[i - 1]]; saveSorts(); render(); } };
    row.querySelector('.rm').onclick = () => { S.sorts.splice(i, 1); saveSorts(); render(); };
    sb.appendChild(row);
  });
  $('#addSort').disabled = S.sorts.length >= 4;
  $('#sortSummary').textContent = S.sorts.length
    ? S.sorts.map(r => (SORT_FIELDS.find(f => f.k === r.k) || {}).label + (r.dir === 1 ? ' ↑' : ' ↓')).join(', then ')
    : 'Placement score ↓';

  // weights
  const wb = $('#weightRows'); wb.innerHTML = '';
  const totalW = WEIGHT_DEFS.reduce((a, d) => a + S.weights[d.k], 0) || 1;
  WEIGHT_DEFS.forEach(d => {
    const pct = Math.round(S.weights[d.k] / totalW * 100);
    const row = el('div', 'weight-row');
    row.innerHTML = `<div class="weight-head"><span class="dot" style="background:${d.color}"></span>
        <span class="lbl" title="${esc(d.hint)}">${d.label}</span><b>${pct}%</b></div>
      <input type="range" min="0" max="50" step="1" value="${S.weights[d.k]}">`;
    row.querySelector('input').oninput = e => {
      S.weights[d.k] = +e.target.value; LS.set('weights', S.weights); render();
    };
    wb.appendChild(row);
  });

  // numeric filters
  $('#empMinV').textContent = S.empMin.toLocaleString();
  $('#empMaxV').textContent = S.empMax.toLocaleString();
  $('#driveV').textContent = S.maxDrive + ' min';
  $('#minScoreV').textContent = S.minScore;
  $('#swOnsite').classList.toggle('on', S.onsiteOnly);
  $('#swShort').classList.toggle('on', S.shortlistOnly);
}
function saveSorts() { LS.set('sorts', S.sorts); }

/* --------------------------------------------------------------------- map */
let map, markerLayer, ringLayer, homeMarker, markerIndex = {};

function initMap() {
  if (map) return;
  if (typeof L === 'undefined') {
    $('#map').innerHTML = `<div class="empty" style="padding-top:110px"><div class="big">◉</div>
      <div style="font-weight:600;color:var(--text-2);margin-bottom:4px">The map library could not load</div>
      <div>The map is fetched from a CDN, so it needs an internet connection.<br>Everything else — ranking, filtering, analytics — works offline.</div></div>`;
    return;
  }
  map = L.map('map', { zoomControl: true, preferCanvas: false }).setView([HOME.lat, HOME.lon], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  ringLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);

  homeMarker = L.marker([HOME.lat, HOME.lon], {
    zIndexOffset: 1000,
    icon: L.divIcon({ className: '', html: '<div class="vm-home">★</div>', iconSize: [34, 34], iconAnchor: [17, 17] })
  }).addTo(map).bindPopup(`<div class="pop-t">Home base</div><div style="color:var(--text-2)">${esc(HOME.label)}</div>`);
}

function drawRings() {
  ringLayer.clearLayers();
  if (!S.showRings) return;
  [[5, 0], [10, 1], [15, 2]].forEach(([miles, bandIdx]) => {
    L.circle([HOME.lat, HOME.lon], {
      radius: miles * MI, color: bandVar(bandIdx), weight: 1.4, opacity: .55,
      fillOpacity: .035, fillColor: bandVar(bandIdx), dashArray: '5 5', interactive: false
    }).addTo(ringLayer);
    L.marker([HOME.lat + (miles * MI) / 111320, HOME.lon], {
      interactive: false,
      icon: L.divIcon({ className: '', html: `<div class="ring-label">${miles} mi</div>`, iconSize: [40, 14], iconAnchor: [20, 7] })
    }).addTo(ringLayer);
  });
}

let mapFitted = false;
function renderMap() {
  initMap();
  if (!map) return;
  setTimeout(() => map.invalidateSize(), 30);
  drawRings();
  markerLayer.clearLayers(); markerIndex = {};

  const maxAud = Math.max(...S.rows.map(r => r.audience), 1);
  S.filtered.forEach(r => {
    const size = Math.max(13, Math.min(34, 12 + Math.sqrt(r.audience / maxAud) * 26));
    const color = S.mapColorBy === 'band' ? bandVar(r.band) : CATS[r.category].color;
    const label = S.mapColorBy === 'band' ? (r.band + 1) : CATS[r.category].icon;
    const flagged = r.vwarn > 0;
    const m = L.marker([r.lat, r.lon], {
      icon: L.divIcon({
        className: '',
        html: `<div class="vm-pin${S.selected === r.id ? ' sel' : ''}${flagged ? ' flag' : ''}" style="width:${size}px;height:${size}px;background:${color};font-size:${Math.max(9, size * .42)}px">${label}</div>`,
        iconSize: [size, size], iconAnchor: [size / 2, size / 2]
      }),
      zIndexOffset: Math.round(r.score)
    });
    // Hover to skim, click to open the full record — no intermediate popup.
    m.bindTooltip(
      `<b>${esc(r.company)}</b><br>${r.driveMiles.toFixed(1)} mi · ${Math.round(r.driveMinutes)} min · ` +
      `${r.audience.toLocaleString()} audience · score ${r.score.toFixed(1)}` +
      (flagged ? `<br><span style="color:var(--band-2)">⚠ ${r.vwarn} record flag${r.vwarn === 1 ? '' : 's'}</span>` : ''),
      { direction: 'top', offset: [0, -size / 2 - 2], opacity: 1 });
    m.on('click', () => openDrawer(r.id));
    m.addTo(markerLayer);
    markerIndex[r.id] = m;
  });

  if (!mapFitted && S.filtered.length) {
    mapFitted = true;
    setTimeout(fitToFiltered, 60);
  }

  const lg = $('#mapLegend');
  if (S.mapColorBy === 'band') {
    lg.innerHTML = `<h4>Drive distance from home</h4>` +
      BANDS.map((b, i) => `<div class="legend-item">
        <span class="swatch" style="background:${bandVar(i)}">${i + 1}</span>
        <span>${b.label}</span><span class="cnt">${S.filtered.filter(r => r.band === i).length}</span></div>`).join('') +
      `<div class="legend-note">Marker size scales with estimated daily on-site audience; the numeral repeats the band so the map reads without colour. The dashed rings are a straight-line radius, so a site just inside a ring can still fall in the next band up — the colour follows real driving distance.</div>`;
  } else {
    const shown = Object.entries(CATS).filter(([k]) => S.filtered.some(r => r.category === k))
      .sort((a, b) => b[1].count - a[1].count).slice(0, 12);
    lg.innerHTML = `<h4>Industry type</h4>` + shown.map(([k, v]) => `<div class="legend-item">
        <span class="swatch" style="background:${v.color}">${v.icon}</span><span>${esc(v.label)}</span>
        <span class="cnt">${S.filtered.filter(r => r.category === k).length}</span></div>`).join('') +
      `<div class="legend-note">Letter codes repeat the industry so identity never depends on colour alone.</div>`;
  }
}

function fitToFiltered() {
  if (!map || !S.filtered.length) return;
  const b = L.latLngBounds(S.filtered.map(r => [r.lat, r.lon]));
  b.extend([HOME.lat, HOME.lon]);
  map.fitBounds(b, { padding: [50, 50] });
}

/* ------------------------------------------------------------------- table */
const COLS = [
  { k: 'rank',          t: '#',            r: false, w: '46px' },
  { k: 'company',       t: 'Company',      r: false },
  { k: 'categoryLabel', t: 'Industry',     r: false },
  { k: 'driveMiles',    t: 'Drive',        r: true },
  { k: 'employees',     t: 'Employees',    r: true },
  { k: 'audience',      t: 'Audience',     r: true },
  { k: 'estMonthlyNet', t: 'Est. net/mo',  r: true },
  { k: 'score',         t: 'Score',        r: true }
];

function renderTable() {
  const host = $('#viewList');
  if (!S.filtered.length) { host.innerHTML = emptyState(); return; }
  const activeSort = S.sorts[0] || {};
  const thead = COLS.map(c => {
    const active = c.k === activeSort.k;
    return `<th class="${c.r ? 'r' : ''}" data-col="${c.k}" ${c.w ? `style="width:${c.w}"` : ''}>${c.t}${active ? `<span class="sd">${activeSort.dir === 1 ? '↑' : '↓'}</span>` : ''}</th>`;
  }).join('');

  const rows = S.filtered.map(r => {
    const cat = CATS[r.category];
    const starred = S.shortlist.has(r.id);
    return `<tr data-id="${r.id}" class="${S.selected === r.id ? 'sel' : ''}">
      <td><div class="rank-badge ${r.rank <= 10 ? 'top' : ''}">${r.rank}</div></td>
      <td><div class="co-cell">
            <button class="star ${starred ? 'on' : ''}" data-star="${r.id}" title="Shortlist">${starred ? '★' : '☆'}</button>
            <div style="min-width:0">
              <div class="co-name" title="${esc(r.company)}">${vBadge(r)} ${esc(r.company)}</div>
              <div class="co-sub">${esc(r.address)}, ${esc(r.city)} ${esc(r.zip.slice(0, 5))}</div>
            </div></div></td>
      <td><span class="pill" style="background:${cat.color}1f;color:${cat.color}">
            <span class="dot" style="background:${cat.color}"></span>${esc(cat.label)}</span></td>
      <td class="r num"><b>${r.driveMiles.toFixed(1)} mi</b><br><span style="color:var(--text-3);font-size:11px">${Math.round(r.driveMinutes)} min</span></td>
      <td class="r num">${r.employees.toLocaleString()}</td>
      <td class="r num">${r.audience.toLocaleString()}</td>
      <td class="r num">${money(r.estMonthlyNet)}</td>
      <td class="r"><div class="score-cell">
            <span class="score-bar"><i style="width:${Math.min(100, r.score)}%"></i></span>
            <b class="num">${r.score.toFixed(1)}</b></div></td>
    </tr>`;
  }).join('');

  host.innerHTML = `<div class="view-bar">
      <h2>Ranked list</h2>
      <span class="sub">${S.filtered.length} site${S.filtered.length === 1 ? '' : 's'} · ${esc($('#sortSummary').textContent)}</span>
      <span class="spacer"></span>
      <button class="btn" id="expList">↓ Export this list (CSV)</button>
    </div>
    <div class="table-wrap"><table class="grid"><thead><tr>${thead}</tr></thead><tbody>${rows}</tbody></table></div>`;
  $('#expList').onclick = () => exportCSV(S.filtered, 'ranked-list');

  host.querySelectorAll('thead th').forEach(th => {
    th.onclick = () => {
      const k = th.dataset.col === 'rank' ? 'score' : th.dataset.col;
      const cur = S.sorts[0];
      if (cur && cur.k === k) cur.dir *= -1;
      else S.sorts = [{ k, dir: (SORT_FIELDS.find(f => f.k === k) || {}).dir || -1 }];
      saveSorts(); render();
    };
  });
  host.querySelectorAll('tbody tr').forEach(tr => {
    tr.onclick = e => {
      if (e.target.closest('[data-star]')) return;
      openDrawer(+tr.dataset.id);
    };
  });
  host.querySelectorAll('[data-star]').forEach(b => {
    b.onclick = e => { e.stopPropagation(); toggleStar(+b.dataset.star); };
  });
}

function emptyState() {
  return `<div class="empty"><div class="big">⌕</div>
    <div style="font-weight:600;color:var(--text-2);margin-bottom:4px">No sites match these filters</div>
    <div>Widen the distance bands, employee range or industry selection.</div></div>`;
}

/* ---------------------------------------------------------------- top picks */
function renderTop() {
  const host = $('#viewTop');
  const picks = S.filtered.slice(0, 12);
  if (!picks.length) { host.innerHTML = emptyState(); return; }

  const totalNet = S.filtered.slice(0, 10).reduce((a, r) => a + r.estMonthlyNet, 0);
  const stats = `<div class="stats">
    <div class="stat"><div class="k">Sites in scope</div><div class="v">${S.filtered.length}</div><div class="d">of ${S.rows.length} in the list</div></div>
    <div class="stat"><div class="k">Best single site</div><div class="v">${picks[0].score.toFixed(1)}<small> / 100</small></div><div class="d">${esc(picks[0].company.slice(0, 30))}</div></div>
    <div class="stat"><div class="k">Top-10 net potential</div><div class="v">${money(totalNet)}<small>/mo</small></div><div class="d">after servicing cost</div></div>
    <div class="stat"><div class="k">Median drive</div><div class="v">${median(S.filtered.map(r => r.driveMiles)).toFixed(1)}<small> mi</small></div><div class="d">across filtered sites</div></div>
    <div class="stat"><div class="k">Within 5 miles</div><div class="v">${S.filtered.filter(r => r.band === 0).length}</div><div class="d">one short service loop</div></div>
  </div>`;

  const cards = picks.map(r => {
    const cat = CATS[r.category];
    return `<div class="card" data-id="${r.id}">
      <div class="card-rank">#${r.rank}</div>
      <div style="display:flex;align-items:center;gap:7px;margin-top:4px">
        <span class="pill" style="background:${cat.color}1f;color:${cat.color}"><span class="dot" style="background:${cat.color}"></span>${esc(cat.label)}</span>
        <span class="pill" style="background:${bandVar(r.band)}1f;color:${bandVar(r.band)};margin-left:auto">${r.driveMiles.toFixed(1)} mi</span>
      </div>
      <h3>${vBadge(r)} ${esc(r.company)}</h3>
      <div class="addr">${esc(r.address)}, ${esc(r.city)} ${esc(r.zip.slice(0, 5))}</div>
      <div class="kv-grid">
        <div class="kv"><div class="k">Score</div><div class="v">${r.score.toFixed(1)}<small> /100</small></div></div>
        <div class="kv"><div class="k">Daily audience</div><div class="v">${r.audience.toLocaleString()}</div></div>
        <div class="kv"><div class="k">Drive time</div><div class="v">${Math.round(r.driveMinutes)}<small> min</small></div></div>
        <div class="kv"><div class="k">Est. net / mo</div><div class="v">${money(r.estMonthlyNet)}</div></div>
      </div>
      <div class="why">${whyText(r)}</div>
    </div>`;
  }).join('');

  host.innerHTML = `<div class="view-bar">
      <h2>Top picks</h2><span class="sub">best ${picks.length} under the current filters and weights</span>
      <span class="spacer"></span>
      <button class="btn" id="expTop">↓ Export top picks (CSV)</button>
    </div>` + stats + `<div class="cards">${cards}</div>`;
  $('#expTop').onclick = () => exportCSV(picks, 'top-picks');
  host.querySelectorAll('.card').forEach(c => c.onclick = () => openDrawer(+c.dataset.id));
}

function whyText(r) {
  const bits = [];
  const cat = CATS[r.category];
  if (r.driveMiles < 5) bits.push(`<b>${r.driveMiles.toFixed(1)} mi from home</b> — restocking is a short loop`);
  else if (r.driveMiles < 10) bits.push(`${r.driveMiles.toFixed(1)} mi out, ${Math.round(r.driveMinutes)} min each way`);
  else bits.push(`${r.driveMiles.toFixed(1)} mi out — only worth it at this audience size`);

  if (r.audience >= 500) bits.push(`roughly <b>${r.audience.toLocaleString()} people on site daily</b>`);
  else if (r.audience >= 150) bits.push(`about ${r.audience.toLocaleString()} people on site daily`);
  else bits.push(`a small site (~${r.audience.toLocaleString()} people)`);

  if (cat.fit >= 85) bits.push(`${cat.label.toLowerCase()} converts well for vending`);
  else if (cat.fit <= 55) bits.push(`${cat.label.toLowerCase()} is a weaker vending fit`);
  if (cat.alwaysOn) bits.push('runs 7 days a week');
  if (r.neighbors >= 12) bits.push(`<b>${r.neighbors} other listed sites within 1.5 mi</b> — strong route density`);
  return bits.join(' · ') + '.';
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };

/* --------------------------------------------------------------- shortlist */
function renderShortlist() {
  const host = $('#viewShort');
  const rows = S.rows.filter(r => S.shortlist.has(r.id));
  sortRows(rows);
  rows.forEach((r, i) => { r.rank = i + 1; });

  if (!rows.length) {
    host.innerHTML = `<div class="empty"><div class="big">☆</div>
      <div style="font-weight:600;color:var(--text-2);margin-bottom:4px">Your shortlist is empty</div>
      <div>Click the ☆ beside any company in the ranked list, or the shortlist button in its detail panel.<br>
      Your shortlist is saved in this browser and survives closing the app.</div>
      <button class="btn primary" id="goList">Go to the ranked list</button></div>`;
    const b = $('#goList'); if (b) b.onclick = () => { S.view = 'list'; render(); };
    return;
  }

  const totalAud = rows.reduce((a, r) => a + r.audience, 0);
  const totalNet = rows.reduce((a, r) => a + r.estMonthlyNet, 0);
  const loopMiles = rows.reduce((a, r) => a + r.driveMiles * 2, 0);
  const loopMin = rows.reduce((a, r) => a + r.driveMinutes * 2 + 15, 0);
  const flagged = rows.filter(r => r.vwarn > 0).length;

  const stats = `<div class="stats">
    <div class="stat"><div class="k">Shortlisted</div><div class="v">${rows.length}</div><div class="d">of ${S.rows.length} sites</div></div>
    <div class="stat"><div class="k">Combined audience</div><div class="v">${totalAud.toLocaleString()}</div><div class="d">people per day</div></div>
    <div class="stat"><div class="k">Combined net</div><div class="v">${money(totalNet)}<small>/mo</small></div><div class="d">if every one were placed</div></div>
    <div class="stat"><div class="k">Servicing all of them</div><div class="v">${Math.round(loopMiles)}<small> mi</small></div><div class="d">${Math.round(loopMin / 60)} h per round of visits</div></div>
    <div class="stat"><div class="k">With flags</div><div class="v">${flagged}</div><div class="d">worth checking before you call</div></div>
  </div>`;

  const body = rows.map(r => {
    const cat = CATS[r.category];
    const phone = (r.phone || '').replace(/^1-/, '');
    return `<tr data-id="${r.id}">
      <td><div class="rank-badge ${r.rank <= 10 ? 'top' : ''}">${r.rank}</div></td>
      <td><div class="co-cell">
            <button class="star on" data-star="${r.id}" title="Remove from shortlist">★</button>
            <div style="min-width:0">
              <div class="co-name" title="${esc(r.company)}">${vBadge(r)} ${esc(r.company)}</div>
              <div class="co-sub">${esc(r.address)}, ${esc(r.city)} ${esc(r.zip.slice(0, 5))}</div>
            </div></div></td>
      <td><span class="pill" style="background:${cat.color}1f;color:${cat.color}">
            <span class="dot" style="background:${cat.color}"></span>${esc(cat.label)}</span></td>
      <td class="r num"><b>${r.driveMiles.toFixed(1)} mi</b><br><span style="color:var(--text-3);font-size:11px">${Math.round(r.driveMinutes)} min</span></td>
      <td class="num">${esc(r.contactName || 'Human Resources')}<br><span style="color:var(--text-3);font-size:11px">${phone ? `<a href="tel:${esc(phone.replace(/[^0-9+]/g, ''))}">${esc(phone)}</a>` : '—'}</span></td>
      <td class="r num">${r.audience.toLocaleString()}</td>
      <td class="r num">${money(r.estMonthlyNet)}</td>
      <td class="r"><div class="score-cell">
            <span class="score-bar"><i style="width:${Math.min(100, r.score)}%"></i></span>
            <b class="num">${r.score.toFixed(1)}</b></div></td>
    </tr>`;
  }).join('');

  host.innerHTML = `<div class="view-bar">
      <h2>Shortlist</h2>
      <span class="sub">saved in this browser · sorted by ${esc($('#sortSummary').textContent)}</span>
      <span class="spacer"></span>
      <button class="btn" id="expShort">↓ Export call sheet (CSV)</button>
      <button class="btn ghost" id="clearShort">Clear shortlist</button>
    </div>` + stats + `
    <div class="table-wrap"><table class="grid"><thead><tr>
      <th style="width:46px">#</th><th>Company</th><th>Industry</th><th class="r">Drive</th>
      <th>HR contact</th><th class="r">Audience</th><th class="r">Est. net/mo</th><th class="r">Score</th>
    </tr></thead><tbody>${body}</tbody></table></div>`;

  $('#expShort').onclick = () => exportCSV(rows, 'shortlist-call-sheet');
  $('#clearShort').onclick = () => {
    if (!rows.length) return;
    S.shortlist = new Set(); LS.set('shortlist', []); toast('Shortlist cleared'); render();
  };
  host.querySelectorAll('tbody tr').forEach(tr => {
    tr.onclick = e => { if (e.target.closest('[data-star]')) return; openDrawer(+tr.dataset.id); };
  });
  host.querySelectorAll('[data-star]').forEach(b => {
    b.onclick = e => { e.stopPropagation(); toggleStar(+b.dataset.star); };
  });
}

/* ------------------------------------------------------------------ charts */
function renderCharts() {
  const host = $('#viewCharts');
  const F = S.filtered;
  if (!F.length) { host.innerHTML = emptyState(); return; }

  host.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="k">Filtered sites</div><div class="v">${F.length}</div><div class="d">${(F.length / S.rows.length * 100).toFixed(0)}% of the list</div></div>
      <div class="stat"><div class="k">Total employees</div><div class="v">${F.reduce((a, r) => a + r.employees, 0).toLocaleString()}</div><div class="d">as reported in the sheet</div></div>
      <div class="stat"><div class="k">Est. daily audience</div><div class="v">${F.reduce((a, r) => a + r.audience, 0).toLocaleString()}</div><div class="d">on-site staff + visitors</div></div>
      <div class="stat"><div class="k">Median drive time</div><div class="v">${median(F.map(r => r.driveMinutes)).toFixed(0)}<small> min</small></div><div class="d">one way from home</div></div>
      <div class="stat"><div class="k">Industries</div><div class="v">${new Set(F.map(r => r.category)).size}</div><div class="d">represented in scope</div></div>
      <div class="stat"><div class="k">Records with flags</div><div class="v">${F.filter(r => r.vwarn > 0).length}</div><div class="d">check before calling</div></div>
    </div>
    <div class="chart-grid">
      <div class="chart-card"><h3>Sites by distance band</h3><div class="sub">How the filtered list splits across your four service rings</div><div id="chBand"></div></div>
      <div class="chart-card"><h3>Drive time distribution</h3><div class="sub">Minutes from ${esc(HOME.label.split(',')[0])}, one way</div><div id="chTime"></div></div>
      <div class="chart-card wide"><h3>Sites by industry</h3><div class="sub">Bar length is the site count; the marker to the right is the average placement score for that industry</div><div id="chCat"></div></div>
      <div class="chart-card wide"><h3>Audience against placement score</h3><div class="sub">Each dot is one site. Up and to the right is a better prospect; colour and numeral give the distance band.</div><div id="chScatter"></div></div>
      <div class="chart-card wide"><h3>Top 15 by estimated monthly net</h3><div class="sub">Gross margin on projected sales, less the cost of driving there twice a month</div><div id="chNet"></div></div>
    </div>`;

  chartBands($('#chBand'), F);
  chartTime($('#chTime'), F);
  chartCats($('#chCat'), F);
  chartScatter($('#chScatter'), F);
  chartNet($('#chNet'), F);
}

function svg(w, h, maxW) {
  return `<svg viewBox="0 0 ${w} ${h}" role="img" preserveAspectRatio="xMidYMid meet" ` +
         `style="width:100%;height:auto${maxW ? ';max-width:' + maxW + 'px' : ''}">`;
}

function chartBands(host, F) {
  const W = 500, H = 210, L = 88, R = 54, T = 8, B = 28;
  const counts = BANDS.map((b, i) => ({ b, i, n: F.filter(r => r.band === i).length }));
  const max = Math.max(...counts.map(c => c.n), 1);
  const bh = (H - T - B) / counts.length;
  let s = svg(W, H);
  counts.forEach((c, i) => {
    const y = T + i * bh, w = (W - L - R) * c.n / max;
    s += `<text x="${L - 9}" y="${y + bh / 2 + 4}" text-anchor="end" class="ax">${c.b.label}</text>`;
    s += `<rect x="${L}" y="${y + 5}" width="${Math.max(w, 2)}" height="${bh - 12}" rx="4" fill="${bandVar(i)}"/>`;
    s += `<text x="${L + Math.max(w, 2) + 8}" y="${y + bh / 2 + 4}" class="val-lbl">${c.n} site${c.n === 1 ? '' : 's'}</text>`;
    s += `<text x="${L - 9}" y="${y + bh / 2 + 4}" text-anchor="end" class="ax" opacity="0"></text>`;
  });
  s += `<line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="axisline"/>`;
  s += `<text x="${L}" y="${H - 7}" class="ax">0</text><text x="${W - R}" y="${H - 7}" text-anchor="end" class="ax">${max}</text>`;
  host.innerHTML = s + '</svg>' +
    `<div class="legend-inline">${BANDS.map((b, i) => `<span><span class="swatch" style="background:${bandVar(i)};width:14px;height:14px;font-size:8px">${i + 1}</span>${b.label}</span>`).join('')}</div>`;
}

function chartTime(host, F) {
  const W = 500, H = 210, L = 38, R = 12, T = 12, B = 36;
  const bins = [0, 5, 10, 15, 20, 25, 30, 40, 50, 999];
  const data = [];
  for (let i = 0; i < bins.length - 1; i++) {
    const lo = bins[i], hi = bins[i + 1];
    data.push({ lo, hi, n: F.filter(r => r.driveMinutes >= lo && r.driveMinutes < hi).length });
  }
  const max = Math.max(...data.map(d => d.n), 1);
  const bw = (W - L - R) / data.length;
  let s = svg(W, H);
  for (let g = 0; g <= 4; g++) {
    const y = T + (H - T - B) * g / 4;
    s += `<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" class="gridline"/>`;
    s += `<text x="${L - 6}" y="${y + 3.5}" text-anchor="end" class="ax">${Math.round(max * (1 - g / 4))}</text>`;
  }
  data.forEach((d, i) => {
    const h = (H - T - B) * d.n / max;
    const x = L + i * bw;
    s += `<rect x="${x + 2}" y="${H - B - h}" width="${bw - 4}" height="${Math.max(h, 0)}" rx="4" fill="${bandVar(bandIdxForMin(d.lo))}"/>`;
    if (d.n) s += `<text x="${x + bw / 2}" y="${H - B - h - 5}" text-anchor="middle" class="val-lbl">${d.n}</text>`;
    if (i % 2 === 0 || i === data.length - 1) s += `<text x="${x + bw / 2}" y="${H - B + 14}" text-anchor="middle" class="ax">${d.hi > 900 ? d.lo + '+' : d.lo}</text>`;
  });
  s += `<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="axisline"/>`;
  s += `<text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle" class="ax">minutes from home, one way</text>`;
  host.innerHTML = s + '</svg>';
}
const bandIdxForMin = m => m < 10 ? 0 : m < 18 ? 1 : m < 27 ? 2 : 3;

function chartCats(host, F) {
  const groups = {};
  F.forEach(r => { (groups[r.category] = groups[r.category] || []).push(r); });
  const rows = Object.entries(groups)
    .map(([k, arr]) => ({ k, label: CATS[k].label, color: CATS[k].color, n: arr.length,
                          avg: arr.reduce((a, r) => a + r.score, 0) / arr.length }))
    .sort((a, b) => b.n - a.n);
  const W = 1040, L = 206, R = 148, T = 6, rowH = 23, H = T + rows.length * rowH + 28;
  const max = Math.max(...rows.map(r => r.n), 1);
  let s = svg(W, H);
  rows.forEach((r, i) => {
    const y = T + i * rowH, w = (W - L - R) * r.n / max;
    s += `<text x="${L - 9}" y="${y + rowH / 2 + 4}" text-anchor="end" class="ax-t">${esc(r.label)}</text>`;
    s += `<rect x="${L}" y="${y + 3.5}" width="${Math.max(w, 2)}" height="${rowH - 8}" rx="4" fill="var(--seq)" opacity="${0.42 + 0.58 * (r.n / max)}"/>`;
    s += `<text x="${L + Math.max(w, 2) + 7}" y="${y + rowH / 2 + 4}" class="val-lbl">${r.n}</text>`;
    // avg score marker, right-aligned track
    const tx = W - R + 26, tw = 72;
    s += `<rect x="${tx}" y="${y + rowH / 2 - 3}" width="${tw}" height="6" rx="3" fill="var(--surface-3)"/>`;
    s += `<rect x="${tx}" y="${y + rowH / 2 - 3}" width="${Math.max(2, tw * r.avg / 100)}" height="6" rx="3" fill="${r.color}"/>`;
    s += `<text x="${tx + tw + 7}" y="${y + rowH / 2 + 4}" class="val-lbl">${r.avg.toFixed(0)}</text>`;
  });
  s += `<line x1="${L}" y1="${T}" x2="${L}" y2="${T + rows.length * rowH}" class="axisline"/>`;
  s += `<text x="${L}" y="${H - 8}" class="ax">site count →</text>`;
  s += `<text x="${W - R + 26}" y="${H - 8}" class="ax">average placement score (0–100)</text>`;
  host.innerHTML = s + '</svg>';
}

function chartScatter(host, F) {
  const W = 1040, H = 380, L = 60, R = 20, T = 16, B = 46;
  const maxAud = Math.max(...F.map(r => r.audience), 10);
  const x = v => L + (W - L - R) * (Math.log10(Math.max(v, 10)) - 1) / (Math.log10(maxAud) - 1 || 1);
  const y = v => H - B - (H - T - B) * Math.min(v, 100) / 100;
  let s = svg(W, H);
  for (let g = 0; g <= 5; g++) {
    const gy = T + (H - T - B) * g / 5;
    s += `<line x1="${L}" y1="${gy}" x2="${W - R}" y2="${gy}" class="gridline"/>`;
    s += `<text x="${L - 7}" y="${gy + 3.5}" text-anchor="end" class="ax">${100 - g * 20}</text>`;
  }
  [10, 50, 100, 500, 1000, 3000].filter(v => v <= maxAud * 1.05).forEach(v => {
    s += `<line x1="${x(v)}" y1="${T}" x2="${x(v)}" y2="${H - B}" class="gridline"/>`;
    s += `<text x="${x(v)}" y="${H - B + 15}" text-anchor="middle" class="ax">${v.toLocaleString()}</text>`;
  });
  // dots, largest score last so the best sit on top
  [...F].sort((a, b) => a.score - b.score).forEach(r => {
    s += `<circle cx="${x(r.audience).toFixed(1)}" cy="${y(r.score).toFixed(1)}" r="5" fill="${bandVar(r.band)}" fill-opacity=".82" stroke="var(--surface)" stroke-width="1.6"><title>${esc(r.company)} — ${r.audience.toLocaleString()} audience, score ${r.score.toFixed(1)}, ${r.driveMiles.toFixed(1)} mi</title></circle>`;
  });
  // label the five best
  [...F].sort((a, b) => b.score - a.score).slice(0, 5).forEach(r => {
    const px = x(r.audience), py = y(r.score);
    const anchor = px > W - 200 ? 'end' : 'start';
    s += `<text x="${px + (anchor === 'end' ? -9 : 9)}" y="${py + 3.5}" text-anchor="${anchor}" class="val-lbl" style="font-weight:600">${esc(r.company.length > 26 ? r.company.slice(0, 25) + '…' : r.company)}</text>`;
  });
  s += `<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="axisline"/>`;
  s += `<line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="axisline"/>`;
  s += `<text x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle" class="ax">estimated daily on-site audience (log scale)</text>`;
  s += `<text transform="translate(15,${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" class="ax">placement score</text>`;
  host.innerHTML = s + '</svg>' +
    `<div class="legend-inline">${BANDS.map((b, i) => `<span><span class="dot" style="background:${bandVar(i)};width:10px;height:10px;border-radius:50%"></span>${b.label}</span>`).join('')}</div>`;
}

function chartNet(host, F) {
  const rows = [...F].sort((a, b) => b.estMonthlyNet - a.estMonthlyNet).slice(0, 15);
  const W = 1040, L = 262, R = 112, T = 6, rowH = 26, H = T + rows.length * rowH + 24;
  const max = Math.max(...rows.map(r => r.estMonthlyNet), 1);
  let s = svg(W, H);
  rows.forEach((r, i) => {
    const y = T + i * rowH, w = (W - L - R) * Math.max(r.estMonthlyNet, 0) / max;
    const nm = r.company.length > 32 ? r.company.slice(0, 31) + '…' : r.company;
    s += `<text x="${L - 9}" y="${y + rowH / 2 + 4}" text-anchor="end" class="ax-t">${esc(nm)}</text>`;
    s += `<rect x="${L}" y="${y + 4}" width="${Math.max(w, 2)}" height="${rowH - 10}" rx="4" fill="${bandVar(r.band)}"/>`;
    s += `<text x="${L + Math.max(w, 2) + 8}" y="${y + rowH / 2 + 4}" class="val-lbl">${money(r.estMonthlyNet)}<tspan class="ax"> · ${r.driveMiles.toFixed(1)} mi</tspan></text>`;
  });
  s += `<line x1="${L}" y1="${T}" x2="${L}" y2="${T + rows.length * rowH}" class="axisline"/>`;
  s += `<text x="${L}" y="${H - 6}" class="ax">estimated monthly net contribution per machine →</text>`;
  host.innerHTML = s + '</svg>' +
    `<div class="legend-inline">${BANDS.map((b, i) => `<span><span class="dot" style="background:${bandVar(i)}"></span>${b.label}</span>`).join('')}</div>`;
}

/* ------------------------------------------------------------------ drawer */
function openDrawer(id) {
  const r = S.rows.find(x => x.id === id);
  if (!r) return;
  S.selected = id;
  const cat = CATS[r.category];
  const starred = S.shortlist.has(id);
  const totalW = WEIGHT_DEFS.reduce((a, d) => a + S.weights[d.k], 0) || 1;

  $('#drawerHead').innerHTML = `
    <button class="btn ghost icon drawer-close" id="drawerClose">✕</button>
    <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:7px">
      <span class="pill" style="background:${cat.color}1f;color:${cat.color}"><span class="dot" style="background:${cat.color}"></span>${esc(cat.label)}</span>
      <span class="pill" style="background:${bandVar(r.band)}1f;color:${bandVar(r.band)}">${BANDS[r.band].label}</span>
    </div>
    <h2 style="margin:0 34px 3px 0;font-size:17px;font-weight:650;letter-spacing:-.3px">${esc(r.company)}</h2>
    <div style="margin:2px 0 0">${vBadge(r, true)}</div>
    <div style="font-size:12px;color:var(--text-3)">${esc(r.address)}, ${esc(r.city)}, ${esc(r.state)} ${esc(r.zip)}</div>
    <div style="display:flex;align-items:baseline;gap:9px;margin-top:11px">
      <div style="font-size:29px;font-weight:660;letter-spacing:-1px;line-height:1" class="num">${r.score.toFixed(1)}</div>
      <div style="font-size:12px;color:var(--text-3)">placement score · rank #${r.globalRank} of ${S.rows.length}</div>
    </div>`;

  const bars = WEIGHT_DEFS.map(d => {
    const raw = r[d.src] || 0;
    const pct = Math.round(S.weights[d.k] / totalW * 100);
    return `<div class="sbar-row">
      <span style="color:var(--text-2)">${d.label} <span style="color:var(--text-3);font-size:10.5px">${pct}%</span></span>
      <span class="sbar"><i style="width:${Math.min(100, raw)}%;background:${d.color}"></i></span>
      <span class="n">${raw.toFixed(0)}</span></div>`;
  }).join('');

  const stack = (() => {
    const W = 340, H = 34;
    let x = 0, out = svg(W, H);
    WEIGHT_DEFS.forEach(d => {
      const w = (r.parts[d.k] || 0) / 100 * W;
      if (w > 0.5) {
        out += `<rect x="${x + 1}" y="6" width="${Math.max(w - 2, 1)}" height="17" rx="3" fill="${d.color}"><title>${d.label}: ${(r.parts[d.k]).toFixed(1)} pts</title></rect>`;
        if (w > 30) out += `<text x="${x + w / 2}" y="18.5" text-anchor="middle" style="font-size:9.5px;fill:#fff;font-weight:700">${r.parts[d.k].toFixed(0)}</text>`;
      }
      x += w;
    });
    out += `<rect x="0" y="6" width="${W}" height="17" rx="3" fill="none" stroke="var(--border)"/>`;
    out += `<text x="0" y="32" class="ax">0</text><text x="${W}" y="32" text-anchor="end" class="ax">100</text>`;
    return out + '</svg>';
  })();

  const phone = (r.phone || '').replace(/^1-/, '');
  const site = r.website ? (r.website.startsWith('http') ? r.website : 'http://' + r.website) : '';
  const gmaps = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(HOME.label)}&destination=${encodeURIComponent(r.address + ', ' + r.city + ', ' + r.state + ' ' + r.zip)}`;

  $('#drawerBody').innerHTML = `
    <div class="sec">
      <h4>Score composition</h4>
      ${stack}
      <div style="margin-top:11px">${bars}</div>
      <div style="font-size:11px;color:var(--text-3);margin-top:8px;line-height:1.45">Bars show each raw sub-score out of 100. The stacked bar above shows what each one contributes at your current weights.</div>
    </div>

    <div class="sec">
      <h4>Record confidence</h4>
      <div style="font-size:11.5px;color:var(--text-3);margin-bottom:8px;line-height:1.45">
        ${esc((TIERS[r.vtier] || {}).note || '')}
      </div>
      ${((r.verify && r.verify.flags) || []).map(f => `
        <div class="flag-row">
          <span class="flag-ico ${f.sev}">${f.sev === 'good' ? '\u2713' : f.sev === 'warn' ? '!' : '\u00b7'}</span>
          <span class="flag-txt"><b>${esc(f.text)}</b>${f.detail ? `<span class="flag-det">${esc(f.detail)}</span>` : ''}</span>
        </div>`).join('') || '<div style="color:var(--text-3);font-size:12px">No checks recorded.</div>'}
      <div class="drawer-actions" style="margin-top:10px">
        <a class="btn" href="https://www.google.com/search?q=${encodeURIComponent('"' + r.company + '" ' + r.address + ' ' + r.city + ' CO')}" target="_blank" rel="noopener">Search the web \u2197</a>
        <a class="btn" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.address + ', ' + r.city + ', ' + r.state + ' ' + r.zip)}" target="_blank" rel="noopener">See the building \u2197</a>
      </div>
    </div>

    <div class="sec">
      <h4>Trip &amp; location</h4>
      <div class="data-row"><span class="k">Driving distance</span><span class="v">${r.driveMiles.toFixed(2)} mi</span></div>
      <div class="data-row"><span class="k">Driving time</span><span class="v">${r.driveMinutes.toFixed(0)} min each way</span></div>
      <div class="data-row"><span class="k">Straight-line</span><span class="v">${r.straightMiles.toFixed(2)} mi</span></div>
      <div class="data-row"><span class="k">Round trip per restock</span><span class="v">${(r.driveMiles * 2).toFixed(1)} mi · ${(r.driveMinutes * 2).toFixed(0)} min</span></div>
      <div class="data-row"><span class="k">Other listed sites ≤ 1.5 mi</span><span class="v">${r.neighbors}${r.neighbors ? ` (${r.neighborEmployees.toLocaleString()} staff)` : ''}</span></div>
      <div class="data-row"><span class="k">Coordinates</span><span class="v mono" style="font-size:11px">${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}</span></div>
      <div class="data-row"><span class="k">Geocode quality</span><span class="v">${geoQualityLabel(r.geoQuality)}</span></div>
    </div>

    <div class="sec">
      <h4>Site &amp; audience</h4>
      <div class="data-row"><span class="k">Employees (reported)</span><span class="v">${r.employees.toLocaleString()}</span></div>
      <div class="data-row"><span class="k">Estimated on site</span><span class="v">${r.onsiteEstimate.toLocaleString()} <span style="color:var(--text-3);font-weight:400">(${Math.round(cat.onsite * 100)}%)</span></span></div>
      <div class="data-row"><span class="k">Visitors / customers</span><span class="v">≈ ${Math.round(r.onsiteEstimate * cat.visitors).toLocaleString()} per day</span></div>
      <div class="data-row"><span class="k">Total daily audience</span><span class="v"><b>${r.audience.toLocaleString()}</b></span></div>
      <div class="data-row"><span class="k">Operating pattern</span><span class="v">${cat.alwaysOn ? '7 days / multi-shift' : 'Weekdays, single shift'}</span></div>
      <div class="data-row"><span class="k">Industry (NAICS)</span><span class="v">${esc(r.description)}</span></div>
      <div class="data-row"><span class="k">Classified via</span><span class="v">${esc(r.categoryVia)}</span></div>
    </div>

    <div class="sec">
      <h4>Projected unit economics</h4>
      <div class="data-row"><span class="k">Vends per day</span><span class="v">≈ ${r.estDailyVends.toFixed(0)}</span></div>
      <div class="data-row"><span class="k">Service days / month</span><span class="v">${cat.alwaysOn ? 30 : 21}</span></div>
      <div class="data-row"><span class="k">Gross sales</span><span class="v">${money(r.estMonthlyRevenue)} / mo</span></div>
      <div class="data-row"><span class="k">Product margin (52%)</span><span class="v">${money(r.estMonthlyGross)} / mo</span></div>
      <div class="data-row"><span class="k">Servicing cost (2 trips)</span><span class="v" style="color:var(--warn)">− ${money(r.estServiceCost)} / mo</span></div>
      <div class="data-row"><span class="k">Net contribution</span><span class="v" style="color:${r.estMonthlyNet > 0 ? 'var(--good)' : 'var(--band-3)'};font-weight:700">${money(r.estMonthlyNet)} / mo</span></div>
      <div style="font-size:11px;color:var(--text-3);margin-top:8px;line-height:1.45">Modelled at $${DATA.meta.avgVendPrice.toFixed(2)} average vend and a ${DATA.meta.grossMarginPct}% product margin. Servicing assumes two restock trips a month at $0.70/mi plus $28/hr for drive time and 15 minutes on site. Treat these as a ranking signal, not a quote.</div>
    </div>

    <div class="sec">
      <h4>HR contact</h4>
      <div class="contact-card">
        <div style="font-weight:650;margin-bottom:2px">${esc(r.contactName || 'Human Resources')}</div>
        <div style="font-size:11.5px;color:var(--text-3);margin-bottom:9px">${esc(r.company)}</div>
        <div class="data-row"><span class="k">Phone</span><span class="v">${phone ? `<a href="tel:${esc(phone.replace(/[^0-9+]/g, ''))}">${esc(phone)}</a>` : '—'}</span></div>
        <div class="data-row"><span class="k">Website</span><span class="v">${site ? `<a href="${esc(site)}" target="_blank" rel="noopener">${esc(site.replace(/^https?:\/\//, '').slice(0, 34))}</a>` : '—'}</span></div>
      </div>
      <div class="drawer-actions">
        <button class="btn" id="dStar">${starred ? '★ On shortlist' : '☆ Add to shortlist'}</button>
        <a class="btn" href="${gmaps}" target="_blank" rel="noopener">Directions ↗</a>
        <button class="btn" id="dCopy">Copy details</button>
      </div>
    </div>`;

  $('#drawer').classList.add('open');
  $('#drawerClose').onclick = closeDrawer;
  $('#dStar').onclick = () => { toggleStar(id); openDrawer(id); };
  $('#dCopy').onclick = () => {
    const txt = [r.company, r.address + ', ' + r.city + ', ' + r.state + ' ' + r.zip,
      'HR: ' + r.contactName + '  ' + phone, r.website,
      `${r.employees} employees · ~${r.audience} daily audience · ${cat.label}`,
      `${r.driveMiles.toFixed(1)} mi / ${Math.round(r.driveMinutes)} min from home`,
      `Placement score ${r.score.toFixed(1)}/100 · est. net ${money(r.estMonthlyNet)}/mo`].filter(Boolean).join('\n');
    navigator.clipboard.writeText(txt).then(() => toast('Copied to clipboard'), () => toast('Copy failed'));
  };

  // Only recentre when the pin is off screen, so clicking through pins is calm.
  if (S.view === 'map' && map && markerIndex[id]) {
    if (!map.getBounds().pad(-0.12).contains([r.lat, r.lon]))
      map.panTo([r.lat, r.lon], { animate: true });
    renderMap();
  }
  if (S.view === 'list') renderTable();
  if (S.view === 'shortlist') renderShortlist();
}
function closeDrawer() { $('#drawer').classList.remove('open'); S.selected = null; }
window.__openDrawer = openDrawer;

const geoQualityLabel = q => ({
  'Exact': 'Exact rooftop match (Census)',
  'Non_Exact': 'Nearest address range (Census)',
  'Retry': 'Matched on retry (Census)',
  'OSM': 'OpenStreetMap match',
  'OSM-approx': 'OpenStreetMap, approximate',
  'ZIP-approx': 'ZIP-code centroid — approximate'
}[q] || q);

function toggleStar(id) {
  S.shortlist.has(id) ? S.shortlist.delete(id) : S.shortlist.add(id);
  LS.set('shortlist', [...S.shortlist]);
  toast(S.shortlist.has(id) ? 'Added to shortlist' : 'Removed from shortlist');
  render();
}

/* ------------------------------------------------------------------ method */
function renderMethod() {
  const host = $('#viewMethod');
  if (host.dataset.done) return;
  host.dataset.done = '1';

  const box = (x, y, w, h, t, s, hi) => `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" class="dg-box${hi ? ' hi' : ''}"/>
    <text x="${x + w / 2}" y="${y + (s ? h / 2 - 3 : h / 2 + 4)}" text-anchor="middle" class="dg-t">${t}</text>
    ${s ? `<text x="${x + w / 2}" y="${y + h / 2 + 13}" text-anchor="middle" class="dg-s">${s}</text>` : ''}`;
  const arrow = (x1, y, x2) => `<path d="M${x1} ${y} H${x2 - 7}" class="dg-arrow" marker-end="url(#ah)"/>`;

  const pipeline = `${svg(940, 132)}
    <defs><marker id="ah" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--text-3)"/></marker></defs>
    ${box(0, 34, 140, 62, 'Excel sheet', '365 companies')}
    ${arrow(140, 65, 172)}
    ${box(172, 34, 148, 62, 'Geocode', 'Census + OSM')}
    ${arrow(320, 65, 352)}
    ${box(352, 34, 148, 62, 'Route', 'OSRM driving')}
    ${arrow(500, 65, 532)}
    ${box(532, 34, 156, 62, 'Classify', 'NAICS → venue type')}
    ${arrow(688, 65, 720)}
    ${box(720, 34, 220, 62, 'Score &amp; rank', 'weighted, 0–100', true)}
    <text x="0" y="18" class="dg-s">INPUT</text>
    <text x="720" y="18" class="dg-s">OUTPUT — what you sort and map</text>
    </svg>`;

  const w = 168, gap = 14;
  const scoreDiag = `${svg(940, 232)}
    <defs><marker id="ah2" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="var(--text-3)"/></marker></defs>
    ${WEIGHT_DEFS.map((d, i) => {
      const x = i * (w + gap);
      return `<rect x="${x}" y="0" width="${w}" height="66" rx="9" fill="${d.color}" fill-opacity=".13" stroke="${d.color}" stroke-width="1.3"/>
        <text x="${x + w / 2}" y="26" text-anchor="middle" class="dg-t" fill="${d.color}">${d.label}</text>
        <text x="${x + w / 2}" y="43" text-anchor="middle" class="dg-s">${d.hint}</text>
        <text x="${x + w / 2}" y="57" text-anchor="middle" class="dg-s" style="font-weight:700">0 – 100</text>
        <path d="M${x + w / 2} 66 V 104" class="dg-arrow" marker-end="url(#ah2)"/>`;
    }).join('')}
    <rect x="0" y="110" width="${5 * w + 4 * gap}" height="52" rx="9" class="dg-box hi"/>
    <text x="${(5 * w + 4 * gap) / 2}" y="132" text-anchor="middle" class="dg-t">Weighted mean · weights normalised to 100%</text>
    <text x="${(5 * w + 4 * gap) / 2}" y="149" text-anchor="middle" class="dg-s">move the sliders in the sidebar and every ranking, map marker and chart updates</text>
    <path d="M${(5 * w + 4 * gap) / 2} 162 V 186" class="dg-arrow" marker-end="url(#ah2)"/>
    <rect x="${(5 * w + 4 * gap) / 2 - 110}" y="192" width="220" height="38" rx="9" class="dg-box"/>
    <text x="${(5 * w + 4 * gap) / 2}" y="216" text-anchor="middle" class="dg-t">Placement score, 0 – 100</text>
    </svg>`;

  const R = 96;
  const ringDiag = `${svg(560, 232, 640)}
    ${[[3, R], [2, R * .74], [1, R * .5], [0, R * .26]].map(([b, r]) =>
      `<circle cx="112" cy="116" r="${r}" fill="${bandVar(b)}" fill-opacity=".12" stroke="${bandVar(b)}" stroke-width="1.4" stroke-dasharray="4 4"/>`).join('')}
    <circle cx="112" cy="116" r="7" fill="var(--accent)"/>
    <text x="112" y="120" text-anchor="middle" style="font-size:9px;fill:#fff;font-weight:700">★</text>
    ${BANDS.map((b, i) => `
      <rect x="248" y="${28 + i * 42}" width="22" height="22" rx="6" fill="${bandVar(i)}"/>
      <text x="259" y="${43 + i * 42}" text-anchor="middle" style="font-size:11px;fill:#fff;font-weight:700">${i + 1}</text>
      <text x="282" y="${39 + i * 42}" class="dg-t">${b.label}</text>
      <text x="282" y="${54 + i * 42}" class="dg-s">${S.rows.filter(r => r.band === i).length} sites · ${['same-day top-up is trivial', 'comfortable weekly loop', 'batch with neighbours', 'needs volume to justify'][i]}</text>`).join('')}
    </svg>`;

  host.innerHTML = `<div class="prose">
    <h2>How this tool builds its numbers</h2>
    <p>Every figure in the app traces back to your spreadsheet plus three public data services. Nothing is invented, and where a value is an estimate it is labelled as one.</p>
    <div class="diagram">${pipeline}</div>

    <h2>1 · Geocoding — ${DATA.meta.recordCount} addresses to coordinates</h2>
    <p>Each street address goes to the <b>US Census Bureau geocoder</b>, which returns rooftop or address-range coordinates from the TIGER road network. Addresses the Census cannot match — new subdivisions, campus buildings, named facilities — fall back to <b>OpenStreetMap Nominatim</b>. Every site records which method matched it, shown as <i>Geocode quality</i> in the detail panel, so you can tell an exact rooftop from a ZIP-centroid approximation before you drive out there.</p>

    <h2>2 · Distance — real roads, not straight lines</h2>
    <p>Straight-line distance understates a real trip by 20–30% in Colorado Springs, where I-25, the Powers corridor and the foothills all bend routes. Distances here come from <b>OSRM</b> routed on the actual road graph, so you get driving miles <i>and</i> drive time. The straight-line figure is kept alongside it for reference.</p>
    <div class="diagram">${ringDiag}</div>

    <h2>3 · Are these companies real?</h2>
    <p>Every record carries a <b>confidence tier</b> built from two independent kinds of evidence, and you can filter on it in the sidebar. It answers "does this record hold together", not "is this business solvent" — no public source can tell you the latter, and this tool does not pretend to.</p>
    <p><b>External evidence.</b> Every address was matched against an OpenStreetMap extract of El Paso and Teller counties — ${(DATA.meta.osmPlaces || '9,486')} named places. Where a business of the same name sits at the same point, the record is marked <b>Verified</b>. Where the address exists but under a different business name, that is recorded too: it usually means a tenant changed. <b>A missing OpenStreetMap record proves nothing</b> — most ordinary offices are simply not mapped — so it never raises a warning on its own.</p>
    <p><b>Internal evidence.</b> Seven deterministic checks run over the spreadsheet itself: whether the geocode was an exact rooftop or an approximation, whether the address has a street number at all, whether the phone number is shared with another record, whether its area code is outside Colorado, whether other listed companies occupy the same building, whether the company appears more than once, and whether the website domain resembles the company name.</p>
    <p>Two of those matter more than the rest for your purposes. An <b>out-of-Colorado area code</b> means the number in the sheet rings a corporate switchboard somewhere else — the "HR Director" you reach will not be the person who decides what goes in that break room. A <b>shared building address</b> means the headcount may belong to the whole tower rather than to that tenant, so treat the audience figure as an upper bound.</p>
    <p>The result across the current list: <b>59 verified</b>, <b>268 consistent</b>, <b>38 with one flag</b>, none with two or more. The full flag list for any site is in its detail panel, alongside buttons that open a web search and a street view of the building so you can settle it in ten seconds.</p>

    <h2>4 · Industry classification</h2>
    <p>Each company is placed into one of ${Object.values(CATS).filter(c => c.count).length} venue types using its NAICS industry code, its business description and its name, in that order of specificity. Venue type drives three things: how well vending converts there, how captive the audience is, and — importantly — what share of the reported headcount is actually at that address.</p>

    <h2>5 · The headcount correction</h2>
    <p>This is the single biggest trap in a list like this. A janitorial firm with 650 employees has almost nobody at its office — the staff are spread across client buildings. A hospital with 650 employees has most of them under one roof, plus patients and visitors on top. Each venue type therefore carries an <b>on-site share</b> and a <b>visitor multiplier</b>, and the audience figure you sort and map on is the corrected number, not the raw one. Construction and field-service firms drop sharply; hospitals, hotels and campuses rise.</p>

    <h2>6 · The placement score</h2>
    <p>Five sub-scores, each on a 0–100 scale, combined as a weighted mean. The weights are yours to set — the sliders in the sidebar recompute every ranking, marker and chart live.</p>
    <div class="diagram">${scoreDiag}</div>

    <h2>7 · Projected economics</h2>
    <p>Revenue is modelled as <code>daily audience × capture rate × $${DATA.meta.avgVendPrice.toFixed(2)} × operating days</code>, where the capture rate runs from 5% at a poor-fit venue to 20% at a strong one, and operating days are 30 for a 7-day site or 21 for weekday-only. Product margin is ${DATA.meta.grossMarginPct}%. Against that sits a servicing cost of two restock trips a month at $0.70 a mile plus $28 an hour of drive time. These numbers rank sites against each other honestly; they are not a business plan, and real placement depends on the contract you negotiate and what else is already in the building.</p>

    <h2>What the tool cannot tell you</h2>
    <p>Employee counts are as supplied in your sheet and may be company-wide rather than site-specific. Nothing here knows whether a building already has vending, whether there is a cafeteria next door, or whether the landlord allows machines. Use the ranking to decide who to call first — the HR contact for each site is one click away in the detail panel — and let the calls settle the rest.</p>
  </div>`;
}

/* ------------------------------------------------------------------ export */
/* --------------------------------------------------------------- home base
   The home address is not baked in. Anyone opening this file can set their
   own; it is stored per browser, along with the routed distances, so it is
   only computed once. Everything distance-derived is recomputed from it.   */

function recomputeFromHome(routes) {
  for (const r of S.rows) {
    const rt = routes[r.id];
    if (!rt) continue;
    const c = CATS[r.category];
    r.driveMiles = +rt[0].toFixed(2);
    r.driveMinutes = +rt[1].toFixed(1);
    r.straightMiles = +haversine(HOME.lat, HOME.lon, r.lat, r.lon).toFixed(2);
    r.band = bandOf(r.driveMiles);
    r.sProximity = +(100 * Math.exp(-r.driveMiles / 11)).toFixed(1);
    r.estServiceCost = Math.round(2 * (r.driveMiles * 2 * 0.7 + ((r.driveMinutes * 2 + 15) / 60) * 28));
    r.estMonthlyNet = Math.round(r.estMonthlyGross - r.estServiceCost);
  }
  // route density is home-independent, so it is left alone
  const driveMax = Math.ceil(Math.max(...S.rows.map(r => r.driveMinutes)) / 5) * 5;
  const md = $('#maxDrive');
  md.max = driveMax;
  if (S.maxDrive > driveMax || S.maxDrive === +md.dataset.prevMax) { S.maxDrive = driveMax; md.value = driveMax; }
  md.dataset.prevMax = driveMax;
}

async function routeAllFrom(lat, lon, onProgress) {
  const ids = S.rows.map(r => r.id);
  const routes = {};
  for (let s0 = 0; s0 < ids.length; s0 += 80) {
    const chunk = S.rows.slice(s0, s0 + 80);
    const coords = [lon + ',' + lat]
      .concat(chunk.map(r => r.lon.toFixed(6) + ',' + r.lat.toFixed(6))).join(';');
    try {
      const j = await (await fetch('https://router.project-osrm.org/table/v1/driving/' + coords +
        '?sources=0&annotations=distance,duration')).json();
      if (j.code === 'Ok') {
        chunk.forEach((r, k) => {
          const d = j.distances[0][k + 1], t = j.durations[0][k + 1];
          if (d != null) routes[r.id] = [d / 1609.344, t / 60];
        });
      }
    } catch (e) { /* falls through to the straight-line estimate below */ }
    if (onProgress) onProgress(Math.min(s0 + 80, ids.length), ids.length);
    await sleep(350);
  }
  let approx = 0;
  for (const r of S.rows) {
    if (!routes[r.id]) {
      const mi = haversine(lat, lon, r.lat, r.lon) * 1.28;
      routes[r.id] = [mi, mi * 2.2]; approx++;
    }
  }
  return { routes, approx };
}

function applyHome(home, routes, quiet) {
  HOME = home;
  recomputeFromHome(routes);
  $('#homeLabel').textContent = home.label;
  mapFitted = false;
  if (map && homeMarker) {
    homeMarker.setLatLng([home.lat, home.lon]);
    homeMarker.setPopupContent('<div class="pop-t">Home base</div><div style="color:var(--text-2)">' + esc(home.label) + '</div>');
    drawRings();
  }
  render();
  if (!quiet) toast('Home base set — everything re-measured');
}

function homeLog(t) { const l = $('#homeLog'); l.textContent += t + '\n'; l.scrollTop = l.scrollHeight; }

let homeBusy = false;
async function setHomeFromInput() {
  if (homeBusy) return;
  const addr = $('#homeInput').value.trim();
  if (addr.length < 6) { $('#homeStatus').textContent = 'Enter a full street address, city and state.'; return; }
  homeBusy = true;
  $('#homeGo').disabled = true; $('#homeClose').disabled = true; $('#homeReset').disabled = true;
  $('#homeLog').textContent = '';
  $('#homeProg').style.width = '4%';
  $('#homeStatus').textContent = 'Locating the address…';
  homeLog('Geocoding "' + addr + '" …');

  let hit = await censusJSONP(addr);
  if (hit) homeLog('✓ US Census matched it.');
  else {
    homeLog('  Census had no match — trying OpenStreetMap…');
    hit = await osmGeocode(addr);
    if (hit) homeLog('✓ OpenStreetMap matched it.');
  }
  if (!hit) {
    homeLog('✗ Could not find that address. Check the spelling, and include the city and state.');
    $('#homeStatus').textContent = 'Address not found.';
    $('#homeProg').style.width = '0';
    homeBusy = false; $('#homeGo').disabled = false; $('#homeClose').disabled = false; $('#homeReset').disabled = false;
    return;
  }
  homeLog('  ' + hit.lat.toFixed(5) + ', ' + hit.lon.toFixed(5));
  homeLog('\nRe-routing all ' + S.rows.length + ' sites from the new address…');

  const { routes, approx } = await routeAllFrom(hit.lat, hit.lon, (done, tot) => {
    $('#homeProg').style.width = (10 + done / tot * 88) + '%';
    $('#homeStatus').textContent = 'Routing ' + done + ' / ' + tot + ' sites…';
  });
  if (approx === S.rows.length) {
    homeLog('⚠ The routing service could not be reached, so every distance is a');
    homeLog('  straight-line estimate with a road factor applied — usually within');
    homeLog('  10–15% of the real drive. Check your connection and set the address');
    homeLog('  again for exact road distances.');
  } else if (approx) {
    homeLog('⚠ ' + approx + ' site(s) fell back to a straight-line estimate.');
  }

  const home = { lat: hit.lat, lon: hit.lon, label: addr };
  LS.set('home', home);
  LS.set('homeRoutes', routes);
  applyHome(home, routes);
  $('#homeProg').style.width = '100%';
  $('#homeStatus').textContent = 'Done — every distance now measured from here.';
  homeLog('✓ Home base set. Closing this dialog returns you to the map.');
  homeBusy = false; $('#homeGo').disabled = false; $('#homeClose').disabled = false; $('#homeReset').disabled = false;
}

function resetHome() {
  if (homeBusy) return;
  LS.set('home', null); LS.set('homeRoutes', null);
  const routes = {};
  DATA.companies.forEach(c => { routes[c.id] = [c.driveMiles, c.driveMinutes]; });
  applyHome({ ...DEFAULT_HOME }, routes);
  $('#homeInput').value = DEFAULT_HOME.label;
  $('#homeLog').textContent = 'Reset to ' + DEFAULT_HOME.label + '\n';
  $('#homeStatus').textContent = 'Back to the original home base.';
  $('#homeProg').style.width = '0';
}

function restoreHome() {
  const home = LS.get('home', null), routes = LS.get('homeRoutes', null);
  if (!home || !routes) return;
  if (!S.rows.every(r => routes[r.id])) return;   // dataset changed — ignore stale routes
  applyHome(home, routes, true);
}

const CSV_COLS = [
  ['rank', 'Rank'], ['company', 'Company'], ['address', 'Address'], ['city', 'City'], ['state', 'State'],
  ['zip', 'ZIP'], ['contactName', 'HR contact'], ['phone', 'Phone'], ['website', 'Website'],
  ['categoryLabel', 'Industry'], ['description', 'NAICS description'], ['employees', 'Employees'],
  ['onsiteEstimate', 'Est. on-site'], ['audience', 'Daily audience'],
  ['driveMiles', 'Drive miles'], ['driveMinutes', 'Drive minutes'], ['straightMiles', 'Straight-line miles'],
  ['lat', 'Latitude'], ['lon', 'Longitude'], ['geoQuality', 'Geocode quality'],
  ['vlabel', 'Record confidence'], ['vwarn', 'Record warnings'], ['vflags', 'Flags to check'],
  ['sTraffic', 'Audience score'], ['sProximity', 'Proximity score'], ['sFit', 'Fit score'],
  ['sDwell', 'Dwell score'], ['sCluster', 'Route density score'], ['score', 'Placement score'],
  ['estDailyVends', 'Est. daily vends'], ['estMonthlyRevenue', 'Est. monthly revenue'],
  ['estMonthlyGross', 'Est. monthly gross'], ['estServiceCost', 'Est. service cost'],
  ['estMonthlyNet', 'Est. monthly net'], ['neighbors', 'Sites within 1.5mi']
];

// One exporter for every view. `rows` is whatever that view is showing.
function exportCSV(rows, label) {
  rows = rows || S.filtered;
  if (!rows.length) { toast('Nothing to export'); return; }
  const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const val = (r, k) => {
    if (k === 'vlabel') return vTier(r).label;
    if (k === 'vflags') return ((r.verify && r.verify.flags) || [])
      .filter(f => f.sev === 'warn').map(f => f.text + (f.detail ? ' (' + f.detail + ')' : '')).join(' · ');
    const v = r[k];
    return typeof v === 'number' ? +v.toFixed(2) : v;
  };
  const meta = [
    '# Zenith & Sky vending siting — ' + (label || 'export'),
    '# Home base: ' + HOME.label,
    '# Exported: ' + new Date().toLocaleString() + '  ·  ' + rows.length + ' sites',
    '# Weights: ' + WEIGHT_DEFS.map(d => d.label + ' ' + S.weights[d.k]).join(', ')
  ].join('\n');
  const csv = meta + '\n' + [CSV_COLS.map(c => c[1]).join(',')]
    .concat(rows.map(r => CSV_COLS.map(c => q(val(r, c[0]))).join(','))).join('\n');
  download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }),
    (label || 'vending-sites') + '-' + new Date().toISOString().slice(0, 10) + '.csv');
  toast('Exported ' + rows.length + ' site' + (rows.length === 1 ? '' : 's'));
}
function exportJSON() {
  const out = { ...DATA, companies: S.rows.map(({ parts, categoryLabel, rank, globalRank, score, ...rest }) => rest) };
  download(new Blob([JSON.stringify(out)], { type: 'application/json' }), 'companies.json');
  toast('Dataset exported — drop it into data/companies.json');
}
function download(blob, name) {
  const u = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = u; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 400);
}

/* ------------------------------------------------------------------ import
   Reads a new spreadsheet, geocodes it through the Census JSONP endpoint
   (works from file:// — no CORS), falls back to OpenStreetMap, then routes
   every site with OSRM. Progress is reported line by line.                  */
const IMP = { rows: [], geo: {}, busy: false };

function openImport() { $('#importModal').style.display = 'grid'; }
function closeImport() { $('#importModal').style.display = 'none'; }

function logLine(t) { const l = $('#impLog'); l.textContent += t + '\n'; l.scrollTop = l.scrollHeight; }
function setProg(p, label) { $('#impProg').style.width = (p * 100).toFixed(1) + '%'; if (label) $('#impStatus').textContent = label; }

function handleFile(file) {
  if (IMP.busy) return;
  if (typeof XLSX === 'undefined') { logLine('✗ Spreadsheet reader did not load — check your internet connection and reload.'); return; }
  $('#impLog').textContent = '';
  logLine('Reading ' + file.name + ' …');
  const fr = new FileReader();
  fr.onload = e => {
    let rows;
    try {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    } catch (err) { logLine('✗ Could not read the file: ' + err.message); return; }
    if (!rows.length) { logLine('✗ The first sheet is empty.'); return; }

    const keys = Object.keys(rows[0]);
    const find = (...cands) => keys.find(k => cands.some(c => k.toLowerCase().replace(/[^a-z]/g, '').includes(c)));
    const map = {
      company: find('companyname', 'company', 'organization', 'business', 'name'),
      addr: find('address', 'street'), city: find('city'), state: find('state'),
      zip: find('zip', 'postal'), phone: find('phone', 'tel'), web: find('website', 'url', 'web'),
      emp: find('numberofemployees', 'employees', 'employee', 'headcount', 'staff'),
      naics: find('naics', 'sic', 'industry', 'businessdescription', 'description'),
      first: find('firstname'), last: find('lastname')
    };
    if (!map.company || !map.addr) {
      logLine('✗ Could not find a company-name and address column.');
      logLine('  Columns seen: ' + keys.join(', '));
      return;
    }
    logLine(`✓ ${rows.length} rows, mapped: company=“${map.company}”, address=“${map.addr}”, employees=“${map.emp || '—'}”`);
    IMP.rows = rows.map((r, i) => ({
      id: i, company: String(r[map.company] || '').trim(),
      addr: String(r[map.addr] || '').trim(), city: String(r[map.city] || '').trim(),
      state: String(r[map.state] || 'CO').trim(), zip: String(r[map.zip] || '').trim().slice(0, 5),
      phone: String(r[map.phone] || ''), web: String(r[map.web] || ''),
      emp: parseInt(String(r[map.emp] || '0').replace(/\D/g, ''), 10) || 0,
      desc: String(r[map.naics] || ''),
      first: String(r[map.first] || 'Human Resources'), last: String(r[map.last] || 'Director')
    })).filter(r => r.company && r.addr);
    logLine(`✓ ${IMP.rows.length} usable rows`);
    $('#impGo').disabled = false;
  };
  fr.readAsArrayBuffer(file);
}

function censusJSONP(address, timeout) {
  return new Promise(resolve => {
    const fn = '__zsjp' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    let done = false;
    const cleanup = () => { try { s.remove(); delete window[fn]; } catch (e) {} };
    window[fn] = d => {
      if (done) return; done = true;
      const m = d && d.result && d.result.addressMatches && d.result.addressMatches[0];
      resolve(m ? { lat: m.coordinates.y, lon: m.coordinates.x, q: 'Census' } : null);
      cleanup();
    };
    s.onerror = () => { if (!done) { done = true; resolve(null); cleanup(); } };
    s.src = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=' +
      encodeURIComponent(address) + '&benchmark=Public_AR_Current&format=jsonp&callback=' + fn;
    document.head.appendChild(s);
    setTimeout(() => { if (!done) { done = true; resolve(null); cleanup(); } }, timeout || 9000);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function osmGeocode(q) {
  try {
    const j = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(q))).json();
    return j && j[0] ? { lat: +j[0].lat, lon: +j[0].lon, q: 'OSM' } : null;
  } catch (e) { return null; }
}

async function runImport() {
  IMP.busy = true; $('#impGo').disabled = true; $('#impClose').disabled = true;
  const cache = LS.get('geocache', {});
  const rows = IMP.rows;
  let done = 0, hitCensus = 0, hitOSM = 0, missed = [];

  logLine('\nGeocoding via US Census …');
  for (const r of rows) {
    const key = (r.addr + '|' + r.city + '|' + r.zip).toLowerCase();
    if (cache[key]) { r.geo = cache[key]; hitCensus++; }
    else {
      const g = await censusJSONP(`${r.addr}, ${r.city}, ${r.state} ${r.zip}`);
      if (g) { r.geo = g; cache[key] = g; hitCensus++; }
      else missed.push(r);
    }
    done++;
    if (done % 5 === 0 || done === rows.length) setProg(done / rows.length * 0.62, `Geocoding ${done} / ${rows.length}`);
  }
  LS.set('geocache', cache);
  logLine(`✓ Census matched ${hitCensus} of ${rows.length}`);

  if (missed.length) {
    logLine(`Retrying ${missed.length} via OpenStreetMap (1 per second) …`);
    for (let i = 0; i < missed.length; i++) {
      const r = missed[i];
      const g = await osmGeocode(`${r.addr}, ${r.city}, ${r.state} ${r.zip}`) ||
                await osmGeocode(`${r.city}, ${r.state} ${r.zip}`);
      if (g) { r.geo = g; hitOSM++; cache[(r.addr + '|' + r.city + '|' + r.zip).toLowerCase()] = g; }
      setProg(0.62 + (i + 1) / missed.length * 0.16, `OpenStreetMap ${i + 1} / ${missed.length}`);
      await sleep(1100);
    }
    LS.set('geocache', cache);
    logLine(`✓ OpenStreetMap matched a further ${hitOSM}`);
  }

  const good = rows.filter(r => r.geo);
  const dropped = rows.length - good.length;
  if (dropped) logLine(`⚠ ${dropped} rows could not be located and were dropped.`);
  if (!good.length) { logLine('✗ Nothing could be geocoded. Import cancelled.'); IMP.busy = false; $('#impClose').disabled = false; return; }

  logLine('\nRouting driving distances via OSRM …');
  let routed = 0;
  for (let s = 0; s < good.length; s += 80) {
    const chunk = good.slice(s, s + 80);
    const coords = [`${HOME.lon},${HOME.lat}`].concat(chunk.map(r => `${r.geo.lon.toFixed(6)},${r.geo.lat.toFixed(6)}`)).join(';');
    try {
      const j = await (await fetch(`https://router.project-osrm.org/table/v1/driving/${coords}?sources=0&annotations=distance,duration`)).json();
      if (j.code === 'Ok') {
        chunk.forEach((r, k) => {
          const d = j.distances[0][k + 1], t = j.durations[0][k + 1];
          if (d != null) { r.mi = d / 1609.344; r.min = t / 60; routed++; }
        });
      }
    } catch (e) { logLine('  routing chunk failed — falling back to straight line'); }
    setProg(0.78 + Math.min(1, (s + 80) / good.length) * 0.2, `Routing ${Math.min(s + 80, good.length)} / ${good.length}`);
    await sleep(400);
  }
  // straight-line fallback with a road factor for anything OSRM missed
  good.forEach(r => {
    if (r.mi == null) { r.mi = haversine(HOME.lat, HOME.lon, r.geo.lat, r.geo.lon) * 1.28; r.min = r.mi * 2.2; }
  });
  logLine(`✓ Routed ${routed} of ${good.length}`);

  logLine('\nClassifying and scoring …');
  const built = good.map(r => buildRow(r));
  S.rows = built;
  Object.keys(CATS).forEach(k => { CATS[k].count = built.filter(b => b.category === k).length; });
  DATA.meta.recordCount = built.length;
  DATA.meta.source = 'Imported spreadsheet';
  S.cats = new Set(Object.keys(CATS));
  S.bands = new Set([0, 1, 2, 3]);
  const ext = built.reduce((a, r) => [Math.min(a[0], r.employees), Math.max(a[1], r.employees)], [1e9, 0]);
  S.empMin = ext[0]; S.empMax = ext[1];
  $('#empMin').min = $('#empMax').min = ext[0]; $('#empMin').max = $('#empMax').max = ext[1];
  $('#empMin').value = ext[0]; $('#empMax').value = ext[1];
  S.shortlist = new Set(); LS.set('shortlist', []);
  setProg(1, `Done — ${built.length} sites ready`);
  logLine(`✓ ${built.length} sites loaded. Close this dialog to explore them.`);
  logLine('  Tip: use “Export dataset (JSON)” to save this as your new default.');
  IMP.busy = false; $('#impClose').disabled = false;
  render();
}

function haversine(aLat, aLon, bLat, bLon) {
  const R = 3958.7613, p1 = aLat * Math.PI / 180, p2 = bLat * Math.PI / 180;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((bLon - aLon) * Math.PI / 360) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function classifyClient(name, desc) {
  const n = (name || '').toLowerCase(), d = (desc || '').toLowerCase();
  for (const [pat, field, cat] of window.__RULES__) {
    if (new RegExp(pat).test(field === 'n' ? n : d)) return [cat, field === 'n' ? 'name' : 'industry'];
  }
  return ['other', 'unclassified'];
}

function buildRow(r) {
  const [cat, via] = classifyClient(r.company, r.desc);
  const c = CATS[cat];
  const onsite = r.emp * c.onsite;
  const audience = onsite * (1 + c.visitors);
  const traffic = Math.min(100, Math.max(0, (Math.log10(Math.max(audience, 1)) - 1.1) / 2.3 * 100));
  const proximity = 100 * Math.exp(-r.mi / 11);
  const capture = 0.05 + c.fit / 100 * 0.15;
  const days = c.alwaysOn ? 30 : 21;
  const daily = audience * capture;
  const revenue = daily * DATA.meta.avgVendPrice * days;
  const gross = revenue * DATA.meta.grossMarginPct / 100;
  const service = 2 * (r.mi * 2 * 0.7 + ((r.min * 2 + 15) / 60) * 28);
  return {
    id: r.id, company: r.company, address: r.addr, city: r.city, state: r.state, zip: r.zip,
    phone: r.phone, website: r.web, contactName: (r.first + ' ' + r.last).trim(),
    employees: r.emp, description: r.desc, naics: r.desc, category: cat, categoryVia: via,
    categoryLabel: c.label, lat: r.geo.lat, lon: r.geo.lon, geoQuality: r.geo.q,
    driveMiles: +r.mi.toFixed(2), driveMinutes: +r.min.toFixed(1),
    straightMiles: +haversine(HOME.lat, HOME.lon, r.geo.lat, r.geo.lon).toFixed(2),
    band: bandOf(r.mi), onsiteEstimate: Math.round(onsite), audience: Math.round(audience),
    sTraffic: +traffic.toFixed(1), sProximity: +proximity.toFixed(1), sFit: c.fit, sDwell: c.dwell,
    sCluster: 0, neighbors: 0, neighborEmployees: 0,
    vtier: 'consistent', vwarn: 0,
    verify: { tier: 'consistent', label: 'Consistent', warnings: 0, flags: [
      { k: 'imported', sev: 'info', text: 'Imported record — not cross-checked against map data',
        detail: 'Only the built-in dataset has been verified against OpenStreetMap.' }] },
    estDailyVends: +daily.toFixed(1), estMonthlyRevenue: Math.round(revenue),
    estMonthlyGross: Math.round(gross), estServiceCost: Math.round(service),
    estMonthlyNet: Math.round(gross - service), score: 0
  };
}

/* ------------------------------------------------------------------- wiring */
function bind() {
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => { S.view = t.dataset.view; render(); });

  const si = $('#search');
  si.oninput = () => { S.q = si.value; $('#searchClear').style.display = si.value ? '' : 'none'; render(); };
  $('#searchClear').onclick = () => { si.value = ''; S.q = ''; $('#searchClear').style.display = 'none'; render(); si.focus(); };

  $('#bandAll').onclick = () => { S.bands = new Set([0, 1, 2, 3]); render(); };
  $('#catAll').onclick = () => { S.cats = new Set(Object.keys(CATS)); render(); };
  $('#catNone').onclick = () => { S.cats = new Set(); render(); };
  $('#addSort').onclick = () => {
    const used = new Set(S.sorts.map(s => s.k));
    const next = SORT_FIELDS.find(f => !used.has(f.k)) || SORT_FIELDS[0];
    S.sorts.push({ k: next.k, dir: next.dir }); saveSorts(); render();
  };
  $('#resetWeights').onclick = () => {
    S.weights = { traffic: 30, proximity: 25, fit: 25, dwell: 12, cluster: 8 };
    LS.set('weights', S.weights); render(); toast('Weights reset');
  };

  const bindRange = (id, key, fmt) => {
    const n = $(id);
    n.oninput = () => {
      S[key] = +n.value;
      if (key === 'empMin' && S.empMin > S.empMax) { S.empMax = S.empMin; $('#empMax').value = S.empMax; }
      if (key === 'empMax' && S.empMax < S.empMin) { S.empMin = S.empMax; $('#empMin').value = S.empMin; }
      render();
    };
  };
  $('#empMin').min = $('#empMax').min = empExtent[0];
  $('#empMin').max = $('#empMax').max = empExtent[1];
  $('#empMin').value = empExtent[0]; $('#empMax').value = empExtent[1];
  const driveMax = Math.ceil(Math.max(...S.rows.map(r => r.driveMinutes)) / 5) * 5;
  $('#maxDrive').max = driveMax; $('#maxDrive').value = driveMax; S.maxDrive = driveMax;
  $('#maxDrive').dataset.prevMax = driveMax;
  bindRange('#empMin', 'empMin'); bindRange('#empMax', 'empMax');
  bindRange('#maxDrive', 'maxDrive'); bindRange('#minScore', 'minScore');

  $('#swOnsite').onclick = () => { S.onsiteOnly = !S.onsiteOnly; render(); };
  $('#swShort').onclick = () => { S.shortlistOnly = !S.shortlistOnly; render(); };

  $('#mapColorBand').onclick = () => { S.mapColorBy = 'band'; syncSeg(); renderMap(); };
  $('#mapColorCat').onclick = () => { S.mapColorBy = 'cat'; syncSeg(); renderMap(); };
  $('#mapRings').onclick = () => { S.showRings = !S.showRings; $('#mapRings').classList.toggle('on', S.showRings); drawRings(); };
  $('#mapFit').onclick = fitToFiltered;
  $('#mapHome').onclick = () => { if (map) map.setView([HOME.lat, HOME.lon], 12); };

  $('#btnExport').onclick = () => exportCSV(S.filtered, 'filtered-sites');
  $('#btnExportJSON').onclick = exportJSON;
  $('#btnImport').onclick = openImport;
  $('#btnHome').onclick = () => {
    $('#homeInput').value = HOME.label;
    $('#homeCount').textContent = S.rows.length;
    $('#homeModal').style.display = 'grid';
    setTimeout(() => $('#homeInput').select(), 60);
  };
  $('#homeClose').onclick = () => { if (!homeBusy) $('#homeModal').style.display = 'none'; };
  $('#homeGo').onclick = setHomeFromInput;
  $('#homeReset').onclick = resetHome;
  $('#homeInput').onkeydown = e => { if (e.key === 'Enter') setHomeFromInput(); };
  $('#homeModal').onclick = e => { if (e.target.id === 'homeModal' && !homeBusy) $('#homeModal').style.display = 'none'; };
  $('#tierAll').onclick = () => { S.tiers = new Set(Object.keys(TIERS)); render(); };
  $('#impClose').onclick = closeImport;
  $('#impGo').onclick = runImport;
  $('#importModal').onclick = e => { if (e.target.id === 'importModal' && !IMP.busy) closeImport(); };

  const dz = $('#dropzone'), fi = $('#fileInput');
  dz.onclick = () => fi.click();
  fi.onchange = () => fi.files[0] && handleFile(fi.files[0]);
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

  $('#btnTheme').onclick = () => {
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    setTheme(cur); LS.set('theme', cur);
  };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeDrawer();
      if (!IMP.busy) closeImport();
      if (!homeBusy) $('#homeModal').style.display = 'none';
    }
    if (e.key === '/' && document.activeElement !== si) { e.preventDefault(); si.focus(); }
  });
  syncSeg();
}
function syncSeg() {
  $('#mapColorBand').classList.toggle('on', S.mapColorBy === 'band');
  $('#mapColorCat').classList.toggle('on', S.mapColorBy === 'cat');
  $('#mapRings').classList.toggle('on', S.showRings);
}
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  $('#btnTheme').textContent = t === 'dark' ? '☀' : '☾';
  if (S.view === 'charts') renderCharts();
  if (S.view === 'method') { $('#viewMethod').dataset.done = ''; renderMethod(); }
}

/* --------------------------------------------------------------------- boot */
const savedTheme = LS.get('theme', null);
setTheme(savedTheme || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('#homeLabel').textContent = HOME.label;
$('#metaLine').textContent = `${DATA.meta.recordCount} sites · ${DATA.meta.source}`;
bind();
restoreHome();
render();
window.addEventListener('resize', () => { if (S.view === 'charts') renderCharts(); });

})();
