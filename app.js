/* app.js — boating-zones explorer for one water (data/config.json names it): map, rules, editor, downloads, live conditions.
 * Depends on Leaflet (+ Geoman for drawing lines/areas), engine.js and export.js. */
(function () {
  'use strict';
  const FT = 0.3048, ACRE = 4046.8564224;
  const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
  const LS = { feats: 'srz:features:v1', ui: 'srz:ui:v1', print: 'srz:print:v1' };
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtAc = a => a >= 100 ? Math.round(a).toLocaleString('en-US') : a >= 10 ? Math.round(a).toString() : a.toFixed(1);
  const fmtFt = f => Math.round(f).toLocaleString('en-US');
  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } };
  const lsDel = k => { try { localStorage.removeItem(k); } catch (_) { /* private mode */ } };

  const S = {
    cfg: null, reach: null, eng: null, tags: Object.create(null), base: null, baseSig: '', fc: null,
    params: null, defaults: null, res: null, baseRes: null,
    view: 'bottom', single: 'nowake', levelOffsetFt: 0, levelLive: false,
    edit: { on: false, tag: 'dock', mode: 'select', sel: null }, review: null,
    hist: [], fut: [], gps: null, gpsWatch: null, follow: true, turnFt: 200, corr: [],
  };
  let map, R = {}, L_ = {};          // leaflet map, renderers, layers
  const featLayers = new Map();      // feature id -> leaflet layer

  // ===================================================================== boot
  // data files: always revalidated (a republished map shows at once), with errors that say which file
  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`couldn't load ${url} (HTTP ${r.status}) — try again in a minute`);
    const text = await r.text();
    try { return JSON.parse(text); } catch (e) { throw new Error(`${url} is damaged (${e.message})`); }
  }
  async function boot() {
    const [cfg, reach, base] = await Promise.all(['data/config.json', 'data/reach.json', 'data/features.geojson'].map(getJSON));
    S.cfg = cfg; S.reach = reach;
    for (const t of cfg.tags) S.tags[t.id] = t;
    // the page names its water from config (the HTML's own text is only the link-preview fallback)
    document.title = cfg.title;
    $('.brand-title').textContent = cfg.title; $('.brand-sub').textContent = cfg.subtitle || '';
    $('.brand').setAttribute('aria-label', cfg.title + ' — map');
    const md = document.querySelector('meta[name="description"]'); if (md && cfg.place && cfg.place.description) md.setAttribute('content', cfg.place.description);
    if (cfg.place && cfg.place.riverMileOrigin) $('#rmOrigin').textContent = cfg.place.riverMileOrigin;
    // every feature is checked on the way in: one bad record must never break the page
    const dropped = [];
    S.base = cleanFC(base, dropped);
    S.baseSig = (base.generated || '') + ':' + S.base.features.length;
    S.eng = ZoneEngine.create(reach);
    S.defaults = defaultParams();
    S.params = clone(S.defaults);
    const saved = lsGet(LS.feats);
    S.fc = saved && saved.fc && saved.fc.type === 'FeatureCollection' && Array.isArray(saved.fc.features) ? cleanFC(saved.fc, dropped) : clone(S.base);
    S.rev = saved && saved.rev || 0;
    if (dropped.length) setTimeout(() => editMsg(`Skipped ${dropped.length} damaged feature${dropped.length === 1 ? '' : 's'} (${dropped.slice(0, 3).join(', ')}${dropped.length > 3 ? '…' : ''}) — the rest of the map is fine.`), 700);
    if (saved && saved.baseSig && saved.baseSig !== S.baseSig) {
      setTimeout(() => editMsg('The published map changed since your saved edits. Your edits are kept — export them or discard to load the new version.'), 600);
    }
    readHash();
    buildMap();
    // the compact legend strip leaves the river visible; the full legend is one tap away (large desktops start open)
    if (window.matchMedia('(max-width: 1599px), (max-height: 999px)').matches) $('#legend').classList.add('min');
    // the header wraps to two rows on narrower screens: size the app to what's left
    const top = document.querySelector('.top');
    const setTop = () => { document.documentElement.style.setProperty('--toph', top.offsetHeight + 'px'); if (map) map.invalidateSize(); };
    setTop();
    if (window.ResizeObserver) new ResizeObserver(setTop).observe(top);
    buildPresets();
    buildRuleControls();
    buildPalette();
    wireUI();
    // pages and live conditions don't depend on the features: a feature problem can't switch them off
    renderRulesPage(); renderAbout(); renderOfficialDownloads();
    loadConditions();
    syncEngine();
    renderAllFeatures();
    renderStatic();
    S.booted = true;
    recompute();
    updateEditState();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !/[?&]nosw/.test(location.search)) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    // handle for automated tests and power users (console): window.SRZ.state, .exportModel('kml') …
    window.SRZ = { state: S, map, setView, setEdit, setMode, startReview, reviewAct, undo, redo, mutate, exportModel, parseKML, parseGPX,
      importText: (name, text) => importFile(new File([text], name)), modelText: fmt => { const m = exportModel(false);
        return fmt === 'kml' ? ZoneExport.toKML(m) : fmt === 'gpx' ? ZoneExport.toGPX(m) : ZoneExport.toGeoJSON(m); } };
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function defaultParams() {
    const r = S.cfg.rules;
    const pick = k => ({ ft: r[k].ft, shore: !!r[k].shore, structures: !!r[k].structures, minDepthFt: r[k].minDepthFt || 0 });
    return { rules: { nowake: pick('nowake'), tow: pick('tow'), surf: pick('surf') }, passFt: r.pass.ft,
             run: { ft: r.run.ft, laneFt: r.run.laneFt, stepDeg: r.run.stepDeg }, zonesOn: true, levelAdjust: true };
  }
  function engParams(p, view) {
    p = p || S.params; view = view || S.view;
    return { rules: p.rules, passFt: p.passFt, zonesOn: p.zonesOn,
             run: { ft: p.run.ft, laneFt: p.run.laneFt, stepDeg: p.run.stepDeg, activity: view === 'surf' ? 'surf' : 'tow' },
             levelOffsetFt: p.levelAdjust ? S.levelOffsetFt : 0, width: view === 'pass', single: view === 'rule' ? S.single : null,
             allNoWake: !!S.highWater };
  }
  function isDefault() { return JSON.stringify(S.params) === JSON.stringify(S.defaults); }

  // ============================================================ engine sync
  function utm(lon, lat) { return S.eng.fromLonLat(lon, lat); }
  const ZONE_TAGS = { no_wake_zone: 'no_wake', no_motor_zone: 'no_motor', no_entry_zone: 'no_entry' };
  const isZoneTag = t => !!ZONE_TAGS[t];
  // what a designated zone means on the water, by type
  const place = () => (S.cfg && S.cfg.place) || {};
  function zoneMsg(type, when) {
    if (type === 'no_entry') return when === 'posted' ? `NO ENTRY WHEN POSTED — ${place().noEntryPosted || 'check the posted signs'}` : `NO ENTRY — ${place().noEntryAlways || 'keep out'}`;
    if (type === 'no_motor') return 'NO MOTORS — paddle or sail only';
    return 'DESIGNATED NO-WAKE ZONE — 5 mph, no wake';
  }
  const zoneMsgOf = f => f ? zoneMsg(ZONE_TAGS[f.properties.tag] || 'no_wake', f.properties.when) : zoneMsg('no_wake');
  function isStructure(f) {
    const pr = f.properties, t = S.tags[pr.tag] || S.tags.other;
    return pr.structure != null ? !!pr.structure : !!t.structure;
  }
  // does this feature change the rule geometry? (auto-detected candidates count once confirmed)
  const pending = f => f.properties.status === 'unreviewed' || f.properties.status === 'imported';
  const countsForRules = f => (isStructure(f) || isZoneTag(f.properties.tag)) && !pending(f);
  // everything about a feature the distance rules read — a rename or a note leaves it unchanged
  const ruleSig = f => countsForRules(f) ? JSON.stringify([f.properties.tag, f.geometry, isStructure(f), !!f.properties.hidden, f.properties.when || '']) : '';
  function syncEngine() {
    const { structures, zones } = ZoneExport.engineInputs(S.eng, S.fc, S.cfg);
    const sk = JSON.stringify(structures), zk = JSON.stringify(zones);
    if (sk === S.structKey && zk === S.zoneKey) return;
    if (sk !== S.structKey) { S.eng.setStructures(structures); S.structKey = sk; }
    if (zk !== S.zoneKey) { S.eng.setZones(zones); S.zoneKey = zk; }
    S.nStructures = structures.length;
    S.engRev = (S.engRev || 0) + 1;     // the current-rules baseline depends on these inputs
  }

  // ================================================================ compute
  let recTimer = null, recSeq = 0;
  function schedule(delay) {
    if (!S.booted) return;                 // boot runs the first compute itself, once everything is loaded
    clearTimeout(recTimer);
    $('#busy').classList.add('on');
    recTimer = setTimeout(() => recompute(), delay == null ? 90 : delay);
  }
  function recompute() {
    if (!S.booted) return;
    const seq = ++recSeq;
    $('#busy').classList.add('on');
    // let the "updating" pill paint before the synchronous work
    requestAnimationFrame(() => setTimeout(() => {
      if (seq !== recSeq) return;
      // the baseline (current rules) runs FIRST: the engine's working fields belong to
      // the last compute, and corridors / shallow water below must read the what-if ones
      const bk = JSON.stringify([S.view === 'surf', S.levelOffsetFt, !!S.highWater, S.engRev]);
      if (!isDefault() && (!S.baseRes || S.baseKey !== bk)) { S.baseRes = S.eng.compute(engParams(S.defaults, S.view === 'surf' ? 'surf' : 'bottom')); S.baseKey = bk; }
      S.res = S.eng.compute(engParams());
      if (S.view === 'bottom' || S.view === 'surf') {
        S.corr = S.eng.corridors(S.view === 'surf' ? 'surf' : 'tow', engParams(), { turnFt: S.turnFt / 2, minWidthFt: S.params.run.laneFt,
          levelOffsetFt: S.params.levelAdjust ? S.levelOffsetFt : 0 });
      } else S.corr = [];
      renderZones(); renderStats(); renderLegend(); renderWaterfall(); renderRuns(); updateHash();
      if (S.gps) evalGps();
      $('#busy').classList.remove('on');
      document.body.classList.add('ready');
    }, 0));
  }

  // ================================================================== map
  function buildMap() {
    const b = S.reach.bounds_lonlat;
    map = L.map('lmap', { zoomControl: true, maxZoom: 20, minZoom: 11, zoomSnap: 0.25, wheelPxPerZoomLevel: 90, worldCopyJump: false });
    const bounds = L.latLngBounds([b[1], b[0]], [b[3], b[2]]);
    map.setMaxBounds(bounds.pad(0.6));
    const usgs = n => `https://basemap.nationalmap.gov/arcgis/rest/services/${n}/MapServer/tile/{z}/{y}/{x}`;
    const base = {
      'Aerial + labels (USGS)': L.tileLayer(usgs('USGSImageryTopo'), { crossOrigin: true, maxNativeZoom: 16, maxZoom: 20, attribution: 'USGS The National Map' }),
      'Aerial (USGS)': L.tileLayer(usgs('USGSImageryOnly'), { crossOrigin: true, maxNativeZoom: 16, maxZoom: 20, attribution: 'USGS The National Map: Orthoimagery' }),
      'Aerial, sharper (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { crossOrigin: true, maxNativeZoom: 19, maxZoom: 20, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' }),
      'Topo (USGS)': L.tileLayer(usgs('USGSTopo'), { crossOrigin: true, maxNativeZoom: 16, maxZoom: 20, attribution: 'USGS The National Map' }),
    };
    const ui = lsGet(LS.ui) || {};
    const baseName = base[ui.base] ? ui.base : 'Aerial (USGS)';
    base[baseName].addTo(map);
    L_.base = base; L_.baseName = baseName;
    map.on('baselayerchange', e => {
      L_.baseName = e.name;
      const u = lsGet(LS.ui) || {}; u.base = e.name; lsSet(LS.ui, u);
    });

    const pane = (n, z, pe) => { map.createPane(n); map.getPane(n).style.zIndex = z; if (!pe) map.getPane(n).style.pointerEvents = 'none'; };
    pane('depth', 340); pane('bands', 350); pane('width', 352); pane('single', 354); pane('shore', 360);
    pane('runs', 380); pane('nwz', 390, true); pane('feat', 410, true); pane('labels', 640);
    R.bands = L.canvas({ pane: 'bands', padding: 0.4 });
    R.depth = L.canvas({ pane: 'depth', padding: 0.4 });
    R.width = L.canvas({ pane: 'width', padding: 0.4 });
    R.single = L.canvas({ pane: 'single', padding: 0.4 });
    R.shore = L.canvas({ pane: 'shore', padding: 0.4 });
    R.runs = L.canvas({ pane: 'runs', padding: 0.4 });
    R.nwz = L.svg({ pane: 'nwz', padding: 0.4 });
    R.feat = L.svg({ pane: 'feat', padding: 0.4 });

    const poly = (rend, opt) => L.polygon([], Object.assign({ renderer: rend, interactive: false, pmIgnore: true, stroke: false, fillRule: 'evenodd' }, opt)).addTo(map);
    L_.bands = {};
    for (const k of ['idle', 'cruise', 'tow', 'surf']) {
      const c = S.cfg.classes[k];
      L_.bands[k] = poly(R.bands, { fillColor: c.color, fillOpacity: c.opacity, stroke: k !== 'idle', color: c.color, weight: 1, opacity: 0.9 });
    }
    L_.width = {};
    for (const k of ['narrow', 'twoway', 'surfpass']) L_.width[k] = poly(R.width, { fillColor: S.cfg.classes[k].color, fillOpacity: 0.5 });
    L_.single = poly(R.single, { fillColor: '#2bb673', fillOpacity: 0.55, stroke: true, color: '#0d6b3c', weight: 1.4 });
    L_.singleOut = poly(R.single, { fillColor: '#d7263d', fillOpacity: 0.32 });
    L_.depth = [];
    L_.runs = poly(R.runs, { stroke: true, color: S.cfg.classes.runs.color, weight: 2.6, dashArray: '7 5', fillColor: S.cfg.classes.runs.color, fillOpacity: 0.16 });
    L_.shallow = L.polygon([], { renderer: R.nwz, interactive: false, pmIgnore: true, stroke: false, fillColor: 'url(#cauHatch)', fillOpacity: 1, fillRule: 'evenodd' }).addTo(map);
    L_.depth20 = L.polygon([], { renderer: R.runs, interactive: false, pmIgnore: true, fill: false, color: '#9fe7ff', weight: 2, dashArray: '2 6', lineCap: 'round', opacity: 0.95 }).addTo(map);
    L_.longest = L.polyline([], { renderer: R.runs, color: '#ffffff', weight: 3.5, opacity: 0.95, dashArray: '2 7', lineCap: 'round', interactive: false, pmIgnore: true }).addTo(map);
    L_.longestShadow = L.polyline([], { renderer: R.runs, color: '#0a1a26', weight: 6, opacity: 0.5, interactive: false, pmIgnore: true }).addTo(map);
    L_.longestShadow.bringToBack();

    // the analysed shoreline, crisp on top of the fills
    const ring2ll = r => r.map(([x, y]) => { const [lo, la] = S.eng.toLonLat(x, y); return [la, lo]; });
    L_.shore = L.polygon(S.reach.water.polygons.flatMap(p => p.map(ring2ll)), { renderer: R.shore, interactive: false, pmIgnore: true, fill: false, color: '#ffffff', weight: 1.1, opacity: 0.85 }).addTo(map);

    // hatch patterns (url(#nwzHatch) etc.) are declared once in index.html, outside Leaflet
    // lake approach: display-only, all of it a designated no-wake zone
    if (S.reach.approach) {
      L_.approach = L.polygon(S.reach.approach.polygons.flatMap(p => p.map(ring2ll)), { renderer: R.nwz, pmIgnore: true, interactive: true,
        color: '#8a1630', weight: 1.2, fillColor: 'url(#nwzHatch)', fillOpacity: 1 }).addTo(map)
        .bindTooltip(esc('No wake: ' + ((S.cfg.approach && S.cfg.approach.text) || 'designated no-wake zone')), { sticky: true });
      noTabStop(L_.approach);
    }

    const overlays = {};
    L_.docksGroup = L.layerGroup().addTo(map);
    L_.poiGroup = L.layerGroup().addTo(map);
    L_.featGroup = L.layerGroup().addTo(map);
    overlays['Docks & structures'] = L_.docksGroup;
    overlays['Launches, services & hazards'] = L_.poiGroup;
    overlays['Lines & areas (booms, zones, caution)'] = L_.featGroup;
    overlays['Straight lanes'] = L.layerGroup([L_.runs, L_.longest, L_.longestShadow]).addTo(map);
    L_.corr = L.layerGroup().addTo(map);
    overlays['Run stretches & U-turn spots'] = L_.corr;
    L_.ticks = L.layerGroup().addTo(map);
    overlays['River miles'] = L_.ticks;
    for (const t of S.eng.ticks(0.25)) {
      const major = Math.abs(t.rm * 2 - Math.round(t.rm * 2)) < 1e-6, half = major && Math.abs(t.rm - Math.round(t.rm)) > 1e-6;
      L.marker(ll(t.x, t.y), { interactive: false, keyboard: false, pmIgnore: true,
        icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="rm-tick${major ? half ? ' half' : '' : ' minor'}">${major ? 'RM ' + t.rm : '·'}</div>` }) }).addTo(L_.ticks);
    }
    L.control.layers(base, overlays, { position: 'topright', collapsed: true }).addTo(map);
    L.control.scale({ imperial: true, metric: false, position: 'bottomright' }).addTo(map);

    const Btn = L.Control.extend({
      options: { position: 'topright' },
      onAdd() {
        const d = L.DomUtil.create('div', 'leaflet-bar');
        d.innerHTML = '<button class="mapbtn" id="gpsBtn" title="Show my location and the setbacks here" aria-label="My location">⌖</button>' +
          '<button class="mapbtn" id="fitBtn" title="Whole river" aria-label="Zoom to the whole river">⤢</button>' +
          '<button class="mapbtn" id="editBtn" title="Edit map features" aria-label="Edit map">✎</button>';
        L.DomEvent.disableClickPropagation(d);
        return d;
      },
    });
    map.addControl(new Btn());

    const st = S.startView;
    if (st) map.setView([st[0], st[1]], st[2]); else map.fitBounds(L.latLngBounds(ring2ll(S.reach.water.polygons[0][0])), { padding: [20, 20] });
    const zb = () => { const z = map.getZoom(); map.getContainer().setAttribute('data-zb', z < 14 ? 'far' : z < 16 ? 'mid' : 'near'); };
    map.on('zoomend', zb); zb();
    map.on('moveend', () => updateHash());
    map.on('click', onMapClick);
    map.on('dragstart', () => { S.follow = false; });

    if (map.pm) {
      map.pm.setGlobalOptions({ snappable: false, allowSelfIntersection: true });
      map.on('pm:create', onDrawCreate);
    }
  }

  const ll = (x, y) => { const [lo, la] = S.eng.toLonLat(x, y); return [la, lo]; };
  const ringsLL = rings => rings.map(r => r.map(([x, y]) => ll(x, y)));

  function renderStatic() {
    // depth bands are static (they move only with the lake level)
    for (const l of L_.depth) map.removeLayer(l);
    L_.depth = [];
    if (S.view !== 'depth') return;
    const d = S.cfg.depth, bands = S.eng.depthBands(d.edges, S.params.levelAdjust ? S.levelOffsetFt : 0);
    bands.forEach((b, i) => {
      L_.depth.push(L.polygon(ringsLL(b.rings), { renderer: R.depth, interactive: false, pmIgnore: true, stroke: false, fillRule: 'evenodd',
        fillColor: d.colors[i], fillOpacity: i === 0 ? 0.8 : 0.72 }).addTo(map));
    });
  }

  function renderZones() {
    const res = S.res, v = S.view;
    const showBands = v === 'bottom' || v === 'surf';
    for (const k of ['idle', 'cruise', 'tow', 'surf']) {
      const lay = L_.bands[k];
      lay.setLatLngs(showBands ? ringsLL(res.bands[k].rings) : []);
      let op = S.cfg.classes[k].opacity;
      if (v === 'surf') op = k === 'surf' ? 0.62 : k === 'tow' ? 0.42 : 0.3;
      lay.setStyle({ fillOpacity: op });
    }
    for (const k of ['narrow', 'twoway', 'surfpass']) L_.width[k].setLatLngs(v === 'pass' && res.width ? ringsLL(res.width.classes[k].rings) : []);
    if (v === 'rule' && res.single) {
      L_.single.setLatLngs(ringsLL(res.single.rings));
      // everything else in the water is "inside this rule's buffer"
      const all = [...res.bands.idle.rings, ...res.bands.cruise.rings, ...res.bands.tow.rings, ...res.bands.surf.rings];
      L_.singleOut.setLatLngs(ringsLL(res.single.rings.concat(waterRings())));
      void all;
    } else { L_.single.setLatLngs([]); L_.singleOut.setLatLngs([]); }
    const lanes = v === 'bottom' || v === 'surf';
    L_.runs.setLatLngs(lanes ? ringsLL(res.runs.rings) : []);
    const lg = res.runs.longest;
    const line = lanes && lg ? [ll(...lg.a), ll(...lg.b)] : [];
    L_.longest.setLatLngs(line); L_.longestShadow.setLatLngs(line);
    if (lanes && lg) L_.longest.bindTooltip(`Longest straight lane: ${fmtFt(lg.m / FT)} ft`, { sticky: true }); else L_.longest.unbindTooltip();
    L_.shore.setStyle({ opacity: v === 'depth' ? 0.5 : 0.85 });
    const lvl = S.params.levelAdjust ? S.levelOffsetFt : 0, sh = S.cfg.depth.shallowFt || 5;
    L_.shallow.setLatLngs(v === 'bottom' || v === 'surf' ? ringsLL(S.eng.shallowInUse(sh, engParams()).rings) : []);
    L_.depth20.setLatLngs(v === 'surf' || v === 'depth' ? ringsLL(S.eng.depthLine(S.cfg.depth.surfLineFt || 10, lvl)) : []);
  }
  function waterRings() { return S.reach.water.polygons.flatMap(p => p); }

  // ---- plan a run: corridor cards, launch cards, map markers ----------------------
  const SPEED = { tow: 25, surf: 11 };
  function fmtMin(ft, mph) { const m = ft / (mph * 5280 / 60); return m < 1 ? '<1 min' : Math.round(m) + ' min'; }
  function renderRuns() {
    L_.corr.clearLayers();
    const surf = S.view === 'surf', act = surf ? 'surf' : 'tow';
    $$('#tRuns .segb').forEach(b => b.classList.toggle('on', b.dataset.act === act));
    const box = $('#runCards');
    if (!(S.view === 'bottom' || S.view === 'surf')) { box.innerHTML = '<p class="note">Switch the map to <b>Where to boat</b> or <b>Wake surf</b> to plan a run.</p>'; $('#launchCards').innerHTML = ''; return; }
    const lanesRM = (S.res.runs.rings || []).filter(r => ZoneEngine.ringArea(r) > 0).map(r => S.eng.riverMile(r[0][0], r[0][1]));
    const cards = S.corr.map(c => {
      const lane = lanesRM.some(rm => rm >= c.rm0 - 0.02 && rm <= c.rm1 + 0.02);
      const d = c.depth, deep = d && d.p50 >= 20, shallow = d && d.min < 6;
      return `<button class="rc ${act}" data-c="${c.label}"><span class="lt">${c.label}</span>` +
        `<b>RM ${c.rm0.toFixed(1)}–${c.rm1.toFixed(1)} · ${fmtFt(c.lengthFt)} ft along the river</b>` +
        `<span class="meta">≈ ${fmtMin(c.lengthFt, SPEED[act])} one way at ${SPEED[act]} mph · ${fmtAc(c.area_ac)} ac · up to ${fmtFt(c.widestFt)} ft wide` +
        (d ? ` · ${Math.round(d.min)}–${Math.round(d.max)} ft deep ${S.params.levelAdjust && S.levelLive ? 'today' : 'at full pool'}` : '') + `</span>` +
        `<span class="badges">${c.turns.length ? `<span class="bdg good">${c.turns.length} U-turn spot${c.turns.length > 1 ? 's' : ''}</span>` : '<span class="bdg warn">no U-turn room</span>'}` +
        (lane ? `<span class="bdg good">${fmtFt(S.params.run.ft)} ft straight lane</span>` : '') +
        (deep ? '<span class="bdg good">mostly 20 ft+ deep</span>' : '') + (shallow ? '<span class="bdg warn">shallow spots</span>' : '') + `</span></button>`;
    });
    box.innerHTML = cards.length ? cards.join('') : `<p class="note">No ${act === 'surf' ? 'surf' : 'towing'} water at these settings.</p>`;
    $$('#runCards .rc').forEach(b => b.onclick = () => {
      const c = S.corr.find(q => q.label === b.dataset.c); if (!c) return;
      const pts = [];
      for (let rm = c.rm0; rm <= c.rm1 + 1e-9; rm += Math.max(0.02, (c.rm1 - c.rm0) / 12)) { const q = S.eng.pointAtMile(rm); if (q) pts.push(ll(q.x, q.y)); }
      if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 17 });
    });
    // markers: a letter per stretch, a U-turn symbol per turnaround basin
    for (const c of S.corr) {
      L.marker(ll(c.center[0], c.center[1]), { keyboard: false, pmIgnore: true, zIndexOffset: 800,
        icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: `<div class="corr-label ${act}">${c.label}</div>` }) })
        .bindTooltip(`Stretch ${c.label}: RM ${c.rm0.toFixed(1)}–${c.rm1.toFixed(1)}, ${fmtFt(c.lengthFt)} ft of continuous ${act === 'surf' ? 'surf' : 'towing'} water`).addTo(L_.corr);
      for (const t of c.turns) L.marker(ll(t.x, t.y), { keyboard: false, pmIgnore: true,
        icon: L.divIcon({ className: '', iconSize: [20, 20], iconAnchor: [10, 10], html: '<div class="turn-mk">⟲</div>' }) })
        .bindTooltip(`U-turn room: ${fmtFt(2 * t.clearFt)} ft across inside the ${act === 'surf' ? 'surf' : 'tow'} zone${t.depthFt != null ? `, ~${Math.round(t.depthFt)} ft deep` : ''} · RM ${t.rm.toFixed(2)}`).addTo(L_.corr);
    }
    // launches: river mile and idle run to the nearest stretch
    const launches = S.fc.features.filter(f => f.properties.tag === 'launch' && f.geometry && f.geometry.type === 'Point' && !f.properties.hidden);
    $('#launchCards').innerHTML = launches.map(f => {
      const [x, y] = utm(f.geometry.coordinates[0], f.geometry.coordinates[1]), rm = S.eng.riverMile(x, y);
      let best = null;
      for (const c of S.corr) { const dmi = rm < c.rm0 ? c.rm0 - rm : rm > c.rm1 ? rm - c.rm1 : 0; if (!best || dmi < best.d) best = { d: dmi, c }; }
      const idle = best ? (best.d < 0.02 ? 'launches right into stretch ' + best.c.label : `≈ ${best.d.toFixed(1)} mi at idle (${Math.max(1, Math.round(best.d / 5 * 60))} min at 5 mph) to stretch ${best.c.label}`) : '';
      return `<button class="rc" data-l="${esc(f.properties.id)}"><span class="lt launch">L</span><b>${esc(f.properties.name || 'Boat launch')}</b>` +
        `<span class="meta">RM ${rm != null ? rm.toFixed(1) : '?'}${idle ? ' · ' + idle : ''}</span>` +
        (f.properties.note ? `<span class="meta">${esc(f.properties.note)}</span>` : '') + '</button>';
    }).join('') || '<p class="note">No launches tagged yet — add them in Edit map.</p>';
    $$('#launchCards .rc').forEach(b => b.onclick = () => {
      const f = featById(b.dataset.l); if (!f) return;
      map.setView([f.geometry.coordinates[1], f.geometry.coordinates[0]], 16);
      featurePopup(f.properties.id, null, false);
    });
  }

  // ============================================================== features
  function tagOf(f) { return S.tags[f.properties.tag] || S.tags.other; }
  function pinIcon(f, sel) {
    const t = tagOf(f), pr = f.properties, dock = pr.tag === 'dock';
    const size = dock ? 13 : 22;
    const cls = `pin t-${pr.tag}${pr.status === 'unreviewed' ? ' unrev' : ''}${sel ? ' sel' : ''}`;
    const label = !dock && pr.name ? `<span class="pin-label">${esc(pr.name)}</span>` : '';
    return L.divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      html: `<div class="${cls}" style="width:${size}px;height:${size}px;background:${t.color}">${dock ? '' : esc(t.glyph || '')}${label}</div>` });
  }
  function featStyle(f) {
    const st = featStyle0(f);
    return S.edit.on && isZoneTag(f.properties.tag) ? Object.assign(st, { fillOpacity: 0.35 }) : st;
  }
  function featStyle0(f) {
    const t = tagOf(f), pr = f.properties;
    if (pr.tag === 'no_wake_zone') return { color: '#8a1630', weight: 1.6, dashArray: pr.status === 'approximate' ? '6 4' : null, fillColor: 'url(#nwzHatch)', fillOpacity: 1 };
    if (pr.tag === 'no_motor_zone') return { color: '#c2185b', weight: 2, dashArray: pr.status === 'approximate' ? '6 4' : null, fillColor: 'url(#nmzHatch)', fillOpacity: 1 };
    if (pr.tag === 'no_entry_zone') return pr.when === 'posted'
      ? { color: '#111111', weight: 1.6, dashArray: '3 5', fillColor: 'url(#nepHatch)', fillOpacity: 1 }
      : { color: '#e00000', weight: 2.4, fillColor: 'url(#nezHatch)', fillOpacity: 1 };
    if (pr.tag === 'safety_boom') return { color: '#e00000', weight: 6, opacity: 1, lineCap: 'butt', dashArray: '12 5' };
    if (pr.tag === 'caution' || pr.tag === 'hazard') return { color: '#ffcc00', weight: 3, dashArray: '8 5', fillColor: 'url(#cauHatch)', fillOpacity: 1 };
    if (pr.tag === 'swim_area') return { color: t.color, weight: 2.5, dashArray: '4 4', fillColor: t.color, fillOpacity: 0.22 };
    if (pr.tag === 'log_boom') return { color: '#7a3d17', weight: 5, opacity: 0.95, lineCap: 'butt', dashArray: '10 3' };
    return { color: t.color, weight: 3, fillColor: t.color, fillOpacity: 0.25 };
  }
  function makeLayer(f) {
    const g = f.geometry; if (!g) return null;
    const pr = f.properties, isSel = S.edit.sel === pr.id;
    let lay;
    if (g.type === 'Point') {
      lay = L.marker([g.coordinates[1], g.coordinates[0]], { icon: pinIcon(f, isSel), draggable: S.edit.on, keyboard: false, pmIgnore: true,
        zIndexOffset: pr.tag === 'dock' ? 0 : 500, riseOnHover: true });
      lay.on('dragend', () => { const p = lay.getLatLng(); mutate(pr.id, ff => { ff.geometry.coordinates = [rnd7(p.lng), rnd7(p.lat)]; }, 'moved'); });
    } else if (g.type === 'LineString') {
      lay = L.polyline(g.coordinates.map(c => [c[1], c[0]]), Object.assign({ renderer: R.feat }, featStyle(f)));
    } else if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      const latlngs = polys.map(p => p.map(r => r.map(c => [c[1], c[0]])));
      lay = L.polygon(g.type === 'Polygon' ? latlngs[0] : latlngs, Object.assign({ renderer: isZoneTag(pr.tag) ? R.nwz : R.feat }, featStyle(f)));
    } else return null;
    lay.featureId = pr.id;
    if (g.type !== 'Point') noTabStop(lay);
    lay.on('click', e => {
      // while drawing a line/area, a click on an existing feature is just another vertex
      if (S.edit.on && (S.edit.mode === 'line' || S.edit.mode === 'area')) return;
      L.DomEvent.stop(e);
      if (!S.edit.on && isZoneTag(pr.tag)) { inspect(e.latlng); return; }
      onFeatureClick(pr.id, e.latlng);
    });
    if (g.type !== 'Point' && !S.edit.on) lay.bindTooltip(esc(pr.name || tagOf(f).label), { sticky: true });
    return lay;
  }
  function groupFor(f) {
    if (f.geometry && f.geometry.type !== 'Point') return L_.featGroup;
    return ['dock', 'shared_dock', 'swim_platform'].includes(f.properties.tag) ? L_.docksGroup : L_.poiGroup;
  }
  function renderFeature(id) {
    const old = featLayers.get(id);
    if (old) { if (old.pm && old.pm.enabled && old.pm.enabled()) old.pm.disable(); old.remove(); featLayers.delete(id); }
    const f = S.fc.features.find(q => q.properties.id === id);
    if (!f || f.properties.hidden || (pending(f) && !S.edit.on)) return;     // not on the public map until confirmed
    let lay = null;
    try { lay = makeLayer(f); if (lay) groupFor(f).addLayer(lay); } catch (e) { console.warn('feature not drawn:', id, e); if (lay) lay.remove(); return; }
    if (!lay) return;
    featLayers.set(id, lay);
  }
  function renderAllFeatures() {
    for (const [, lay] of featLayers) lay.remove();
    featLayers.clear();
    for (const f of S.fc.features) renderFeature(f.properties.id);
    updateTagCounts();
  }
  const rnd7 = v => Math.round(v * 1e7) / 1e7;

  // =========================================================== map clicks
  function onMapClick(e) {
    if (S.edit.on && (S.edit.mode === 'line' || S.edit.mode === 'area')) return;   // the drawing tool owns these clicks
    if (S.edit.on && S.edit.mode === 'pin') { addPin(e.latlng); return; }
    if (S.edit.on && S.edit.sel) { select(null); return; }
    inspect(e.latlng);
  }
  function inspect(latlng) {
    const [x, y] = utm(latlng.lng, latlng.lat);
    const p = engParams();
    if (!S.res) return;
    S.eng.widthField();
    const s = S.eng.sample(x, y, p);
    let html;
    const coords = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
    if (!s.inWater) {
      const zh = S.eng.zoneAt(x, y), inApproach = S.reach.approach && S.eng.pointInPolys(x, y, S.reach.approach.polygons);
      html = zh ? `<div class="pop"><h3>${esc(zoneMsg(zh.type, zh.when))}</h3><div class="k">${esc(zh.name || '')}</div><div class="coords">${coords}</div></div>`
        : `<div class="pop"><h3>${inApproach ? 'No wake — 5 mph' : 'Outside the mapped river'}</h3>` +
          (inApproach && S.cfg.approach ? `<p>${esc(S.cfg.approach.text)}</p>` : '') +
          `<div class="coords">${coords}</div></div>`;
    } else html = readoutHTML(s, p, coords);
    L.popup(popOpts()).setLatLng(latlng).setContent(html).openOn(map);
  }
  function popOpts(o) {
    const sz = map.getSize(), small = sz.x < 600;
    const card = S.review && !$('#reviewcard').hidden ? $('#reviewcard').offsetHeight + 16 : 0;
    return Object.assign({ maxWidth: small ? Math.max(210, sz.x - 110) : 320,
      autoPanPaddingTopLeft: L.point(12, small ? 110 : 64), autoPanPaddingBottomRight: L.point(small ? 60 : 24, 24 + card) }, o || {});
  }
  // Leaflet makes tooltipped SVG paths focusable: keep dozens of off-screen shapes out of the tab order
  function noTabStop(lay) {
    const set = () => { const el = lay.getElement && lay.getElement(); if (el) el.setAttribute('tabindex', '-1'); };
    lay.on('add', set); set();
  }
  function classify(s, p) {
    const R_ = p.rules, struct = s.struct_m != null ? s.struct_m : Infinity;
    const dist = r => Math.min(r.shore ? s.shore_m : Infinity, r.structures ? struct : Infinity);
    const zone = p.zonesOn && s.zone;
    const okD = r => !r.minDepthFt || (s.depth_ft != null && s.depth_ft >= r.minDepthFt);
    const wake = !zone && !p.allNoWake && dist(R_.nowake) >= R_.nowake.ft * FT;
    const tow = wake && dist(R_.tow) >= R_.tow.ft * FT && okD(R_.tow);
    const surf = tow && dist(R_.surf) >= R_.surf.ft * FT && okD(R_.surf);
    return { zone, wake, tow, surf, key: surf ? 'surf' : tow ? 'tow' : wake ? 'cruise' : 'idle', dist };
  }
  function readoutHTML(s, p, coords) {
    const c = classify(s, p), cls = Object.assign({}, S.cfg.classes[c.key], { label: lbl(c.key) });
    const R_ = p.rules, ft = m => fmtFt(m / FT);
    const nearest = s.struct ? S.fc.features.find(f => f.properties.id === s.struct) : null;
    const nlabel = nearest ? (nearest.properties.name || tagOf(nearest).label).toLowerCase() : 'structure';
    const chk = (ok, txt) => `<div class="${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'} ${txt}</div>`;
    let lane = false;
    if (S.res && S.res.runs.rings.length) lane = S.eng.pointInPolys(s.x, s.y, [S.res.runs.rings]);
    const W = s.width_m;
    let pass = '';
    if (W) {
      const n = R_.nowake.ft * FT, sf = R_.surf.ft * FT, ps = p.passFt * FT, T1 = 2 * n + ps, T2 = Math.max(2 * sf, 2 * n + 2 * ps);
      pass = `<div class="k">Channel ≈ <b>${ft(W)} ft</b> wide — ${W >= T2 ? 'room for a surf boat to pass traffic on either side' : W >= T1 ? `two boats can pass ${p.passFt} ft apart` : 'too narrow to pass at speed'}</div>`;
    }
    const zf = c.zone ? featById(s.zone) : null;
    const head = p.allNoWake ? 'ENTIRE RIVER NO-WAKE — high water' : c.zone ? zoneMsg(s.zoneType, s.zoneWhen) : cls.label;
    const tc = towClock(new Date()), night = c.tow && tc && !tc.ok && !p.allNoWake;   // Idaho tow hours (after dark)
    return `<div class="pop"><span class="zone" style="background:${cls.color}33;border-left:4px solid ${cls.color}">${esc(head)}</span>` +
      (zf && zf.properties.name ? `<div class="k">${esc(zf.properties.name)}</div>` : '') +
      (isDefault() ? '' : '<div class="k" style="color:#a35b0b"><b>What-if rules</b> — not the current law</div>') +
      (S.eng.riverMile(s.x, s.y) != null ? `<div class="k">River mile <b>${S.eng.riverMile(s.x, s.y).toFixed(2)}</b> from ${esc(place().riverMileOrigin || 'the start')} (${(S.eng.centerlineLengthMi - S.eng.riverMile(s.x, s.y)).toFixed(2)} from ${esc(place().riverMileEnd || 'the end')})</div>` : '') +
      `<div class="k">Shore <b>${ft(s.shore_m)} ft</b>` + (s.struct_m != null && s.struct_m < 600 ? ` · nearest ${esc(nlabel)} <b>${ft(s.struct_m)} ft</b>` : '') + '</div>' +
      (s.depth_ft != null ? `<div class="k">Depth ≈ <b>${Math.round(s.depth_ft)} ft</b> ${p.levelOffsetFt ? `today (charted ${Math.round(s.depth_full_pool_ft)} ft at full pool)` : 'at full pool'} · 2004 survey, screening only</div>` : '') + pass +
      `<div class="checks">` +
      chk(c.wake, `Outside the ${R_.nowake.ft}-ft no-wake band${c.zone ? ' — but inside a designated zone' : ` (${ft(c.dist(R_.nowake))} ft here)`}`) +
      chk(c.tow, `Outside the ${R_.tow.ft}-ft no-tow setback (county; surfing: interpretation)`) +
      chk(c.surf, `Meets the ${R_.surf.ft}-ft surf guideline (WSIA/IDPR, not law)`) +
      (night ? chk(false, `Towing hours: ${esc(tc.text.toLowerCase())} (${esc(S.cfg.towHours.citation || 'state law')})`) : '') +
      (lane ? chk(true, `On a straight lane ≥ ${fmtFt(p.run.ft)} ft`) : '') +
      `</div><div class="coords">${coords} <a href="#" onclick="navigator.clipboard&&navigator.clipboard.writeText('${coords}');this.textContent='copied';return false">copy</a></div></div>`;
  }

  // ============================================================ stats/legend
  function pct(a, b) { return b ? Math.round(100 * a / b) : 0; }
  function delta(el, now, then, unit) {
    const e = $(el); if (!e) return;
    if (then == null || isDefault()) { e.textContent = ''; e.className = ''; return; }
    const d = now - then;
    if (Math.abs(d) < 0.5) { e.textContent = '±0'; e.className = ''; return; }
    e.textContent = (d > 0 ? '+' : '−') + fmtAc(Math.abs(d)) + (unit || '');
    e.className = d > 0 ? 'up' : 'down';
  }
  function renderStats() {
    const s = S.res.stats, b = S.baseRes && S.baseRes.stats, p = S.params;
    $('#stTow').textContent = fmtAc(s.tow_ok_ac);
    $('#stTowL').textContent = `acres in the tow zone (${p.rules.tow.ft} ft+)`;
    $('#stSurfL').textContent = `acres also meeting the ${p.rules.surf.ft}-ft surf guideline`;
    $('#stSurf').textContent = fmtAc(s.surf_ok_ac);
    $('#stIdle').textContent = fmtAc(s.idle_ac);
    $('#stRuns').textContent = s.run_zones;
    $('#stRunsL').textContent = `${S.view === 'surf' ? 'surf' : 'straight'} lanes ≥ ${fmtFt(p.run.ft)} ft` + (s.longest_run_ft ? ` · longest ${fmtFt(s.longest_run_ft)} ft` : '');
    delta('#dTow', s.tow_ok_ac, b && b.tow_ok_ac); delta('#dSurf', s.surf_ok_ac, b && b.surf_ok_ac); delta('#dIdle', s.idle_ac, b && b.idle_ac);
    const dr = $('#dRuns');
    if (b && !isDefault()) { const d = s.run_zones - b.run_zones; dr.textContent = d ? (d > 0 ? '+' : '−') + Math.abs(d) : '±0'; dr.className = d > 0 ? 'up' : d < 0 ? 'down' : ''; } else { dr.textContent = ''; dr.className = ''; }
    $('#whatif').hidden = isDefault();
    const W = s.water_ac;
    $('#headline').innerHTML = S.highWater ? `<b>High water: the entire river is no-wake</b> until the lake drops below ${S.cfg.highWater.elevFt.toLocaleString()} ft.` :
      `The tow zone — ${p.rules.tow.ft} ft or more from shore${p.rules.tow.structures ? ' and docks' : ''} — covers <b>${fmtAc(s.tow_ok_ac)} of ${fmtAc(W)} acres</b> (${pct(s.tow_ok_ac, W)}%) of this reach. ` +
      `<b>${fmtAc(s.surf_ok_ac)} acres</b> also meet the ${p.rules.surf.ft}-ft surf guideline, and there ${s.run_zones === 1 ? 'is' : 'are'} <b>${s.run_zones}</b> straight lane${s.run_zones === 1 ? '' : 's'} of ${fmtFt(p.run.ft)} ft or more.`;
    const st = $('#stack');
    st.innerHTML = ['idle', 'cruise', 'tow', 'surf'].map(k => {
      const v = s[k + '_ac'];
      const nm = { idle: 'No wake', cruise: 'Wake OK, no towing', tow: `Tow zone ${p.rules.tow.ft}–${p.rules.surf.ft} ft`, surf: `Tow zone + ${p.rules.surf.ft}-ft surf guideline` }[k];
      return `<i style="width:${(100 * v / W).toFixed(2)}%;background:${S.cfg.classes[k].color}" title="${esc(nm)}: ${fmtAc(v)} ac (${pct(v, W)}%)"></i>`;
    }).join('');
    const docks = S.fc.features.filter(f => isStructure(f) && !f.properties.hidden && !pending(f)).length;
    const waiting = S.fc.features.filter(pending).length;
    S.dockReview = waiting ? `; ${waiting} imported or auto-detected feature${waiting === 1 ? '' : 's'} not counted until reviewed` : '';
    const R_ = p.rules;
    // the reference model (config.compare, e.g. a shore-only GIS draft) buffers the shoreline only, with no zones:
    // show that number beside ours so the two models reconcile at a glance
    const key = JSON.stringify([R_.tow.ft, R_.nowake.ft, R_.surf.ft, p.run]);
    if (S.shoreKey !== key) {
      clearTimeout(S.shoreTimer);
      S.shoreTimer = setTimeout(() => {
        const so = r => Object.assign({}, r, { structures: false, shore: true, minDepthFt: 0 });
        S.shoreOnly = S.eng.compute({ rules: { nowake: so(R_.nowake), tow: so(R_.tow), surf: so(R_.surf) }, zonesOn: false, passFt: p.passFt,
          run: Object.assign({ activity: 'tow' }, p.run) }).stats;
        S.shoreKey = key;
        if (S.res) renderStats();
      }, 350);
    }
    const so = S.shoreKey === key ? S.shoreOnly : null;
    const hwc = S.cfg.highWater, cmp = S.cfg.compare;
    $('#heroFine').innerHTML = (S.levelLive === false && S.condLoaded && hwc ? `<b>Live lake level unavailable — the river-wide no-wake trigger (${hwc.elevFt.toLocaleString()} ft) can't be checked.</b> ` : '') +
      (R_.tow.structures ? `Measured from the shoreline and <b>${docks}</b> mapped docks &amp; structures${S.dockReview}, ` : 'Measured from the shoreline only, ') +
      `with the designated zones — no-wake, no-motor, no-entry (${fmtAc(s.zone_ac)} ac). ` +
      (so ? `Shore-only with no zones${cmp ? ` — ${esc(cmp.method)}` : ''} — the ${R_.tow.ft} ft rule leaves <b>${fmtAc(so.tow_ok_ac)} ac</b>` +
        (cmp && R_.tow.ft === cmp.towFt ? ` (${esc(cmp.label)}: ${cmp.towAc} ac)` : '') + ` and ${so.run_zones} lane${so.run_zones === 1 ? '' : 's'}.` : 'Working out the shore-only comparison…') +
      (S.levelOffsetFt && p.levelAdjust && (R_.surf.minDepthFt || R_.tow.minDepthFt) ? ` Depths use today's lake level.` : '');
  }
  function renderLegend() {
    const c = S.cfg.classes, v = S.view, p = S.params, R_ = p.rules;
    const row = (sw, t, sub) => `<div class="row">${sw}<div>${t}${sub ? `<small>${sub}</small>` : ''}</div></div>`;
    const sq = col => `<span class="sw" style="background:${col}"></span>`;
    const lane = `<span class="sw" style="border:2px dashed ${c.runs.color};background:${c.runs.color}29"></span>`;
    const nwz = '<span class="sw hatch"></span>';
    const dot = col => `<span class="sw dot" style="background:${col}"></span>`;
    let html = '';
    if (v === 'bottom' || v === 'surf') {
      html = row(sq(c.idle.color), lbl('idle'), `within ${R_.nowake.ft} ft of shore${R_.nowake.structures ? ' or a dock' : ''}`) +
        row(sq(c.cruise.color), lbl('cruise'), `${R_.nowake.ft}–${R_.tow.ft} ft: no skiing, tubing or surfing`) +
        row(sq(c.tow.color), lbl('tow'), `${R_.tow.ft} ft+ from shore${R_.tow.structures ? ' and docks' : ''} (county) — purple water is tow zone too`) +
        row(sq(c.surf.color), lbl('surf'), `${R_.surf.ft} ft+ (WSIA / IDPR guideline, not law)${R_.surf.minDepthFt ? `, ${R_.surf.minDepthFt} ft+ deep` : ''}`) +
        row(lane, `${v === 'surf' ? 'Surf' : 'Straight'} lane ≥ ${fmtFt(p.run.ft)} ft`, `${fmtFt(p.run.laneFt)} ft wide; white dashes = longest`) +
        row(nwz, 'Designated no-wake zone', '5 mph, no wake (wake under 4 in)') +
        row('<span class="sw hatch-nm"></span>', 'No motors', esc(place().noMotorExamples || 'paddle or sail only')) +
        row('<span class="sw hatch-ne"></span>', 'No entry — dam', 'keep out; dotted = closed when posted') +
        row('<span class="sw line" style="background:#e00000;height:.35rem"></span>', 'Dam safety boom', 'never cross') +
        row('<span class="sw" style="background:repeating-linear-gradient(-45deg,#111 0 3px,rgba(255,255,255,.55) 3px 7px)"></span>', `Under ${S.cfg.depth.shallowFt || 5} ft deep ${S.params.levelAdjust && S.levelLive ? 'today' : 'at full pool'}`, 'shallow water where you could otherwise make a wake') +
        (v === 'surf' ? row('<span class="sw line" style="background:repeating-linear-gradient(90deg,#9fe7ff 0 3px,transparent 3px 8px)"></span>', `${S.cfg.depth.surfLineFt || 10} ft depth line (today)`, 'deeper water is inside it — industry surf-depth guidance (WSIA/NMMA)') : '');
    } else if (v === 'pass') {
      const r = S.res.width;
      html = row(sq(c.narrow.color), lbl('narrow'), r ? `under ${fmtFt(r.T1ft)} ft wide` : '') +
        row(sq(c.twoway.color), lbl('twoway'), r ? `${fmtFt(r.T1ft)}–${fmtFt(r.T2ft)} ft wide` : '') +
        row(sq(c.surfpass.color), lbl('surfpass'), r ? `${fmtFt(r.T2ft)} ft+ wide` : '') +
        row(nwz, 'Designated zone', 'no wake, no motors or no entry') +
        `<small class="more" style="display:block;color:#5d7182;margin-top:.3rem">Width is measured between shore and dock tips. Two boats ${p.passFt} ft apart, each ${R_.nowake.ft} ft off shore, need ${fmtFt(2 * R_.nowake.ft + p.passFt)} ft.</small>`;
    } else if (v === 'depth') {
      const d = S.cfg.depth;
      html = d.labels.map((t, i) => row(sq(d.colors[i]), t)).join('') +
        row('<span class="sw line" style="background:repeating-linear-gradient(90deg,#9fe7ff 0 3px,transparent 3px 8px)"></span>', `${d.surfLineFt || 10} ft line (surf-depth guidance)`) +
        `<small class="more" style="display:block;color:#5d7182;margin-top:.3rem">${S.params.levelAdjust && S.levelLive ? `Lake is ${S.levelOffsetFt.toFixed(1)} ft ${S.levelOffsetFt >= 0 ? 'below' : 'above'} full pool today — depths adjusted.` : 'Depths at summer full pool (2,128 ft).'} From 5-ft contours; screening only.</small>`;
    } else if (v === 'rule') {
      const r = R_[S.single], cr = S.cfg.rules[S.single];
      html = row(sq('#2bb673'), `Clear of the ${esc(cr.short || cr.label)} alone (${r.ft} ft)`) +
        row(sq('#d7263d'), `Inside that ${r.ft} ft buffer`) +
        `<small class="more" style="display:block;color:#5d7182;margin-top:.3rem">One rule at a time, ignoring the others and the designated zones.</small>`;
    }
    html += row(dot(S.tags.dock.color), 'Dock', S.edit.on ? 'dashed ring = auto-detected, not counted until reviewed' : 'counts as a structure');
    if (v === 'bottom' || v === 'surf') {     // the map's other symbols
      const pin = id => { const t = S.tags[id] || S.tags.other; return `<span class="sw lsym" style="background:${t.color}">${esc(t.glyph || '')}</span>`; };
      html += row('<span class="sw lsym sq">A</span>', 'Run stretch', 'lettered in Plan a run') +
        row('<span class="sw lsym turn">⟲</span>', 'U-turn room', `${S.turnFt} ft across, inside the water you chose`) +
        row(pin('hazard'), S.tags.hazard.label) + row(pin('launch'), S.tags.launch.label) +
        row('<span class="sw lsym rm">RM</span>', 'River mile', `counted upstream from ${esc(place().riverMileOrigin || 'the start')}`);
    }
    const min = $('#legend').classList.contains('min');
    if (min) {     // compact strip of short labels — the full legend is one tap away
      const chips = [];
      const add = (sw, t) => chips.push(`<span class="lchip">${sw}${t}</span>`);
      if (v === 'bottom' || v === 'surf') {
        add(sq(c.idle.color), 'No wake'); add(sq(c.cruise.color), 'No tow'); add(sq(c.tow.color), 'Tow zone');
        add(sq(c.surf.color), `Surf ${R_.surf.ft}+`); add(lane, 'Lane'); add(nwz, 'Zone');
      } else if (v === 'pass') { add(sq(c.narrow.color), 'Narrow'); add(sq(c.twoway.color), 'Two-way'); add(sq(c.surfpass.color), 'Surf-pass'); add(nwz, 'Zone'); }
      else if (v === 'depth') S.cfg.depth.labels.forEach((t, i) => add(sq(S.cfg.depth.colors[i]), t.replace(' ft', '').replace('under ', '<')));
      else if (v === 'rule') { add(sq('#2bb673'), 'Allowed'); add(sq('#d7263d'), 'Inside buffer'); }
      $('#legend').innerHTML = `<div class="lstrip">${chips.join('')}<button id="legTog" aria-label="Show the full legend" aria-expanded="false">more</button></div>`;
      $('#legTog').onclick = () => { $('#legend').classList.toggle('min'); renderLegend(); };
      return;
    }
    $('#legend').innerHTML = `<h4><span>${{ bottom: 'Where to boat', surf: 'Wake surf', pass: 'Room to pass', depth: 'Depth', rule: 'One rule' }[v]}</span><button id="legTog" aria-expanded="true">${min ? 'more' : 'less'}</button></h4>` +
      `<small class="more" style="display:block;color:#5d7182;margin:-.15rem 0 .3rem">Tap anywhere for the rules at that spot.</small><div class="rows">${html}</div>`;
    $('#legTog').onclick = () => { $('#legend').classList.toggle('min'); renderLegend(); };
  }
  function renderWaterfall() {
    const s = S.res.stats, W = s.water_ac, p = S.params, R_ = p.rules;
    const afterZones = W - s.zone_ac;
    const rows = [
      ['Whole reach', 0, W, '#7f93a3'],
      ['Designated zones', afterZones, W, S.cfg.classes.nwz.color],
      [S.highWater ? 'River-wide no-wake (high water)' : `${R_.nowake.ft}-ft no-wake (county)`, s.wake_ok_ac, afterZones, S.cfg.classes.idle.color],
      [`${R_.tow.ft}-ft no-tow (county)`, s.tow_ok_ac, s.wake_ok_ac, S.cfg.classes.cruise.color],
      [`${R_.surf.ft}-ft surf guideline`, s.surf_ok_ac, s.tow_ok_ac, S.cfg.classes.tow.color],
    ];
    $('#waterfall').innerHTML = rows.map(([k, lo, hi, col], i) => {
      const left = i === 0 ? 0 : 100 * lo / W, width = 100 * (hi - lo) / W;
      const v = i === 0 ? fmtAc(W) + ' ac' : '−' + fmtAc(hi - lo);
      return `<div class="wf"><span class="k" title="${esc(k)}">${esc(k)}</span><span class="bar"><i style="left:${left}%;width:${width}%;background:${col}"></i></span><span class="v">${v}</span></div>`;
    }).join('') + `<div class="wf"><span class="k"><b>Also meets ${R_.surf.ft}-ft surf guideline</b></span><span class="bar"><i style="left:0;width:${100 * s.surf_ok_ac / W}%;background:${S.cfg.classes.surf.color}"></i></span><span class="v">${fmtAc(s.surf_ok_ac)} ac</span></div>`;
  }

  // =========================================================== rule controls
  function buildRuleControls() {
    const box = $('#ruleCtl'), r = S.cfg.rules;
    const block = (key, opts) => {
      const c = r[key];
      const from = opts.from ? `<div class="rule-from"><label><input type="checkbox" data-k="${key}" data-f="shore"> from shore</label>` +
        `<label><input type="checkbox" data-k="${key}" data-f="structures"> from docks &amp; structures</label></div>` : '';
      const depth = opts.depth ? `<div class="rule-val"><span class="unit" style="min-width:7.2rem">only where ≥</span><input type="range" min="0" max="30" step="1" data-k="${key}" data-f="minDepthFt" aria-label="${esc(c.label)} minimum depth">` +
        `<input class="num" type="number" min="0" max="60" step="1" data-k="${key}" data-f="minDepthFt" aria-label="${esc(c.label)} minimum depth (ft)"><span class="unit">ft deep</span></div>` : '';
      return `<div class="rule" data-rule="${key}"><div class="rule-top"><b>${esc(opts.title || c.label)}</b><span class="who">${esc(c.who)} · now ${c.ft} ft</span></div>` +
        `<div class="rule-val"><input type="range" min="${c.min}" max="${c.max}" step="${c.step}" data-k="${key}" data-f="ft" aria-label="${esc(c.label)} distance">` +
        `<input class="num" type="number" min="${c.min}" max="${c.max * 2}" step="${c.step}" data-k="${key}" data-f="ft" aria-label="${esc(c.label)} distance (ft)"><span class="unit">ft</span></div>${from}${depth}</div>`;
    };
    box.innerHTML = block('nowake', { from: true, title: 'No wake within' }) + block('tow', { from: true, title: 'No towing within' }) +
      block('surf', { from: true, depth: true, title: 'Wake-surf guideline' }) + block('pass', { title: 'Passing separation' }) +
      `<div class="rule" data-rule="run"><div class="rule-top"><b>Straight lanes</b><span class="who">HLWID spec · ${fmtFt(r.run.ft)} ft</span></div>` +
      `<div class="rule-val"><span class="unit" style="min-width:3rem">length</span><input type="range" min="0" max="${r.run.max}" step="${r.run.step}" data-k="run" data-f="ft" aria-label="Lane length">` +
      `<input class="num" type="number" min="0" max="20000" step="50" data-k="run" data-f="ft" aria-label="Lane length (ft)"><span class="unit">ft</span></div>` +
      `<div class="rule-val"><span class="unit" style="min-width:3rem">width</span><input type="range" min="0" max="300" step="5" data-k="run" data-f="laneFt" aria-label="Lane width">` +
      `<input class="num" type="number" min="0" max="600" step="5" data-k="run" data-f="laneFt" aria-label="Lane width (ft)"><span class="unit">ft</span></div></div>`;
    $$('#ruleCtl input').forEach(inp => {
      const ev = inp.type === 'checkbox' ? 'change' : 'input';
      inp.addEventListener(ev, () => {
        const k = inp.dataset.k, f = inp.dataset.f;
        const tgt = k === 'pass' ? null : k === 'run' ? S.params.run : S.params.rules[k];
        let v = inp.type === 'checkbox' ? inp.checked : parseFloat(inp.value);
        if (inp.type !== 'checkbox' && !Number.isFinite(v)) return;
        if (inp.type !== 'checkbox') v = Math.max(0, inp.max !== '' ? Math.min(+inp.max, v) : v);
        if (k === 'pass') S.params.passFt = v; else tgt[f] = v;
        syncRuleControls(inp);
        schedule(140);
      });
    });
    syncRuleControls();
  }
  // one-click scenarios for the "what if" conversation
  function presetParams(id) {
    const p = clone(S.defaults), R_ = p.rules;
    if (id === 'arcgis') { for (const k of ['nowake', 'tow', 'surf']) R_[k].structures = false; p.zonesOn = false; }
    else if (id === 'county200') R_.tow.ft = 200;
    else if (id === 'surf10') R_.surf.minDepthFt = 10;
    else if (id === 'surf20') R_.surf.minDepthFt = 20;
    else if (id === 'vermont') { R_.surf.ft = 500; R_.surf.minDepthFt = 20; p.run.ft = 3000; p.run.laneFt = 200; }
    return p;
  }
  function buildPresets() {
    $('#presets').innerHTML = (S.cfg.presets || []).map(q => `<button class="pre" data-pre="${q.id}" title="${esc(q.desc)}">${esc(q.label)}</button>`).join('');
    $$('#presets .pre').forEach(b => b.onclick = () => {
      S.params = presetParams(b.dataset.pre);
      syncRuleControls();
      if (['vermont', 'surf10', 'surf20'].includes(b.dataset.pre) && S.view !== 'surf') setView('surf'); else schedule(10);
    });
  }
  function markPreset() {
    const cur = JSON.stringify(S.params);
    $$('#presets .pre').forEach(b => b.classList.toggle('on', JSON.stringify(presetParams(b.dataset.pre)) === cur));
  }
  function syncRuleControls(except) {
    $$('#ruleCtl input').forEach(inp => {
      if (inp === except) return;
      const k = inp.dataset.k, f = inp.dataset.f;
      const v = k === 'pass' ? S.params.passFt : k === 'run' ? S.params.run[f] : S.params.rules[k][f];
      if (inp.type === 'checkbox') inp.checked = !!v; else inp.value = v;
    });
    $$('#ruleCtl .rule').forEach(div => {
      const k = div.dataset.rule;
      const a = k === 'pass' ? S.params.passFt : k === 'run' ? S.params.run : S.params.rules[k];
      const b = k === 'pass' ? S.defaults.passFt : k === 'run' ? S.defaults.run : S.defaults.rules[k];
      div.classList.toggle('changed', JSON.stringify(a) !== JSON.stringify(b));
    });
    $('#optZones').checked = S.params.zonesOn;
    $('#optLevel').checked = S.params.levelAdjust;
    markPreset();
  }

  // ==================================================================== editor
  function buildPalette() {
    const order = ['dock', 'shared_dock', 'marina', 'public_dock', 'launch', 'fuel', 'log_boom', 'swim_area', 'swim_platform', 'buoy', 'hazard', 'caution',
      'no_wake_zone', 'no_motor_zone', 'no_entry_zone', 'safety_boom', 'park', 'beach', 'restroom', 'services', 'bridge', 'dam', 'gauge', 'landmark', 'other'];
    $('#palette').innerHTML = order.filter(id => S.tags[id]).map(id => {
      const t = S.tags[id];
      return `<button class="ptag${id === S.edit.tag ? ' on' : ''}" data-tag="${id}" title="${esc(t.label)}${t.structure ? ' — counts as a structure for distance rules' : ''}">` +
        `<span class="g" style="background:${t.color}">${esc(t.glyph || '')}</span><span class="nm">${esc(t.label)}</span>${t.structure ? '<span class="st">rule</span>' : ''}</button>`;
    }).join('');
    $$('#palette .ptag').forEach(b => b.onclick = () => {
      S.edit.tag = b.dataset.tag;
      $$('#palette .ptag').forEach(x => x.classList.toggle('on', x === b));
      const geom = S.tags[S.edit.tag].geom;
      if (S.edit.on && S.edit.mode === 'pin' && geom === 'line') startDraw('line');
      else if (S.edit.on && S.edit.mode === 'pin' && geom === 'area') startDraw('area');
      if (!S.edit.on) { setEdit(true); }
      if (S.edit.mode === 'select') { setMode(geom === 'line' ? 'line' : geom === 'area' ? 'area' : 'pin'); }
    });
  }
  function setEdit(on) {
    S.edit.on = on;
    $('#editMode').checked = on;
    const eb = $('#editBtn'); if (eb) eb.classList.toggle('on', on);
    if (!on) { setMode('select'); select(null); stopReview(); }
    map.getContainer().style.cursor = '';
    // rebuild every layer: markers become draggable or not, tooltips come and go, and
    // unreviewed candidates show only while editing
    renderAllFeatures();
    if (S.res) renderLegend();
    if (on) { switchTab('tEdit'); map.closePopup(); }
    updateEditState();
  }
  function setMode(mode) {
    S.edit.mode = mode;
    $('#addPin').classList.toggle('on', mode === 'pin');
    $('#addLine').classList.toggle('on', mode === 'line');
    $('#addArea').classList.toggle('on', mode === 'area');
    map.getContainer().style.cursor = mode === 'pin' ? 'crosshair' : '';
    const hint = $('#drawhint');
    if (map.pm) map.pm.disableDraw();
    if (mode === 'pin') {
      const st = S.tags[S.edit.tag];
      hint.hidden = false;
      hint.innerHTML = `Click the map to drop a <b>${esc(st.label.toLowerCase())}</b>` +
        (st.structure ? ' at its outer (waterward) end — setbacks are measured from the nearest part of a structure; trace long docks with ＋ Line' : '') +
        `. <button class="btn" id="hintDone">Done</button>`;
    }
    else if (mode === 'line' || mode === 'area') {
      hint.hidden = false;
      hint.innerHTML = `Click to draw the ${mode === 'line' ? 'line' : 'area'} for a <b>${esc(S.tags[S.edit.tag].label.toLowerCase())}</b>; click the ${mode === 'line' ? 'last point again' : 'first point'} to finish. <button class="btn" id="hintDone">Cancel</button>`;
    } else hint.hidden = true;
    const hd = $('#hintDone'); if (hd) hd.onclick = () => setMode('select');
    if ((mode === 'line' || mode === 'area') && map.pm) {
      const t = S.tags[S.edit.tag];
      map.pm.enableDraw(mode === 'line' ? 'Line' : 'Polygon', { snappable: false, finishOn: null, continueDrawing: false,
        templineStyle: { color: t.color === '#ffffff' ? '#ffde59' : t.color, weight: 3 }, hintlineStyle: { color: '#ffffff', dashArray: '4 6' },
        pathOptions: { color: t.color, weight: 3 } });
    } else if ((mode === 'line' || mode === 'area') && !map.pm) {
      editMsg('Drawing tools did not load — reload the page to draw lines and areas.'); S.edit.mode = 'select';
    }
  }
  function startDraw(kind) { setMode(kind); }
  function onDrawCreate(e) {
    const gj = e.layer.toGeoJSON();
    map.removeLayer(e.layer);
    const tag = S.edit.tag;
    const t = S.tags[tag];
    let geom = gj.geometry;
    if (geom.type === 'Polygon' && t.geom === 'line') geom = { type: 'LineString', coordinates: geom.coordinates[0] };
    geom = roundGeom(geom);
    const id = newId();
    pushHistory();
    S.fc.features.push({ type: 'Feature', id, properties: { id, tag, name: '', status: 'confirmed', source: 'manual', updated: today() }, geometry: geom });
    afterMutation([id], true);
    setMode('select');
    select(id);
  }
  function roundGeom(g) {
    const r = c => [rnd7(c[0]), rnd7(c[1])];
    if (g.type === 'Point') return { type: 'Point', coordinates: r(g.coordinates) };
    if (g.type === 'LineString') return { type: 'LineString', coordinates: g.coordinates.map(r) };
    if (g.type === 'Polygon') return { type: 'Polygon', coordinates: g.coordinates.map(ring => ring.map(r)) };
    if (g.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: g.coordinates.map(p => p.map(ring => ring.map(r))) };
    return g;
  }
  function newId() { return 'm-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36); }
  function today() { return ZoneExport.localDate(undefined, place().timeZone); }   // the river's date, not UTC
  const clean = v => String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').trim();
  const lbl = key => ZoneExport.label(S.cfg, key, S.params);
  function addPin(latlng) {
    const tag = S.edit.tag, t = S.tags[tag];
    if (t.geom === 'line' || t.geom === 'area') { setMode(t.geom); return; }
    const id = newId();
    pushHistory();
    S.fc.features.push({ type: 'Feature', id, properties: { id, tag, name: '', status: 'confirmed', source: 'manual', updated: today() },
      geometry: { type: 'Point', coordinates: [rnd7(latlng.lng), rnd7(latlng.lat)] } });
    afterMutation([id], isStructureTag(tag));
    editMsg(`${t.label} added — drag to adjust, click it to tag or name it.`);
  }
  function isStructureTag(tag) { return !!(S.tags[tag] && S.tags[tag].structure) || isZoneTag(tag); }
  function featById(id) { return S.fc.features.find(f => f.properties.id === id); }
  // apply fn to one feature, then re-render/recompute as needed
  function mutate(id, fn, what) {
    const f = featById(id); if (!f) return;
    const sig0 = ruleSig(f), wasLaunch = f.properties.tag === 'launch';
    pushHistory();
    fn(f);
    f.properties.updated = today();
    if (what === 'moved' && f.properties.status === 'unreviewed') f.properties.status = 'confirmed';
    afterMutation([id], ruleSig(f) !== sig0, wasLaunch || f.properties.tag === 'launch');
  }
  function removeFeature(id) {
    const i = S.fc.features.findIndex(f => f.properties.id === id); if (i < 0) return;
    const f = S.fc.features[i], wasRule = countsForRules(f);
    pushHistory();
    S.fc.features.splice(i, 1);
    if (S.edit.sel === id) S.edit.sel = null;
    map.closePopup();
    afterMutation([id], wasRule, f.properties.tag === 'launch');
  }
  function afterMutation(ids, ruleChange, launchChange) {
    for (const id of ids) renderFeature(id);
    if (S.edit.sel) highlightSel();
    saveLocal();
    updateTagCounts(); updateEditState();
    if (ruleChange) { syncEngine(); schedule(30); }
    else if (launchChange) renderRuns();
  }
  function pushHistory() {
    S.hist.push(JSON.stringify(S.fc));
    let total = S.hist.reduce((a, h) => a + h.length, 0);
    while (S.hist.length > 1 && (S.hist.length > 80 || total > 25e6)) total -= S.hist.shift().length;   // ≤ 80 steps, ~25 MB
    S.fut.length = 0;
  }
  function undo() {
    if (!S.hist.length) { editMsg('Nothing to undo'); return; }
    S.fut.push(JSON.stringify(S.fc)); S.fc = JSON.parse(S.hist.pop());
    restoreAll('Undone');
  }
  function redo() {
    if (!S.fut.length) { editMsg('Nothing to redo'); return; }
    S.hist.push(JSON.stringify(S.fc)); S.fc = JSON.parse(S.fut.pop());
    restoreAll('Redone');
  }
  function restoreAll(msg) {
    S.edit.sel = null; map.closePopup();
    renderAllFeatures(); saveLocal(); updateEditState(); syncEngine(); schedule(20);
    if (S.review) showReview();
    editMsg(msg);
  }
  let saveTimer = null;
  function saveLocal() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const cur = lsGet(LS.feats);
      if (S.staleTab || (cur && (cur.rev || 0) > S.rev)) { otherTabSaved(); return; }
      if (JSON.stringify(S.fc) === JSON.stringify(S.base)) { lsDel(LS.feats); S.rev = 0; updateEditState(); return; }
      S.saveFailed = !lsSet(LS.feats, { baseSig: S.baseSig, saved: new Date().toISOString(), rev: S.rev + 1, fc: S.fc });
      if (!S.saveFailed) S.rev++;
      updateEditState();
    }, 250);
  }
  // another tab saved (or discarded) edits: pause saving here so neither overwrites the other
  function otherTabSaved() {
    S.staleTab = true;
    const box = $('#editState');
    box.classList.add('dirty');
    box.innerHTML = '<b>These edits were changed in another tab.</b> Saving here is paused so neither tab overwrites the other — ' +
      'reload to continue with the other tab\'s edits, or export this tab\'s first. <button class="btn" id="reloadEdits">Reload</button>';
    $('#reloadEdits').onclick = () => location.reload();
  }
  function diffCount() {
    const a = new Map(S.base.features.map(f => [f.properties.id, JSON.stringify(f)]));
    let add = 0, mod = 0, del = 0;
    const seen = new Set();
    for (const f of S.fc.features) {
      const id = f.properties.id; seen.add(id);
      if (!a.has(id)) add++; else if (a.get(id) !== JSON.stringify(f)) mod++;
    }
    for (const id of a.keys()) if (!seen.has(id)) del++;
    return { add, mod, del, n: add + mod + del };
  }
  function updateEditState() {
    if (S.staleTab) { otherTabSaved(); return; }
    const d = diffCount(), box = $('#editState');
    const rev = S.fc.features.filter(needsReview).length;
    box.classList.toggle('dirty', d.n > 0);
    box.classList.toggle('unsaved', !!(S.saveFailed && d.n));
    box.innerHTML = !d.n ? 'No changes yet — you\'re looking at the published map.'
      : `<b>${d.n} change${d.n === 1 ? '' : 's'}</b> since the published map (${d.add} added, ${d.mod} edited, ${d.del} removed) — ` +
        (S.saveFailed ? '<b>NOT saved in this browser</b> (storage full, blocked or private mode). Export features.geojson now to keep them.' : 'saved in this browser. Export to publish.');
    $('#reviewNote').firstChild && ($('#startReview').textContent = rev ? `Start review (${rev} waiting)` : 'Start review');
  }
  function updateTagCounts() {
    const c = {};
    for (const f of S.fc.features) c[f.properties.tag] = (c[f.properties.tag] || 0) + 1;
    const unrev = S.fc.features.filter(f => f.properties.status === 'unreviewed').length;
    $('#tagCounts').innerHTML = Object.entries(c).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<span><b>${v}</b> ${esc((S.tags[k] || S.tags.other).label.toLowerCase())}</span>`).join('') +
      (unrev ? `<span><b>${unrev}</b> unreviewed</span>` : '');
  }
  function editMsg(m) { const e = $('#editMsg'); e.textContent = m; clearTimeout(editMsg.t); editMsg.t = setTimeout(() => { if (e.textContent === m) e.textContent = ''; }, 5000); }

  // ---- selection & the feature form -------------------------------------------
  function onFeatureClick(id, latlng) {
    if (S.edit.on && S.edit.mode === 'pin') { addPin(latlng); return; }
    if (!S.edit.on) { featurePopup(id, latlng, false); return; }
    select(id);
    featurePopup(id, latlng, true);
  }
  function select(id) {
    const prev = S.edit.sel;
    S.edit.sel = id;
    if (prev && prev !== id) {
      const lay = featLayers.get(prev);
      if (lay && lay.pm && lay.pm.enabled && lay.pm.enabled()) lay.pm.disable();
      renderFeature(prev);
    }
    if (!id) { map.closePopup(); return; }
    highlightSel();
  }
  function highlightSel() {
    const id = S.edit.sel, f = featById(id), lay = featLayers.get(id);
    if (!f || !lay) return;
    if (f.geometry.type === 'Point') { lay.setIcon(pinIcon(f, true)); return; }
    if (lay.pm && !lay.pm.enabled()) {
      lay.pm.enable({ allowSelfIntersection: true, snappable: false, draggable: false });
      const commit = () => {
        const g = roundGeom(lay.toGeoJSON().geometry);
        const ff = featById(id); if (!ff) return;
        if (ff.geometry.type === 'LineString' && g.type !== 'LineString') return;
        mutate(id, q => { q.geometry = g; }, 'reshaped');
      };
      lay.on('pm:edit', commit);
    }
  }
  function featurePopup(id, latlng, editable) {
    const f = featById(id); if (!f) return;
    const pr = f.properties, t = tagOf(f);
    const at = latlng || (f.geometry.type === 'Point' ? L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]) : featLayers.get(id).getBounds().getCenter());
    const ruleNote = pending(f) && (isStructure(f) || isZoneTag(pr.tag)) ? `${pr.status === 'imported' ? 'Imported' : 'Auto-detected'} — not counted until someone confirms it in Review.`
      : isStructure(f) ? `Counts as a structure: no wake within ${S.params.rules.nowake.ft} ft, no towing within ${S.params.rules.tow.ft} ft.`
      : isZoneTag(pr.tag) ? zoneMsgOf(f).replace(/ — .*/, '') + ' — applies anywhere inside.' : pr.tag === 'safety_boom' ? 'Never cross. No entry on the dam side.' : 'Information only — not used in the distance rules.';
    if (!editable) {
      L.popup(popOpts({ maxWidth: 300 })).setLatLng(at).setContent(`<div class="pop"><h3>${esc(pr.name || t.label)}</h3><div class="k">${esc(t.label)}${pr.status === 'unreviewed' ? ' · auto-detected, not yet reviewed' : pr.status === 'approximate' ? ' · approximate' : ''}</div>` +
        (pr.note ? `<p>${esc(pr.note)}</p>` : '') + `<p class="k">${ruleNote}</p></div>`).openOn(map);
      return;
    }
    const geomKind = /Point/.test(f.geometry.type) ? 'point' : /LineString/.test(f.geometry.type) ? 'line' : 'area';
    const opts = S.cfg.tags.filter(q => q.id === pr.tag || q.geom === 'any' || q.geom === geomKind)
      .map(q => `<option value="${q.id}"${q.id === pr.tag ? ' selected' : ''}>${esc(q.label)}</option>`).join('');
    const structChecked = isStructure(f);
    const html = `<div class="pop"><h3>${esc(pr.name || t.label)}</h3><form id="fform" autocomplete="off">` +
      `<label>Type<select name="tag">${opts}</select></label>` +
      `<label>Name<input type="text" name="name" value="${esc(pr.name || '')}" placeholder="e.g. Marina fuel dock"></label>` +
      `<label>Note<textarea name="note" placeholder="Anything a boater should know">${esc(pr.note || '')}</textarea></label>` +
      (geomKind === 'point' ? `<label>Short name for GPS units (14 max)<input type="text" name="short" maxlength="14" value="${esc(pr.short || '')}" placeholder="e.g. Marina Fuel"></label>` : '') +
      `<label style="display:flex;gap:.4rem;align-items:center;color:inherit"><input type="checkbox" name="structure"${structChecked ? ' checked' : ''}${isZoneTag(pr.tag) ? ' disabled' : ''}> Counts as a structure for the distance rules</label>` +
      `<label>Status<select name="status">${[...new Set([...STATUSES, pr.status || 'confirmed'])].map(s => `<option${s === (pr.status || 'confirmed') ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>` +
      `<div class="row2"><button type="button" class="btn danger" data-a="del">Delete</button>` +
      (geomKind === 'point' ? '' : '<button type="button" class="btn" data-a="zoom">Zoom</button>') +
      `<button type="button" class="btn primary" data-a="done">Done</button></div>` +
      `<div class="coords">${esc(pr.id)} · ${esc(pr.source || '')}${pr.updated ? ' · ' + esc(pr.updated) : ''}</div></form></div>`;
    const pop = L.popup(popOpts({ closeOnClick: false, autoClose: true })).setLatLng(at).setContent(html).openOn(map);
    const form = pop.getElement().querySelector('#fform');
    form.addEventListener('change', ev => {
      const el = ev.target;
      mutate(id, ff => {
        const p2 = ff.properties;
        if (el.name === 'tag') { p2.tag = el.value; delete p2.structure; if (p2.status === 'unreviewed') p2.status = 'confirmed'; }
        else if (el.name === 'structure') { const def = !!(S.tags[p2.tag] || {}).structure; if (el.checked === def) delete p2.structure; else p2.structure = el.checked; }
        else if (el.name === 'name' || el.name === 'note' || el.name === 'short') { const v = clean(el.value); if (v) p2[el.name] = el.name === 'short' ? v.slice(0, 14) : v; else delete p2[el.name]; }
        else if (el.name === 'status') p2.status = el.value;
      }, 'form');
      if (el.name === 'tag') featurePopup(id, at, true);
    });
    form.addEventListener('submit', ev => ev.preventDefault());
    form.querySelector('[data-a="del"]').onclick = () => removeFeature(id);
    form.querySelector('[data-a="done"]').onclick = () => { select(null); };
    const z = form.querySelector('[data-a="zoom"]'); if (z) z.onclick = () => map.fitBounds(featLayers.get(id).getBounds(), { maxZoom: 18, padding: [40, 40] });
  }

  // ---- review queue: auto-detected candidates and imported features -------------------
  const needsReview = f => f.properties.status === 'unreviewed' || f.properties.status === 'imported';
  function featCenter(f) {
    const g = f.geometry;
    if (g.type === 'Point') return g.coordinates;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const walk = a => { if (typeof a[0] === 'number') { x0 = Math.min(x0, a[0]); x1 = Math.max(x1, a[0]); y0 = Math.min(y0, a[1]); y1 = Math.max(y1, a[1]); } else a.forEach(walk); };
    walk(g.coordinates);
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  }
  function startReview() {
    const mode = $('#reviewFilter').value;
    let q = S.fc.features.filter(f => f.geometry);
    if (mode === 'unreviewed') q = q.filter(needsReview);
    else if (mode === 'all-docks') q = q.filter(f => ['dock', 'shared_dock'].includes(f.properties.tag));
    if (!q.length) { editMsg(mode === 'unreviewed' ? 'Nothing waiting for review — imported features and auto-detected docks show up here.' : 'Nothing to review with this filter.'); return; }
    q.sort((a, b) => featCenter(a)[0] - featCenter(b)[0]);  // west -> east, down the river
    if (!S.edit.on) setEdit(true);
    setMode('select');
    S.review = { ids: q.map(f => f.properties.id), i: 0, done: 0 };
    if (!$('#legend').classList.contains('min')) { S.review.legendWasOpen = true; $('#legend').classList.add('min'); renderLegend(); }
    showReview();
  }
  function endReviewView(rv) {
    if (rv.legendWasOpen) { $('#legend').classList.remove('min'); renderLegend(); }
  }
  const ESRI = 'Aerial, sharper (Esri)';
  function useSharpImagery() {     // the reviewer's explicit choice — the same as picking it in the layer control
    if (L_.baseName === ESRI || !L_.base[ESRI]) return;
    map.removeLayer(L_.base[L_.baseName]); L_.base[ESRI].addTo(map);
  }
  function stopReview() {
    if (!S.review) return;
    const id = S.review.ids[S.review.i];
    const rv = S.review;
    S.review = null; $('#reviewcard').hidden = true;
    endReviewView(rv);
    const lay = featLayers.get(id); if (lay && lay.getElement && lay.getElement()) { const d = lay.getElement().querySelector('.pin'); if (d) d.classList.remove('hl'); }
  }
  function showReview() {
    const rv = S.review; if (!rv) return;
    while (rv.i < rv.ids.length && !featById(rv.ids[rv.i])) rv.ids.splice(rv.i, 1);
    if (rv.i >= rv.ids.length) { $('#reviewcard').hidden = true; S.review = null; endReviewView(rv); editMsg(`Review finished — ${rv.done} decided. Export features.geojson to publish.`); updateEditState(); return; }
    const f = featById(rv.ids[rv.i]), pr = f.properties, t = tagOf(f);
    const lay0 = featLayers.get(pr.id);
    // no deeper than the imagery holds: USGS tiles stop at z16, Esri's at z19
    const zMax = L_.baseName === ESRI ? 18 : 17;
    if (f.geometry.type === 'Point' || !lay0 || !lay0.getBounds) map.setView(featCenter(f).slice().reverse(), Math.max(map.getZoom(), zMax), { animate: false });
    else map.fitBounds(lay0.getBounds(), { maxZoom: zMax, padding: [40, 40], animate: false });
    for (const [, lay] of featLayers) { const el = lay.getElement && lay.getElement(); const d = el && el.querySelector && el.querySelector('.pin.hl'); if (d) d.classList.remove('hl'); }
    const lay = featLayers.get(pr.id);
    if (lay && lay.getElement()) { const d = lay.getElement().querySelector('.pin'); if (d) d.classList.add('hl'); }
    const n = rv.ids.length;
    const kind = /Point/.test(f.geometry.type) ? 'point' : /LineString/.test(f.geometry.type) ? 'line' : 'area';
    const tagOpts = S.cfg.tags.filter(q => q.id === pr.tag || q.geom === 'any' || q.geom === kind).map(q => `<option value="${q.id}"${q.id === pr.tag ? ' selected' : ''}>${esc(q.label)}</option>`).join('');
    $('#reviewcard').hidden = false;
    const why = pr.status === 'unreviewed' ? 'Found automatically in aerial imagery — it doesn\'t count until you confirm it.'
      : pr.status === 'imported' ? 'Imported — check the type.' : 'Status: ' + esc(pr.status);
    $('#reviewcard').innerHTML = `<div class="rc-top"><b>Is this a ${esc(t.label.toLowerCase())}?</b><span class="k">${rv.i + 1} of ${n} · ${esc(pr.name || pr.id)}</span></div>` +
      `<div class="rc-prog"><i style="width:${(100 * rv.i / n).toFixed(1)}%"></i></div>` +
      `<div class="k" style="font-size:.74rem;color:var(--ink-2)">${f.geometry.type === 'Point' ? 'Pulsing pin. Drag it into place if it\'s off. ' : ''}${why}</div>` +
      `<div class="btnrow"><button class="btn primary" data-r="yes">✓ Yes (Y)</button><button class="btn danger" data-r="no">✗ Remove (N)</button>` +
      `<select data-r="tag" aria-label="Change type">${tagOpts}</select><button class="btn" data-r="prev">← Back</button><button class="btn" data-r="skip">Skip →</button><button class="btn" data-r="stop">Stop</button>` +
      (L_.baseName !== ESRI ? '<button class="btn" data-r="sharp" title="Esri World Imagery — sharper than the public-domain USGS default">Sharper imagery</button>' : '') + '</div>';
    const card = $('#reviewcard');
    card.querySelector('[data-r="yes"]').onclick = () => reviewAct('yes');
    card.querySelector('[data-r="no"]').onclick = () => reviewAct('no');
    card.querySelector('[data-r="skip"]').onclick = () => reviewAct('skip');
    card.querySelector('[data-r="prev"]').onclick = () => reviewAct('prev');
    card.querySelector('[data-r="stop"]').onclick = () => stopReview();
    const sharp = card.querySelector('[data-r="sharp"]'); if (sharp) sharp.onclick = () => { useSharpImagery(); showReview(); };
    card.querySelector('[data-r="tag"]').onchange = ev => reviewAct('tag', ev.target.value);
  }
  function reviewAct(a, val) {
    const rv = S.review; if (!rv) return;
    const id = rv.ids[rv.i];
    if (a === 'yes') { mutate(id, f => { f.properties.status = 'confirmed'; }, 'review'); rv.done++; rv.i++; }
    else if (a === 'no') { removeFeature(id); rv.ids.splice(rv.i, 1); rv.done++; }
    else if (a === 'tag') { mutate(id, f => { f.properties.tag = val; delete f.properties.structure; f.properties.status = 'confirmed'; }, 'review'); rv.done++; rv.i++; }
    else if (a === 'skip') rv.i++;
    else if (a === 'prev') rv.i = Math.max(0, rv.i - 1);
    showReview();
  }

  // ---- import / export of features ---------------------------------------------------
  function exportEdits() {
    const out = Object.assign({}, S.fc, { generated: today(), name: place().featuresName || 'features' });
    download(new Blob([JSON.stringify(out, null, 1)], { type: 'application/geo+json' }), 'features.geojson');
    editMsg(`Saved features.geojson — replace ${place().featuresPath || 'site/data/features.geojson'} with it to publish.`);
  }
  async function saveToFile() {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: 'features.geojson', types: [{ description: 'GeoJSON', accept: { 'application/geo+json': ['.geojson'] } }] });
      const w = await h.createWritable();
      await w.write(JSON.stringify(Object.assign({}, S.fc, { generated: today() }), null, 1)); await w.close();
      editMsg('Written to ' + h.name + '.');
    } catch (e) { if (e && e.name !== 'AbortError') editMsg('Could not write the file: ' + e.message); }
  }
  function discardEdits() {
    if (!diffCount().n) { editMsg('Nothing to discard.'); return; }
    pushHistory();
    S.fc = clone(S.base);
    lsDel(LS.feats);
    restoreAll('Back to the published map (undo restores your edits).');
  }
  // one feature per part: the editor, the map and the engine all work on simple geometries
  function splitMulti(f) {
    const g = f.geometry;
    if (!g || (g.type !== 'MultiPoint' && g.type !== 'MultiLineString')) return [f];
    const type = g.type === 'MultiPoint' ? 'Point' : 'LineString';
    return g.coordinates.filter(c => type === 'Point' || c.length > 1).map((c, k) => {
      const props = Object.assign({}, f.properties);
      if (k && props.id != null) props.id = props.id + '-' + k;
      return { type: 'Feature', id: props.id, properties: props, geometry: { type, coordinates: c } };
    });
  }
  // a geometry the map can draw and measure: a known type, finite coordinates, near this river
  function validGeom(g) {
    if (!g || typeof g !== 'object') return false;
    const B = S.reach.bounds_lonlat, pad = 0.05;
    const pt = c => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) &&
      c[0] >= B[0] - pad && c[0] <= B[2] + pad && c[1] >= B[1] - pad && c[1] <= B[3] + pad;
    const all = (a, ok, n) => Array.isArray(a) && a.length >= n && a.every(ok);
    const line = a => all(a, pt, 2), poly = a => all(a, r => all(r, pt, 4), 1);
    switch (g.type) {
      case 'Point': return pt(g.coordinates);
      case 'LineString': return line(g.coordinates);
      case 'Polygon': return poly(g.coordinates);
      case 'MultiPoint': return all(g.coordinates, pt, 1);
      case 'MultiLineString': return all(g.coordinates, line, 1);
      case 'MultiPolygon': return all(g.coordinates, poly, 1);
      default: return false;
    }
  }
  // the published file and saved edits are checked feature by feature; bad records are dropped, not fatal
  function cleanFC(fc, dropped) {
    const out = [];
    for (const f of Array.isArray(fc.features) ? fc.features : []) {
      const pr = f && f.properties;
      if (!pr || typeof pr !== 'object' || pr.id == null || typeof pr.tag !== 'string' || !validGeom(f.geometry)) {
        dropped.push(String(pr && pr.id != null ? pr.id : '(no id)')); continue;
      }
      if (!S.tags[pr.tag]) pr.tag = 'other';
      out.push(...splitMulti(f));
    }
    return Object.assign({}, fc, { features: out });
  }
  // same kind of geometry over the same ~1 m box = the same feature (exports re-wind and clean rings)
  const geomKey = g => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const walk = a => { if (typeof a[0] === 'number') { x0 = Math.min(x0, a[0]); x1 = Math.max(x1, a[0]); y0 = Math.min(y0, a[1]); y1 = Math.max(y1, a[1]); } else a.forEach(walk); };
    walk(g.coordinates);
    return g.type.replace('Multi', '') + ':' + [x0, y0, x1, y1].map(v => v.toFixed(5)).join(',');
  };
  const STATUSES = ['unreviewed', 'confirmed', 'approximate', 'imported', 'osm', 'research', 'derived', 'verified'];
  async function importFile(file) {
    if (!file) return;
    try {
      const name = file.name.toLowerCase();
      let feats = [], skipped = 0;
      if (name.endsWith('.kmz')) feats = parseKML(await unzipFirstKml(new Uint8Array(await file.arrayBuffer())));
      else if (name.endsWith('.kml')) feats = parseKML(await file.text());
      else if (name.endsWith('.gpx')) feats = parseGPX(await file.text());
      else { const j = JSON.parse(await file.text()); feats = (j.type === 'FeatureCollection' ? j.features : j.type === 'Feature' ? [j] : []); }
      const parseSkipped = feats.skipped || 0;
      // this app's own zone downloads: keep only their map features (pins, booms, areas), never the
      // computed bands, rule lines or zone outlines — re-importing those would turn a 344-ac band into a "zone"
      const zoneDownload = feats.some(f => f.properties && (f.properties.layer || f.properties._ourStyle));
      if (zoneDownload) {
        const before = feats.length;
        feats = feats.filter(f => f.properties.layer === 'feature' || (f.properties._ourStyle && S.tags[f.properties._ourStyle]));
        for (const f of feats) if (f.properties._ourStyle) f.properties.tag = f.properties._ourStyle;
        skipped = before - feats.length;
      }
      feats = feats.flatMap(splitMulti);
      const nIn = feats.length;
      feats = feats.filter(f => f && f.geometry && validGeom(f.geometry));
      const invalid = nIn - feats.length + parseSkipped;
      if (!feats.length) { editMsg(invalid ? `Nothing to import from ${file.name}: ${invalid} feature${invalid === 1 ? ' has' : 's have'} missing coordinates or lie outside this map.` : zoneDownload ? `${file.name} is a zone map download with no map features to import — use Export features.geojson to move edits.` : 'No features found in ' + file.name); return; }
      // a full features.geojson from this tool replaces the working set; anything else is merged in
      const ours = feats.every(f => f.properties && f.properties.id && f.properties.tag && S.tags[f.properties.tag]);
      const snapshot = JSON.stringify(S.fc);
      pushHistory();
      let n = 0, dup = 0, zoneGuess = 0;
      try {
        if (ours && !zoneDownload) {
          const canon = f => JSON.stringify([Object.keys(f.properties).sort().map(k => [k, f.properties[k]]), f.geometry]);
          const at = new Map(S.fc.features.map((f, i) => [String(f.properties.id), i]));
          const published = new Map(S.base.features.map(f => [String(f.properties.id), canon(f)]));
          let upd = 0, add = 0, same = 0, both = 0;
          for (const f of feats) {
            const id = String(f.properties.id);
            const nf = { type: 'Feature', id, properties: Object.assign({}, f.properties, { id }), geometry: roundGeom(f.geometry) };
            if (!STATUSES.includes(nf.properties.status)) nf.properties.status = 'imported';
            const i = at.get(id);
            if (i == null) { S.fc.features.push(nf); at.set(id, S.fc.features.length - 1); add++; continue; }
            const mine = canon(S.fc.features[i]), theirs = canon(nf), pub = published.get(id);
            if (mine === theirs) { same++; continue; }
            if (pub && mine !== pub && theirs !== pub) both++;      // changed on both sides: the file's version wins
            S.fc.features[i] = nf; upd++;
          }
          renderAllFeatures(); saveLocal(); updateEditState(); syncEngine(); schedule(20);
          editMsg(`Merged ${file.name}: ${upd} updated, ${add} added, ${same} already the same` +
            (both ? ` — ${both} had changed here too; the file's version was kept (Undo restores yours)` : '') +
            (invalid ? ` — skipped ${invalid} with missing coordinates or outside this map` : '') + '.');
          return;
        }
        const have = new Set(S.fc.features.filter(f => f.geometry).map(f => f.properties.tag + '|' + geomKey(f.geometry)));
        const batch = Date.now().toString(36);
        for (const f of feats) {
          const p = Object.assign({}, f.properties || {});
          const known = p.tag && S.tags[p.tag];
          let tag = known ? p.tag : guessTag(p.name || p.Name || '', f.geometry.type, p._kmlColor);
          // a guessed designated zone changes the rules — bring it in as a caution area until someone confirms it
          if (!known && isZoneTag(tag)) { tag = 'caution'; zoneGuess++; }
          if (have.has(tag + '|' + geomKey(f.geometry))) { dup++; continue; }
          const id = `imp-${batch}-${n}`;
          const status = known && STATUSES.includes(p.status) ? p.status : 'imported';
          const props = { id, tag, name: clean((p.name || p.Name || '').toString()).slice(0, 120), status, source: 'import:' + clean(file.name), updated: today() };
          const note = clean((p.note || p.description || p.desc || '').toString().replace(/<[^>]+>/g, ' '));
          if (note) props.note = note.slice(0, 500);
          if (known) for (const k of ['short', 'structure', 'when']) if (p[k] != null && p[k] !== '') props[k] = k === 'short' ? clean(p[k]).slice(0, 14) : p[k];
          S.fc.features.push({ type: 'Feature', id, properties: props, geometry: roundGeom(f.geometry) });
          have.add(tag + '|' + geomKey(f.geometry));
          n++;
        }
        renderAllFeatures(); saveLocal(); updateEditState(); syncEngine(); schedule(20);
      } catch (e) {                       // nothing half-applied: put the map back exactly as it was
        S.fc = JSON.parse(snapshot); S.hist.pop();
        renderAllFeatures(); syncEngine(); schedule(20);
        throw e;
      }
      editMsg(`Imported ${n} feature${n === 1 ? '' : 's'} from ${file.name}` + (dup ? ` (${dup} already on the map)` : '') +
        (invalid ? ` — skipped ${invalid} with missing coordinates or outside this map` : '') +
        (skipped ? ` — skipped ${skipped} computed zone layer${skipped === 1 ? '' : 's'}` : '') +
        (zoneGuess ? ` — ${zoneGuess} possible no-wake area${zoneGuess === 1 ? '' : 's'} came in as caution areas; retag them as designated zones if they are` : '') +
        '. They stay off the public map and out of the numbers until you confirm them in Review.');
      if (n && !S.edit.on) setEdit(true);
    } catch (e) { editMsg('Import failed: ' + e.message); }
  }
  function guessTag(name, gtype, color) {
    const n = name.toLowerCase();
    const red = color && /^ff[0-4][0-9a-f][0-4][0-9a-f][c-f][0-9a-f]$/i.test(color);   // aabbggrr, mostly red
    if (/no.?wake/.test(n) || (red && gtype === 'Point')) return gtype === 'Polygon' || gtype === 'MultiPolygon' ? 'no_wake_zone' : 'buoy';
    if (/boom/.test(n)) return gtype === 'LineString' ? 'log_boom' : 'hazard';
    if (/swim/.test(n)) return gtype === 'Point' ? 'swim_platform' : 'swim_area';
    if (/launch|ramp/.test(n)) return 'launch';
    if (/fuel|gas/.test(n)) return 'fuel';
    if (/marina|slip/.test(n)) return 'marina';
    if (/dock|pier/.test(n)) return 'dock';
    if (/rock|shoal|shallow|snag|piling|hazard|stump/.test(n)) return 'hazard';
    if (/camp|park|beach/.test(n)) return gtype === 'Point' ? 'park' : 'caution';
    if (/bridge/.test(n)) return 'bridge';
    if (/dam/.test(n)) return 'dam';
    return gtype === 'Point' ? 'hazard' : 'caution';    // HLWID's unlabelled lines/markers are caution features
  }
  function parseKML(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const styles = {};
    const colorOf = st => {                 // KML colours are aabbggrr
      const pick = sel => { const e = st.getElementsByTagName(sel)[0], c = e && e.getElementsByTagName('color')[0]; return c ? c.textContent.trim() : ''; };
      let c = pick('IconStyle') || pick('LineStyle') || pick('PolyStyle');
      if (!c) {
        const href = ((st.getElementsByTagName('href')[0] || {}).textContent || '').trim();
        const q = /[?&]color=([0-9a-f]{6})/i.exec(href);                            // Earth Web: …icon?color=d32f2f
        if (q) c = 'ff' + q[1].slice(4, 6) + q[1].slice(2, 4) + q[1].slice(0, 2);
        else if (/(^|[/_-])red[-_.]|red-(circle|pushpin|blank|stars|diamond|square)/i.test(href)) c = 'ff0000ff';   // Earth Pro paddles/pushpins
      }
      return c;
    };
    for (const st of [...doc.getElementsByTagName('Style'), ...doc.getElementsByTagNameNS('*', 'CascadingStyle')]) {
      const id = st.getAttribute('id') || st.getAttribute('kml:id');
      if (id) styles['#' + id] = colorOf(st);
    }
    for (const sm of doc.getElementsByTagName('StyleMap')) {     // Earth Pro/Web point placemarks at a StyleMap
      const id = sm.getAttribute('id') || sm.getAttribute('kml:id'); if (!id) continue;
      for (const pair of sm.getElementsByTagName('Pair')) {
        if (((pair.getElementsByTagName('key')[0] || {}).textContent || '').trim() !== 'normal') continue;
        const su = ((pair.getElementsByTagName('styleUrl')[0] || {}).textContent || '').trim();
        const inline = pair.getElementsByTagName('Style')[0];
        styles['#' + id] = styles[su] || (inline ? colorOf(inline) : '');
      }
    }
    const coordsOf = el => el.textContent.trim().split(/\s+/).map(t => t.split(',').map(Number)).filter(c => c.length >= 2 && c.every(Number.isFinite)).map(c => [c[0], c[1]]);
    const out = [];
    for (const pm of doc.getElementsByTagName('Placemark')) {
      const name = (pm.getElementsByTagName('name')[0] || {}).textContent || '';
      const desc = (pm.getElementsByTagName('description')[0] || {}).textContent || '';
      const su = (pm.getElementsByTagName('styleUrl')[0] || {}).textContent || '';
      const inlineS = pm.getElementsByTagName('Style')[0];
      const color = (inlineS && colorOf(inlineS)) || styles[su.trim()] || '';
      const ourTag = /^#p_([a-z_]+)$/.exec(su.trim());
      const add = g => out.push({ type: 'Feature', properties: { name, description: desc, _kmlColor: color, _ourStyle: ourTag ? ourTag[1] : null }, geometry: g });
      for (const p of pm.getElementsByTagName('Point')) { const c = coordsOf(p.getElementsByTagName('coordinates')[0]); if (c.length) add({ type: 'Point', coordinates: c[0] }); }
      for (const l of pm.getElementsByTagName('LineString')) { const c = coordsOf(l.getElementsByTagName('coordinates')[0]); if (c.length > 1) add({ type: 'LineString', coordinates: c }); }
      for (const pg of pm.getElementsByTagName('Polygon')) {
        const rings = [];
        const ob = pg.getElementsByTagName('outerBoundaryIs')[0];
        if (ob) rings.push(coordsOf(ob.getElementsByTagName('coordinates')[0]));
        for (const ib of pg.getElementsByTagName('innerBoundaryIs')) rings.push(coordsOf(ib.getElementsByTagName('coordinates')[0]));
        if (rings.length && rings[0].length > 3) add({ type: 'Polygon', coordinates: rings });
      }
    }
    return out;
  }
  function parseGPX(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml'), out = [];
    const nm = el => ((el.getElementsByTagName('name')[0] || {}).textContent || '');
    const pt = el => [parseFloat(el.getAttribute('lon')), parseFloat(el.getAttribute('lat'))];
    const finite = c => Number.isFinite(c[0]) && Number.isFinite(c[1]);
    out.skipped = 0;                       // points with no usable position (reported by the import)
    for (const w of doc.getElementsByTagName('wpt')) { const c = pt(w); if (finite(c)) out.push({ type: 'Feature', properties: { name: nm(w) }, geometry: { type: 'Point', coordinates: c } }); else out.skipped++; }
    const line = (name, pts) => { const ok = pts.filter(finite); out.skipped += pts.length - ok.length; if (ok.length > 1) out.push({ type: 'Feature', properties: { name }, geometry: { type: 'LineString', coordinates: ok } }); };
    for (const t of doc.getElementsByTagName('trk')) for (const sg of t.getElementsByTagName('trkseg')) line(nm(t), [...sg.getElementsByTagName('trkpt')].map(pt));
    for (const r of doc.getElementsByTagName('rte')) line(nm(r), [...r.getElementsByTagName('rtept')].map(pt));
    return out;
  }
  async function unzipFirstKml(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip/KMZ file');
    const n = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    for (let k = 0; k < n; k++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (!/\.kml$/i.test(name)) continue;
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return new TextDecoder().decode(data);
      if (method === 8 && typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('deflate-raw');
        return await new Response(new Blob([data]).stream().pipeThrough(ds)).text();
      }
      throw new Error('this KMZ uses a compression this browser cannot read — export it as KML instead');
    }
    throw new Error('no .kml inside the KMZ');
  }

  // ============================================================== downloads
  function download(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a);   // must be in the document or Safari/Firefox drop the click
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 10000);
  }
  function dlMsg(m) { const e = $('#dlMsg'); e.textContent = m; setTimeout(() => { if (e.textContent === m) e.textContent = ''; }, 4500); }
  function critLabel(p, highWater) {
    p = p || S.params; const R_ = p.rules;
    const law = JSON.stringify(p) === JSON.stringify(S.defaults);
    return (highWater ? `HIGH WATER (lake ${highWater.elev.toFixed(1)} ft, ${today()}): entire river no-wake · ` : '') +
      (law ? 'Current rules' : 'WHAT-IF rules') + `: no wake ${R_.nowake.ft} ft · no tow ${R_.tow.ft} ft · surf guide ${R_.surf.ft} ft` +
      (R_.tow.structures ? ' (from shore & docks)' : ' (from shore)') + ` · lanes ${fmtFt(p.run.ft)} ft` + (p.zonesOn ? ' · designated zones applied' : ' · designated zones OFF');
  }
  function exportModel(official) {
    // official files: current rules, published features, summer full pool — the same as bake.mjs
    const p = official ? S.defaults : S.params, fc = official ? S.base : S.fc;
    const act = official ? 'tow' : S.view === 'surf' ? 'surf' : 'tow';
    const lvl = official ? 0 : (p.levelAdjust ? S.levelOffsetFt : 0);
    const withWidth = !!($('#dlWidth') && $('#dlWidth').checked);
    const keep = S.fc;
    if (official) { S.fc = fc; syncEngine(); }
    // official files are the normal-rules map (like bake.mjs); today's files carry a high-water override
    const hw = official ? null : S.highWater;
    const res = S.eng.compute(Object.assign(engParams(p, act === 'surf' ? 'surf' : 'bottom'), { levelOffsetFt: lvl, width: withWidth, lines: true, allNoWake: !!hw }));
    if (official) { S.fc = keep; syncEngine(); }
    return ZoneExport.model(S.eng, res, fc, S.cfg, { params: p, activity: act, official, levelOffsetFt: lvl, generated: today(),
      url: S.cfg.url || (official ? location.href.split('#')[0] : location.href), label: critLabel(p, hw),
      include: { docks: !!($('#dlDocks') && $('#dlDocks').checked), width: withWidth } });
  }
  const stamp = () => today() + (isDefault() ? '' : '-whatif');
  async function doExport(fmt, official) {
    const m = exportModel(official), base = `${place().fileBase || 'boating-zones'}-${official ? 'official-' + today() : stamp()}`;
    if (fmt === 'kml') download(new Blob([ZoneExport.toKML(m, { flat: true })], { type: 'application/vnd.google-earth.kml+xml' }), base + '.kml');
    else if (fmt === 'kmz') {
      const z = await ZoneExport.zip([{ name: 'doc.kml', data: new TextEncoder().encode(ZoneExport.toKML(m)) }], ZoneExport.browserDeflateRaw);
      download(new Blob([z], { type: 'application/vnd.google-earth.kmz' }), base + '.kmz');
    } else if (fmt === 'gpx') download(new Blob([ZoneExport.toGPX(m)], { type: 'application/gpx+xml' }), base + '.gpx');
    else if (fmt === 'geojson') download(new Blob([ZoneExport.toGeoJSON(m)], { type: 'application/geo+json' }), base + '.geojson');
    dlMsg(`${fmt.toUpperCase()} saved${official ? ' (current rules)' : ''}.`);
  }
  function openPrint(official) {
    const payload = { params: official ? S.defaults : S.params, view: official ? 'bottom' : S.view, levelOffsetFt: S.levelOffsetFt,
      fc: official || !diffCount().n ? null : S.fc, url: location.href, at: Date.now(),
      highWater: official || !S.highWater ? null : { elev: S.highWater.elev, date: today() } };
    if (!lsSet(LS.print, payload)) { dlMsg('Could not hand the map to the print page (storage blocked).'); }
    const w = window.open('print.html' + (official ? '?official=1' : ''), '_blank');
    if (!w) dlMsg('Pop-up blocked — allow pop-ups for this site to print.');
  }
  function copyLink() {
    updateHash(true);
    const u = location.href;
    if (navigator.clipboard) navigator.clipboard.writeText(u).then(() => dlMsg('Link copied.'), () => dlMsg(u)); else dlMsg(u);
  }
  async function renderOfficialDownloads() {
    let man = null;
    try { const r = await fetch('downloads/manifest.json', { cache: 'no-cache' }); if (r.ok) man = await r.json(); } catch (_) { /* not built yet */ }
    const items = [
      ['PDF', 'pdf', 'Printable chart book: overview, three close-up sections, and the rules.'],
      ['KMZ', 'kmz', 'Google Earth (phone or desktop), Avenza, onX Hunt/Offroad — every layer, zones in color.'],
      ['GPX', 'gpx', 'Chartplotters and nav apps: zone edges as tracks, launches & hazards as waypoints.'],
      ['KML', 'kml', 'Flattened for Google My Maps: zones, rule lines, launches and hazards — no folders or dock pins (those are in the KMZ and GeoJSON).'],
      ['GeoJSON', 'geojson', 'GIS (QGIS, ArcGIS): zones, rule lines, every dock and feature.'],
    ];
    $('#officialDl').innerHTML = items.map(([fmt, ext, desc]) => {
      const f = man && man.files && man.files.find(q => q.ext === ext);
      const meta = f ? `${f.size_kb} KB · built ${esc(man.built)}` : 'generated from the current rules';
      const act = f ? `<a class="btn primary" href="downloads/${encodeURIComponent(f.name)}" download>Download ${fmt}</a>`
        : `<button class="btn primary" data-off="${ext}">Download ${fmt}</button>`;
      return `<div class="dlcard"><span class="fmt">${fmt}</span><p>${desc}</p><span class="meta">${meta}</span>${act}</div>`;
    }).join('');
    $$('#officialDl [data-off]').forEach(b => b.onclick = () => b.dataset.off === 'pdf' ? openPrint(true) : doExport(b.dataset.off, true));
  }

  // ===================================================================== GPS
  function toggleGps() {
    const btn = $('#gpsBtn');
    if (S.gpsWatch != null) {
      navigator.geolocation.clearWatch(S.gpsWatch); S.gpsWatch = null; S.gps = null;
      if (L_.gps) { L_.gps.remove(); L_.gpsAcc.remove(); L_.gps = null; }
      if (L_.gpsRings) { L_.gpsRings.forEach(r => r.remove()); L_.gpsRings = null; }
      gpsBar('', ''); btn.classList.remove('on'); return;
    }
    if (!('geolocation' in navigator)) { gpsBar('warn', 'This browser has no location support'); return; }
    btn.classList.add('on'); S.follow = true;
    gpsBar('warn', 'Waiting for GPS…');
    S.gpsWatch = navigator.geolocation.watchPosition(onFix, err => gpsBar('warn', err.code === 1 ? 'Location permission denied' : 'No GPS fix yet'),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }
  function onFix(pos) {
    const { latitude: la, longitude: lo, accuracy } = pos.coords;
    S.gps = { lat: la, lon: lo, acc: accuracy || 0 };
    if (!L_.gps) {
      L_.gpsAcc = L.circle([la, lo], { radius: S.gps.acc, color: '#2f7df6', weight: 1, fillOpacity: 0.12, interactive: false, pmIgnore: true }).addTo(map);
      L_.gps = L.marker([la, lo], { icon: L.divIcon({ className: '', html: '<div class="gps-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, keyboard: false, pmIgnore: true }).addTo(map);
    } else { L_.gps.setLatLng([la, lo]); L_.gpsAcc.setLatLng([la, lo]).setRadius(S.gps.acc); }
    if (S.follow) map.panTo([la, lo], { animate: true });
    evalGps();
  }
  function evalGps() {
    if (!S.gps) return;
    // on the water the banner always uses the CURRENT rules — what-if settings are for exploring
    const p = engParams(S.defaults, 'bottom'), R_ = p.rules;
    const [x, y] = utm(S.gps.lon, S.gps.lat);
    const s = S.eng.sample(x, y, p);
    const rm = S.eng.riverMile(x, y), rmTxt = rm != null && s.inWater ? ` · RM ${rm.toFixed(2)}` : '';
    // 100 / 150 / 200 ft rings always follow the boat, in the analysed river or not
    if (!L_.gpsRings) L_.gpsRings = [R_.nowake.ft, R_.tow.ft, R_.surf.ft].map((f, k) => L.circle([S.gps.lat, S.gps.lon],
      { radius: f * FT, color: ['#e8364a', '#ff9124', '#7d55e8'][k], weight: 1.2, dashArray: '4 6', fill: false, interactive: false, pmIgnore: true }).addTo(map));
    L_.gpsRings.forEach((r, k) => r.setLatLng([S.gps.lat, S.gps.lon]).setRadius([R_.nowake.ft, R_.tow.ft, R_.surf.ft][k] * FT));
    if (!s.inWater) {
      const zh = S.eng.zoneAt(x, y), inApp = S.reach.approach && S.eng.pointInPolys(x, y, S.reach.approach.polygons);
      if (zh) gpsBar('bad', zoneMsg(zh.type, zh.when));
      else if (inApp) gpsBar('bad', `NO WAKE — 5 mph${S.cfg.approach ? ` (${S.cfg.approach.short})` : ''}`);
      else gpsBar('warn', 'Outside the mapped river');
      return;
    }
    const c = classify(s, p), accFt = (S.gps.acc || 0) / FT;
    const d = c.dist(R_.nowake) / FT, dt = c.dist(R_.tow) / FT, ds = c.dist(R_.surf) / FT;
    let tcNow = null;
    // a fix whose error circle straddles a setback line or a designated-zone edge can't be called either way
    const near = (v, lim) => Math.abs(v - lim) < accFt;
    const zoneEdge = p.zonesOn !== false && s.zone_edge_m != null && s.zone_edge_m / FT < accFt;
    const straddles = near(d, R_.nowake.ft) || near(dt, R_.tow.ft);
    const accTxt = accFt > 30 ? ` (GPS ±${Math.round(accFt)} ft)` : '';
    if (S.highWater) gpsBar('bad', 'ENTIRE RIVER NO-WAKE — high water' + rmTxt);
    else if (c.zone) gpsBar('bad', zoneMsg(s.zoneType, s.zoneWhen) + rmTxt);
    else if (zoneEdge) gpsBar('bad', `TOO CLOSE TO CALL — at a designated-zone edge; treat it as inside${accTxt}${rmTxt}`);
    else if (straddles) gpsBar('mid', `TOO CLOSE TO CALL — treat as no-wake · ${fmtFt(d)} ft from shore/dock${accTxt}${rmTxt}`);
    else if (!c.wake) gpsBar('bad', `NO-WAKE BAND — ${fmtFt(d)} ft from shore/dock${accTxt}${rmTxt}`);
    else if (!c.tow) gpsBar('mid', `NO-TOW BAND — wake OK, no towing · ${fmtFt(dt)} ft${accTxt}${rmTxt}`);
    else if ((tcNow = towClock(new Date())) && !tcNow.ok) gpsBar('mid', `NO TOWING NOW — after dark (${tcNow.text.replace(/^No towing /, '')}) · wake OK · ${fmtFt(dt)} ft from shore/dock${accTxt}${rmTxt}`);
    else gpsBar('out', `Outside the ${R_.tow.ft}-ft no-tow setback · ${fmtFt(dt)} ft from shore/dock` +
      (near(ds, R_.surf.ft) ? ` · at the ${R_.surf.ft}-ft surf line` : c.surf ? ` · ${R_.surf.ft}-ft surf guideline met` : '') + `${accTxt}${rmTxt}`);
  }
  function gpsBar(cls, msg) {
    const g = $('#gpsbar');
    g.className = 'gpsbar' + (cls ? ' on ' + cls : '');
    g.innerHTML = msg ? esc(msg) + (cls && cls !== 'warn' ? '<small>the map can\'t see swimmers, boats or a downed rider</small>' : '') + '<button id="gpsOff">Stop</button>' : '';
    const b = $('#gpsOff'); if (b) b.onclick = toggleGps;
  }

  // ======================================================= live conditions
  // live conditions: USGS and NWS in parallel, each with its own timeout; the tow clock needs no
  // network and shows at once. Only successful readings are cached (10 min) — a failure is retried
  // on the next load, when the connection returns, or when the tab comes back to the front.
  const COND_TTL = 10 * 60e3, FETCH_MS = 7000;
  async function fetchJSON(url, opts) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), FETCH_MS);
    try {
      const r = await fetch(url, Object.assign({ signal: ac.signal }, opts));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  async function loadConditions() {
    if (S.condBusy) return;
    S.condBusy = true;
    try {
      if (!S.cond) renderConds({ loading: true });
      const prev = (() => { try { return JSON.parse(sessionStorage.getItem('srz:cond')) || {}; } catch (_) { return {}; } })();
      const fresh = k => prev[k] && Date.now() - prev[k].at < COND_TTL ? prev[k] : null;
      const g = S.cfg.gauges, w = S.cfg.weather;
      const [usgs, wx] = await Promise.allSettled([
        fresh('usgs') || fetchJSON(`https://waterservices.usgs.gov/nwis/iv/?format=json&siteStatus=active&parameterCd=00060,00065&sites=${g.lake.site},${g.reach.site},${g.dam.site}`).then(j => {
          const out = { at: Date.now(), v: {} };
          for (const ts of j.value.timeSeries) {
            const site = ts.sourceInfo.siteCode[0].value, prm = ts.variable.variableCode[0].value;
            const v = ts.values[0].value; if (!v.length) continue;
            const last = v[v.length - 1], val = parseFloat(last.value);
            if (!Number.isFinite(val) || val < -9999) continue;
            out.v[site + ':' + prm] = { v: val, t: last.dateTime };
          }
          return out;
        }),
        fresh('wx') || fetchJSON(`https://api.weather.gov/gridpoints/${w.office}/${w.x},${w.y}/forecast/hourly`, { headers: { Accept: 'application/geo+json' } }).then(j => {
          const per = j.properties.periods;
          const now = per.find(q => new Date(q.endTime) > new Date()) || per[0];
          const next = per.slice(0, 6);
          return { at: Date.now(), wind: { now: now.windSpeed, dir: now.windDirection, temp: now.temperature, unit: now.temperatureUnit,
            max: Math.max(...next.map(q => parseInt(q.windSpeed.split(' to ').pop(), 10) || 0)), short: now.shortForecast } };
        }),
      ]);
      const c = { usgs: usgs.status === 'fulfilled' ? usgs.value : null, wx: wx.status === 'fulfilled' ? wx.value : null };
      try { sessionStorage.setItem('srz:cond', JSON.stringify({ usgs: c.usgs || undefined, wx: c.wx || undefined })); } catch (_) { /* fine */ }
      S.cond = c;
      renderConds(c);
    } finally { S.condBusy = false; }
  }
  function condsStale() { const c = S.cond; return !c || !c.usgs || !c.wx || Date.now() - Math.min(c.usgs.at, c.wx.at) > COND_TTL; }
  function renderConds(c) {
    const box = $('#conds');
    if (c.loading) {
      const tc0 = towClock(new Date());
      box.innerHTML = (tc0 ? `<span class="cond ${tc0.ok ? '' : 'warn'}" title="${esc(S.cfg.towHours.text)}"><span>Tow clock</span><b>${esc(tc0.text)}</b></span>` : '') +
        '<span class="cond"><span>Lake level</span><b>checking…</b></span>';
      return;
    }
    const usg = (c.usgs && c.usgs.v) || {};
    const g = S.cfg.gauges, chips = [];
    const lake = usg[g.lake.site + ':00065'];
    const stale = lake && Date.now() - new Date(lake.t).getTime() > 6 * 3600e3;
    if (lake && !stale) {
      const off = S.cfg.depth.fullPoolGageFt - lake.v;
      S.levelOffsetFt = Math.round(off * 100) / 100; S.levelLive = true;
      // county rule: the whole river is no-wake when the lake gauge reads the trigger or more
      const hw = S.cfg.highWater, elev = (hw ? hw.gageToElev : 2100) + lake.v;
      S.highWater = hw && elev >= hw.elevFt ? { elev } : null;
      if (hw && elev >= hw.elevFt - 0.5 && !S.highWater) chips.push(`<span class="cond warn" title="${esc(hw.text)}"><span>High water</span><b>${(hw.elevFt - elev).toFixed(1)} ft below river-wide no-wake</b></span>`);
      $('#hwBanner').hidden = !S.highWater;
      if (S.highWater) $('#hwBanner').innerHTML = `<b>Entire river is NO-WAKE</b> — ${esc(hw.gaugeName || 'the gauge')} is at ${elev.toFixed(1)} ft (trigger ${hw.elevFt.toLocaleString()} ft). ${esc(hw.citation || '')}`;
      const cls = Math.abs(off) < 0.5 ? 'ok' : 'warn';
      chips.push(`<span class="cond ${cls}" title="USGS ${g.lake.site} gage ${lake.v.toFixed(2)} ft (≈ 28.0 at summer full pool), ${new Date(lake.t).toLocaleString()}"><span>Lake level</span><b>${Math.abs(off) < 0.05 ? 'full pool' : `${Math.abs(off).toFixed(1)} ft ${off > 0 ? 'below' : 'above'} full pool`}</b></span>`);
      $('#lvlNote').textContent = `(${Math.abs(off).toFixed(1)} ft ${off > 0 ? 'lower' : 'higher'} today)`;
    } else {
      S.levelLive = false;
      $('#lvlNote').textContent = '(live level unavailable — depths at full pool; expect shallower)';
      S.highWater = null; $('#hwBanner').hidden = true;
      const hwT = S.cfg.highWater;
      chips.push(`<span class="cond warn" title="USGS ${g.lake.site} ${stale ? 'reading is stale' : 'could not be reached'} — the river-wide no-wake trigger${hwT ? ` (${hwT.elevFt.toLocaleString()} ft, about ${(hwT.elevFt - hwT.gageToElev).toFixed(1)} ft on the gauge)` : ''} can't be checked"><span>Lake level</span><b>unknown — high-water check off</b></span>`);
    }
    // the in-reach gauge swings widely within a day at summer pool; the dam outflow is the steadier number
    const q = usg[g.reach.site + ':00060'], qd = usg[g.dam.site + ':00060'];
    const flow = qd || q;
    if (flow) chips.push(`<span class="cond" title="Dam outflow (USGS ${g.dam.site}) ${qd ? Math.round(qd.v).toLocaleString() + ' cfs' : 'n/a'}; in-reach gauge (USGS ${g.reach.site}) ${q ? Math.round(q.v).toLocaleString() + ' cfs' : 'n/a'} — it swings within the day at summer pool. ${new Date(flow.t).toLocaleString()}"><span>River flow</span><b>${Math.round(flow.v).toLocaleString()} cfs</b></span>`);
    const wind = c.wx && c.wx.wind;
    if (wind) chips.push(`<span class="cond ${wind.max >= 15 ? 'warn' : ''}" title="NWS hourly forecast: ${esc(wind.short)}; up to ${wind.max} mph in the next 6 h"><span>Wind</span><b>${esc(wind.now)} ${esc(wind.dir)}</b></span>`);
    const tc = towClock(new Date());
    if (tc) chips.unshift(`<span class="cond ${tc.ok ? '' : 'warn'}" title="${esc(S.cfg.towHours.text)}${tc.sunset ? ' Sunset ' + tc.sunset + '.' : ''}"><span>Tow clock</span><b>${esc(tc.text)}</b></span>`);
    if (!c.wx && !c.usgs) chips.push('<span class="cond warn"><span>Live data</span><b>offline</b></span>');
    box.innerHTML = chips.join('');
    S.condLoaded = true;
    if (S.levelLive && S.params.levelAdjust) { if (S.view === 'depth') renderStatic(); }
    schedule(10);   // depth-today, corridor depths and any high-water override
    if (S.res) renderLegend();
  }
  // NOAA solar calculator (Meeus): sunrise/sunset to well under a minute
  function sunTimes(y, mo, d, lat, lon) {   // calendar date at the river (not the viewer's)
    const rad = Math.PI / 180, deg = 1 / rad;
    const jd0 = 367 * y - Math.floor(7 * (y + Math.floor((mo + 9) / 12)) / 4) + Math.floor(275 * mo / 9) + d + 1721013.5;
    const event = (rising) => {
      let minutes = 720;                                   // refine the solar position at the event itself
      for (let it = 0; it < 3; it++) {
        const T = (jd0 + minutes / 1440 - 2451545) / 36525;
        const L0 = ((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360 + 360) % 360;
        const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
        const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
        const C = Math.sin(M * rad) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * rad) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * rad) * 0.000289;
        const om = 125.04 - 1934.136 * T, lam = L0 + C - 0.00569 - 0.00478 * Math.sin(om * rad);
        const eps = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(om * rad);
        const dec = Math.asin(Math.sin(eps * rad) * Math.sin(lam * rad));
        const yy = Math.tan(eps * rad / 2) ** 2;
        const eqt = 4 * deg * (yy * Math.sin(2 * L0 * rad) - 2 * e * Math.sin(M * rad) + 4 * e * yy * Math.sin(M * rad) * Math.cos(2 * L0 * rad)
          - 0.5 * yy * yy * Math.sin(4 * L0 * rad) - 1.25 * e * e * Math.sin(2 * M * rad));
        const cosH = Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(dec)) - Math.tan(lat * rad) * Math.tan(dec);
        if (cosH < -1 || cosH > 1) return null;
        const H = Math.acos(cosH) * deg;
        minutes = 720 - 4 * lon - eqt + (rising ? -4 * H : 4 * H);
      }
      return new Date(Date.UTC(y, mo - 1, d) + minutes * 60e3);
    };
    const rise = event(true), set = event(false);
    return rise && set ? { rise, set } : null;
  }
  // the towing window from config (e.g. no towing from 1 h after sunset to 1 h before sunrise);
  // the end is shown rounded down and the start rounded up, so the chip never gives extra time
  function towClock(now) {
    const th = S.cfg.towHours; if (!th) return null;
    if (S.highWater) return { ok: false, text: 'No towing — river-wide no-wake' };
    const tz = place().timeZone || 'America/Los_Angeles', at = place().sun || S.cfg.weather || {};
    const [y, mo, d] = ZoneExport.localDate(now, tz).split('-').map(Number);
    const t = sunTimes(y, mo, d, at.lat, at.lon), tm = sunTimes(y, mo, d + 1, at.lat, at.lon); if (!t || !tm) return null;
    const end = new Date(t.set.getTime() + th.afterSunsetMin * 60e3), start = new Date(t.rise.getTime() - th.beforeSunriseMin * 60e3);
    const hm = (dt, up) => new Date(dt.getTime() + (up ? 59e3 : 0)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: tz });
    if (now < start) return { ok: false, text: `No towing until ${hm(start, true)}` };
    if (now < end) return { ok: true, text: `Towing ends ${hm(end)}`, sunset: hm(t.set) };
    return { ok: false, text: `No towing until ${hm(new Date(tm.rise.getTime() - th.beforeSunriseMin * 60e3), true)}` };
  }

  // =============================================================== permalink
  let hashTimer = null;
  function updateHash(now) {
    clearTimeout(hashTimer);
    const go = () => {
      if (!map || !S.params) return;
      const p = S.params, R_ = p.rules, c = map.getCenter();
      const q = new URLSearchParams();
      q.set('v', S.view);
      if (S.view === 'rule') q.set('one', S.single);
      if (!isDefault()) {
        q.set('r', [R_.nowake.ft, R_.tow.ft, R_.surf.ft].join(','));
        q.set('f', ['nowake', 'tow', 'surf'].map(k => (R_[k].shore ? 1 : 0) + '' + (R_[k].structures ? 1 : 0)).join(''));
        q.set('p', p.passFt); q.set('run', p.run.ft + ',' + p.run.laneFt);
        if (R_.surf.minDepthFt) q.set('md', R_.surf.minDepthFt);
        if (!p.zonesOn) q.set('z', '0');
        if (!p.levelAdjust) q.set('lvl', '0');
      }
      q.set('m', `${c.lat.toFixed(5)},${c.lng.toFixed(5)},${map.getZoom()}`);
      history.replaceState(null, '', '#' + q.toString());
    };
    if (now) go(); else hashTimer = setTimeout(go, 400);
  }
  function readHash() {
    const q = new URLSearchParams(location.hash.slice(1));
    if (!q.has('v') && !q.has('m')) return;
    const v = q.get('v'); if (['bottom', 'surf', 'pass', 'depth', 'rule'].includes(v)) S.view = v;
    if (['nowake', 'tow', 'surf'].includes(q.get('one'))) S.single = q.get('one');
    const p = S.params, R_ = p.rules, cr = S.cfg.rules;
    const clampTo = (v, hi) => Math.min(hi, Math.max(0, v));
    if (q.get('r')) {
      const [a, b, c] = q.get('r').split(',').map(Number);
      if ([a, b, c].every(Number.isFinite)) { R_.nowake.ft = clampTo(a, cr.nowake.max * 2); R_.tow.ft = clampTo(b, cr.tow.max * 2); R_.surf.ft = clampTo(c, cr.surf.max * 2); }
    }
    if (q.get('f') && /^[01]{6}$/.test(q.get('f'))) { const f = q.get('f'); ['nowake', 'tow', 'surf'].forEach((k, i) => { R_[k].shore = f[2 * i] === '1'; R_[k].structures = f[2 * i + 1] === '1'; }); }
    if (q.get('p') && Number.isFinite(+q.get('p'))) p.passFt = clampTo(+q.get('p'), cr.pass.max * 2);
    if (q.get('run')) { const [a, b] = q.get('run').split(',').map(Number); if (Number.isFinite(a)) p.run.ft = clampTo(a, 20000); if (Number.isFinite(b)) p.run.laneFt = clampTo(b, 600); }
    if (q.get('md') && Number.isFinite(+q.get('md'))) R_.surf.minDepthFt = clampTo(+q.get('md'), 60);
    if (q.get('z') === '0') p.zonesOn = false;
    if (q.get('lvl') === '0') p.levelAdjust = false;
    if (q.get('m')) {
      const [a, b, z] = q.get('m').split(',').map(Number), B = S.reach.bounds_lonlat, pad = 0.1;
      if ([a, b, z].every(Number.isFinite)) S.startView = [clampTo(a - (B[1] - pad), B[3] - B[1] + 2 * pad) + B[1] - pad, clampTo(b - (B[0] - pad), B[2] - B[0] + 2 * pad) + B[0] - pad, Math.min(20, Math.max(11, z))];
    }
  }

  // =================================================================== pages
  function renderRulesPage() {
    const r = S.cfg.rules;
    const chip = f => `<span class="force ${esc(f || 'law')}">${{ law: 'LAW', guideline: 'GUIDELINE', guidance: 'GUIDANCE' }[f] || 'LAW'}</span>`;
    const cite = c => c.citation ? `<p class="cite">${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.citation)}</a>` : esc(c.citation)}</p>` : '';
    const card = (k, dist) => {
      const c = r[k];
      return `<div class="rulecard"><span class="dist">${dist}</span><div class="who">${chip(c.force)} ${esc(c.who)}</div><h3>${esc(c.label)}</h3><p>${esc(c.text)}</p>` +
        `<p><b>On this map:</b> ${esc(c.mapping || '')}</p>${cite(c)}</div>`;
    };
    const extra = (S.cfg.extraRules || []).map(e => `<div class="rulecard"><div class="who">${chip(e.force)} ${esc(e.who)}</div><h3>${esc(e.label)}</h3><p>${esc(e.text)}</p>${cite(e)}</div>`).join('');
    $('#rulesList').innerHTML = card('nowake', r.nowake.ft + ' ft') + card('tow', r.tow.ft + ' ft') + card('surf', r.surf.ft + ' ft') + card('pass', r.pass.ft + ' ft') +
      `<div class="rulecard"><span class="dist">${fmtFt(r.run.ft)} ft</span><div class="who">${chip('guidance')} HLWID specification</div><h3>Straight lanes</h3><p>Where a straight line at least ${fmtFt(r.run.ft)} ft long and ${r.run.laneFt} ft wide (a boat plus its skier's or surfer's swing) fits entirely inside the towing water — a full pull or a long surf run without turning.</p></div>` + extra;
    $('#rulesAsOf').textContent = `Rules checked against ${place().rulesSource || 'the governing codes'} as of ${new Date(S.cfg.rulesAsOf + 'T12:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}. Not legal advice — buoys, signs and officers govern.`;
  }
  function renderAbout() {
    const rc = S.reach, feats = S.base.features;
    const isDock = f => ['dock', 'shared_dock'].includes(f.properties.tag);
    const osm = feats.filter(f => isDock(f) && String(f.properties.source || '').startsWith('osm')).length;
    const byHand = feats.filter(f => isDock(f) && !String(f.properties.source || '').startsWith('osm') && f.properties.status !== 'unreviewed').length;
    const cand = feats.filter(f => f.properties.status === 'unreviewed').length;
    $('#aboutData').innerHTML =
      `<p><b>What it is.</b> A screening map of which setbacks each spot clears on ${esc(place().what || S.cfg.title)}, built from the shoreline, every dock and structure, and the designated zones — measured exactly, not eyeballed. Change a rule and the map, acreage, and downloads update in your browser. ${esc(place().preparedFor || '')}</p>` +
      `<p><b>Shoreline.</b> ${esc(rc.water.lineage)} (${fmtAc(rc.water.area_ac)} ac).` +
      (S.cfg.compare ? ` Shore-only, the engine reproduces the ${esc(S.cfg.compare.label)} buffers to within 1% (${S.cfg.compare.towFt} ft: ${S.cfg.compare.engineAc} vs ${S.cfg.compare.towAc} ac).` : '') +
      (rc.approach ? ` The approach beyond the analysed water is ${esc(rc.approach.lineage)} and shown as no-wake.` : '') + ` Setbacks are measured from this summer full-pool shoreline; the law measures from the waterline at the time, so at low water the true lines sit further out.</p>` +
      `<p><b>Docks.</b> ${osm} piers mapped in OpenStreetMap${byHand ? ` and ${byHand} docks added or confirmed by hand` : ''} count as structures for the 100/150/200-ft rules, and the USGS shoreline already notches around many larger docks, so their edges count as shore. ` +
      `A trial computer-vision pass over aerial imagery mostly picked up wake glints and tree shadows, so auto-detected docks stay out of the numbers until someone confirms them in Edit map${cand ? ` (${cand} waiting)` : ''}. ` +
      `Unmapped docks are the biggest gap in this draft: a dock, boom or swim float that isn't on the map still counts on the water.</p>` +
      `<p><b>Depth.</b> ${esc(rc.depth.lineage)}. ${esc(S.cfg.depth.note)}</p>` +
      `<p><b>Accuracy.</b> ${esc(S.cfg.disclaimer)}</p>` +
      `<p><b>Credits.</b> ${esc(S.cfg.credits)} ${esc(S.cfg.madeBy || '')}.</p>`;
    $('#footCredits').textContent = S.cfg.credits;
    $('#footDisc').textContent = `${S.cfg.disclaimer} ${S.cfg.status} · map ${S.cfg.mapVersion} · rules as of ${S.cfg.rulesAsOf}.`;
    const c = S.cfg.contact;
    $('#ctaMail').href = `mailto:${c.email}?subject=${encodeURIComponent('Boating-zone map for our water')}`;
  }

  // ================================================================== wiring
  function switchTab(id) {
    $$('.tab').forEach(t => { const on = t.dataset.tab === id; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); });
    $$('.tabsec').forEach(s => { s.hidden = s.id !== id; });
  }
  function setView(v) {
    S.view = v;
    $$('.view').forEach(b => { const on = b.dataset.view === v; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    const vb = document.querySelector('.view.on'); if (vb && vb.scrollIntoView) vb.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    $('#rulepick').hidden = v !== 'rule';
    $$('#rulepick .chip').forEach(c => { c.classList.toggle('on', c.dataset.rule === S.single);
      c.textContent = { nowake: `No-wake ${S.params.rules.nowake.ft} ft`, tow: `No-tow ${S.params.rules.tow.ft} ft`, surf: `Surf guide ${S.params.rules.surf.ft} ft` }[c.dataset.rule]; });
    renderStatic();
    schedule(10);
  }
  function wireUI() {
    window.addEventListener('storage', e => { if (e.key === LS.feats) otherTabSaved(); });
    window.addEventListener('beforeunload', e => { if (S.saveFailed && diffCount().n) { e.preventDefault(); e.returnValue = ''; } });
    window.addEventListener('online', () => { if (condsStale()) loadConditions(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && condsStale()) loadConditions(); });
    $$('.view').forEach(b => b.onclick = () => setView(b.dataset.view));
    $$('#tRuns .segb').forEach(b => b.onclick = () => setView(b.dataset.act === 'surf' ? 'surf' : 'bottom'));
    const tr = $('#turnFt'), tn = $('#turnNum');
    tr.oninput = () => { tn.value = tr.value; S.turnFt = +tr.value; schedule(120); };
    tn.onchange = () => { const v = Math.max(60, Math.min(1000, +tn.value || 200)); tn.value = v; tr.value = Math.min(500, v); S.turnFt = v; schedule(60); };
    $$('#rulepick .chip').forEach(c => c.onclick = () => { S.single = c.dataset.rule; setView('rule'); });
    $$('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));
    $('#resetRules').onclick = () => { S.params = clone(S.defaults); syncRuleControls(); renderStatic(); schedule(10); };
    $('#optZones').onchange = e => { S.params.zonesOn = e.target.checked; syncRuleControls(); schedule(10); };
    $('#optLevel').onchange = e => { S.params.levelAdjust = e.target.checked; syncRuleControls(); renderStatic(); schedule(10); };
    $('#editMode').onchange = e => setEdit(e.target.checked);
    $('#editBtn').onclick = () => setEdit(!S.edit.on);
    $('#gpsBtn').onclick = toggleGps;
    $('#fitBtn').onclick = () => map.fitBounds(L_.shore.getBounds(), { padding: [20, 20] });
    $('#addPin').onclick = () => { if (!S.edit.on) setEdit(true); const g = S.tags[S.edit.tag].geom; if (g === 'line' || g === 'area') S.edit.tag = 'dock'; buildPalette(); setMode(S.edit.mode === 'pin' ? 'select' : 'pin'); };
    $('#addLine').onclick = () => { if (!S.edit.on) setEdit(true); if (!['line', 'any'].includes(S.tags[S.edit.tag].geom)) { S.edit.tag = 'log_boom'; buildPalette(); } setMode(S.edit.mode === 'line' ? 'select' : 'line'); };
    $('#addArea').onclick = () => { if (!S.edit.on) setEdit(true); if (!['area', 'any'].includes(S.tags[S.edit.tag].geom)) { S.edit.tag = 'no_wake_zone'; buildPalette(); } setMode(S.edit.mode === 'area' ? 'select' : 'area'); };
    $('#undo').onclick = undo; $('#redo').onclick = redo;
    $('#startReview').onclick = startReview;
    $('#exportEdits').onclick = exportEdits;
    if (window.showSaveFilePicker) { $('#saveFile').hidden = false; $('#saveFile').onclick = saveToFile; }
    $('#discardEdits').onclick = discardEdits;
    $('#importFile').onchange = e => { importFile(e.target.files[0]); e.target.value = ''; };
    $('#dlKml').onclick = () => doExport('kml'); $('#dlKmz').onclick = () => doExport('kmz');
    $('#dlGpx').onclick = () => doExport('gpx'); $('#dlGeo').onclick = () => doExport('geojson');
    $('#dlPdf').onclick = () => openPrint(false); $('#dlLink').onclick = copyLink;
    document.addEventListener('keydown', e => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target.tagName || '')) && e.target.type !== 'checkbox' && e.target.type !== 'range';
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && S.edit.on && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (typing) return;
      if (S.review) {
        const k = e.key.toLowerCase();
        if (k === 'y') reviewAct('yes'); else if (k === 'n') reviewAct('no'); else if (k === 'arrowright') reviewAct('skip');
        else if (k === 'arrowleft') reviewAct('prev'); else if (k === 'escape') stopReview();
        else if (k === 't') { const s = $('#reviewcard select'); if (s) s.focus(); }
        else return;
        e.preventDefault(); return;
      }
      if (!S.edit.on) return;
      if (e.key === 'Escape') { setMode('select'); select(null); }
      else if (e.key.toLowerCase() === 'p') $('#addPin').click();
      else if (e.key.toLowerCase() === 'l') $('#addLine').click();
      else if (e.key.toLowerCase() === 'a') $('#addArea').click();
      else if ((e.key === 'Delete' || e.key === 'Backspace') && S.edit.sel) removeFeature(S.edit.sel);
    });
    setView(S.view);
  }

  boot().catch(err => {
    console.error(err);
    S.booted = false; clearTimeout(recTimer); recSeq++;
    const busy = $('#busy'); if (busy) busy.classList.remove('on');
    const fileHint = location.protocol === 'file:' ? ' Open this folder through a web server (python3 -m http.server) rather than as a file.' : '';
    const saved = !!lsGet(LS.feats);
    const box = document.createElement('div');
    box.className = 'bootfail'; box.setAttribute('role', 'alert');
    box.innerHTML = `<b>The map could not load.</b> ${esc(err.message)}.${fileHint}<div class="btnrow">` +
      (saved ? '<button class="btn" id="bfDiscard">Discard this browser\'s saved edits and reload</button>' : '') + '<button class="btn" id="bfReload">Reload</button></div>';
    (document.querySelector('.mapcol') || document.body).appendChild(box);
    const d = $('#bfDiscard'); if (d) d.onclick = () => { lsDel(LS.feats); location.reload(); };
    $('#bfReload').onclick = () => location.reload();
    const h = $('#headline'); if (h) h.textContent = 'The map could not load — see the message on the map.';
  });
})();
