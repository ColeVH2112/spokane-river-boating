/* export.js — distribution formats for the zone map (browser + Node).
 *
 *   model(eng, res, features, cfg, ctx)  -> one export model (lon/lat)
 *   toKML(model[, {flat}]) / toGPX(model) / toGeoJSON(model)  -> strings
 *   zip([{name, data}], deflateRaw?)  -> Promise<Uint8Array>  (KMZ = zipped doc.kml)
 *   label(cfg, key, params) / labelDesc(...)  -> class names with the active distances
 *   localDate()  -> YYYY-MM-DD on the river (Pacific time), for every stamp
 *
 * The same model feeds every format, so the PDF, KMZ, GPX and GeoJSON a boater
 * downloads all describe exactly the zones on screen.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZoneExport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ACRE = 4046.8564224;
  // XML 1.0 forbids most control characters: one pasted from Word would make the whole file unreadable
  const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
  const xmlEsc = s => String(s == null ? '' : s).replace(CTRL, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const round = (v, nd) => { const k = 10 ** nd; return Math.round(v * k) / k; };
  const fmtFt = f => Math.round(f).toLocaleString('en-US');

  function hexToKml(hex, alpha) {            // '#rrggbb' + 0..1 -> 'aabbggrr'
    const h = hex.replace('#', '');
    const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
    return (a + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2)).toLowerCase();
  }
  function localDate(d, tz) {             // YYYY-MM-DD at the water (config place.timeZone), not on the viewer's clock
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Los_Angeles' }).format(d || new Date()); }
    catch (_) { const x = d || new Date(); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
  }
  // config class labels are templates: "Tow zone ({tow} ft+)" -> "Tow zone (200 ft+)" under a what-if
  function fill(tpl, p) {
    if (!tpl || !p) return tpl || '';
    const R = p.rules || {};
    const v = { nowake: R.nowake && R.nowake.ft, tow: R.tow && R.tow.ft, surf: R.surf && R.surf.ft, pass: p.passFt,
                run: p.run && fmtFt(p.run.ft), lane: p.run && p.run.laneFt,
                towpass: R.nowake && p.passFt != null ? 2 * R.nowake.ft + p.passFt : '' };
    return tpl.replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m));
  }
  const label = (cfg, key, p) => fill((cfg.classes[key] || {}).label, p);
  const labelDesc = (cfg, key, p) => fill((cfg.classes[key] || {}).desc, p);

  // ---- geometry clean-up -------------------------------------------------------
  function ringAreaLL(r) { let s = 0; for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return s / 2; }
  function cleanRing(r) {                    // drop repeated vertices (after rounding) and keep it closed
    const out = [];
    for (const c of r) { const q = out[out.length - 1]; if (!q || q[0] !== c[0] || q[1] !== c[1]) out.push(c); }
    if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) out.push(out[0]);
    return out.length >= 4 && new Set(out.slice(0, -1).map(c => c[0] + ',' + c[1])).size >= 3 ? out : null;
  }
  // RFC 7946 winding: exterior counter-clockwise, holes clockwise
  function rewind(poly) {
    return poly.map((r, k) => { const a = ringAreaLL(r); return (k === 0 ? a < 0 : a > 0) ? r.slice().reverse() : r; });
  }
  function cleanPolys(polys) {
    const out = [];
    for (const poly of polys) {
      const rings = poly.map(cleanRing);
      if (!rings[0]) continue;
      out.push(rewind([rings[0], ...rings.slice(1).filter(Boolean)]));
    }
    return out;
  }
  const MIN_RING_M2 = 25;   // marching-squares specks smaller than one 5 m cell aren't real water
  function polysLonLat(eng, rings, tol, nd) {
    const simp = rings.filter(r => Math.abs(eng.ringArea(r)) >= MIN_RING_M2).map(r => eng.simplifyRing(r, tol)).filter(r => r.length >= 4);
    return cleanPolys(eng.nestRings(simp).map(poly => poly.map(r => r.map(([x, y]) => {
      const [lon, lat] = eng.toLonLat(x, y);
      return [round(lon, nd), round(lat, nd)];
    }))));
  }
  function ringsLonLat(eng, rings, tol, nd) {   // open rule lines (not nested): keep each ring as a line
    return rings.filter(r => Math.abs(eng.ringArea(r)) >= MIN_RING_M2).map(r => eng.simplifyRing(r, tol)).map(r => r.map(([x, y]) => {
      const [lon, lat] = eng.toLonLat(x, y);
      return [round(lon, nd), round(lat, nd)];
    })).map(cleanRing).filter(Boolean);
  }
  function utmPolysLonLat(eng, polys, nd) {
    return cleanPolys(polys.map(poly => poly.map(r => r.map(([x, y]) => {
      const [lon, lat] = eng.toLonLat(x, y);
      return [round(lon, nd), round(lat, nd)];
    }))));
  }
  const PENDING = { unreviewed: 1, imported: 1 };
  // the time rule that applies on top of every distance: no towing after dark (from config.towHours)
  function towHoursText(cfg) {
    const th = cfg.towHours; if (!th) return '';
    const h = m => m % 60 ? `${m} min` : `${m / 60} h`;
    return `No towing anywhere from ${h(th.afterSunsetMin)} after sunset to ${h(th.beforeSunriseMin)} before sunrise (${th.citation}).`;
  }    // not on the map (or in the numbers) until confirmed
  // every coordinate a finite lon/lat pair (a damaged record must not turn into a pin at 0,0)
  function coordsOK(g) {
    const walk = a => Array.isArray(a) && a.length > 0 && (typeof a[0] === 'number' ? a.length >= 2 && Number.isFinite(a[0]) && Number.isFinite(a[1]) : a.every(walk));
    return !!g && walk(g.coordinates);
  }
  function geomPolys(geom) {               // GeoJSON Polygon/MultiPolygon -> [[ring..]..]
    if (!geom) return [];
    if (geom.type === 'Polygon') return cleanPolys([geom.coordinates]);
    if (geom.type === 'MultiPolygon') return cleanPolys(geom.coordinates);
    return [];
  }
  function fmtAc(a) { return a >= 100 ? Math.round(a).toLocaleString('en-US') : a >= 10 ? a.toFixed(0) : a.toFixed(1); }
  const ZONE_STYLE = { no_wake: ['#8a1630', 0.45, 'Designated no-wake'], no_motor: ['#c2185b', 0.5, 'No motors'], no_entry: ['#111111', 0.6, 'No entry'] };

  // ctx: { params, activity, official, levelOffsetFt, title, subtitle, url, generated, label, simplifyM, include: {docks, width} }
  function model(eng, res, features, cfg, ctx) {
    ctx = ctx || {};
    const tol = ctx.simplifyM != null ? ctx.simplifyM : 0.75;
    const p = ctx.params, R = p.rules, nd = 6, act = ctx.activity || 'tow';
    const classes = cfg.classes;
    const S = res.stats || {};
    const layers = [];
    const towTotal = `Tow zone in total (${R.tow.ft} ft+): ${fmtAc(S.tow_ok_ac || 0)} ac.` + (towHoursText(cfg) ? ' ' + towHoursText(cfg) : '');
    const bandDesc = {
      idle: `No wake — idle or steerage speed, never over 5 mph. Within ${R.nowake.ft} ft of shore${R.nowake.structures ? ', docks and structures' : ''}, plus the designated zones, which carry their own rules: ` +
        `no-wake zones 5 mph with a wake under 4 in, no-motor zones no motors at all, no-entry zones keep out (see "Designated zones").`,
      cruise: `Wake OK, no towing: ${R.nowake.ft}–${R.tow.ft} ft from shore${R.tow.structures ? '/docks/structures' : ''}. Inside the county's 150-ft no-tow setback: no skiing, tubing or wakeboarding; wake surfing treated the same (interpretation). Speed limits 35 mph day / 25 night.`,
      tow: `Tow zone, ${R.tow.ft}–${R.surf.ft} ft from shore${R.tow.structures ? ', docks and structures' : ''} — outside ${cfg.rules.tow.zoneName || 'the no-tow setback'}: skiing, tubing, wakeboarding; wake surfing treated the same (interpretation). ${towTotal}`,
      surf: `Tow zone that also meets the ${R.surf.ft}-ft wake-surf guideline from shore${R.surf.structures ? ', docks and structures' : ''} (WSIA Wake Responsibly / IDPR Mind Your Wake — guideline, not law)${R.surf.minDepthFt ? ` and is ${R.surf.minDepthFt} ft+ deep` : ''}. ${towTotal}`,
    };
    const bandName = {
      idle: label(cfg, 'idle', p), cruise: label(cfg, 'cruise', p),
      tow: `Tow zone, ${R.tow.ft}–${R.surf.ft} ft`, surf: `Tow zone + ${R.surf.ft}-ft surf guideline`,
    };
    for (const key of ['idle', 'cruise', 'tow', 'surf']) {
      const b = res.bands[key], c = classes[key];
      layers.push({ id: key, name: bandName[key], group: 'zones', color: c.color, opacity: c.kmlOpacity || 0.5,
        area_ac: b.area / ACRE, desc: bandDesc[key], polygons: polysLonLat(eng, b.rings, tol, nd) });
    }
    if (res.runs && res.runs.rings.length) {
      const c = classes.runs;
      layers.push({ id: 'runs', name: `Straight lanes ${fmtFt(p.run.ft)} ft+`, group: 'runs',
        color: c.color, opacity: 0.25, outline: true, area_ac: res.runs.area / ACRE,
        desc: `Straight lanes at least ${fmtFt(p.run.ft)} ft long and ${Math.round(res.runs.laneFt)} ft wide inside the ${act === 'surf' ? 'wake-surf' : 'tow'} zone.`,
        polygons: polysLonLat(eng, res.runs.rings, tol, nd) });
    }
    if (res.width && ctx.include && ctx.include.width) {
      for (const key of ['narrow', 'twoway', 'surfpass']) {
        const b = res.width.classes[key], c = classes[key];
        layers.push({ id: key, name: label(cfg, key, p), group: 'width', color: c.color, opacity: 0.45, area_ac: b.area / ACRE,
          desc: labelDesc(cfg, key, p), polygons: polysLonLat(eng, b.rings, tol, nd) });
      }
    }
    // the rule lines themselves (cumulative boundaries) — what a plotter needs
    const ruleLines = [];
    if (res.lines) {
      const defs = [['wake', `${R.nowake.ft}-ft no-wake line`, `No-wake setback: no wake on the shore side of this line (${R.nowake.ft} ft from shore${R.nowake.structures ? ' and docks' : ''}). Designated zones apply on their own.`, classes.cruise.color],
                    ['tow', `${R.tow.ft}-ft no-tow line`, `County no-tow setback: no towing on the shore side of this line (${R.tow.ft} ft from shore${R.tow.structures ? ' and docks' : ''}).`, classes.tow.color],
                    ['surf', `${R.surf.ft}-ft surf-guideline line`, `The ${R.surf.ft}-ft wake-surf guideline is met on the river side of this line (guideline, not law).`, classes.surf.color]];
      for (const [k, name, desc, color] of defs) if (res.lines[k]) ruleLines.push({ id: k, name, desc, color, rings: ringsLonLat(eng, res.lines[k], Math.max(tol, 1.5), nd) });
    }
    // designated zones + the lake approach (all no-wake)
    const zonePolys = [];
    for (const f of features.features) {
      const g = f.geometry;
      if (!ZONE_TAGS[f.properties.tag] || f.properties.hidden || PENDING[f.properties.status] || !coordsOK(g)) continue;
      if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;            // a zone needs an area
      const polygons = geomPolys(g);
      if (!polygons.length) continue;
      zonePolys.push({ name: f.properties.name || 'Designated zone', note: f.properties.note || '', type: ZONE_TAGS[f.properties.tag],
        when: f.properties.when || 'always', polygons });
    }
    if (eng.approachPolys && eng.approachPolys.length) {
      const ap = cfg.approach || {};
      zonePolys.push({ name: ap.name || 'Approach — no wake', note: ap.note || 'Designated no-wake zone.',
        type: 'no_wake', polygons: utmPolysLonLat(eng, eng.approachPolys, nd) });
    }
    layers.push({ id: 'nwz', name: 'Designated zones', group: 'rules', color: classes.nwz.color, opacity: 0.45,
      desc: 'Designated no-wake, no-motor and no-entry zones (boundaries approximate pending official HLWID data).', parts: zonePolys });

    const tags = Object.create(null);    // no Object.prototype keys: 'constructor' is not a tag
    for (const t of cfg.tags) tags[t.id] = t;
    const points = [], lines = [], areas = [];
    for (const f of features.features) {
      const pr = f.properties, t = tags[pr.tag] || tags.other;
      if (ZONE_TAGS[pr.tag] || pr.hidden || PENDING[pr.status]) continue;   // pending features aren't part of the map yet
      // private docks (showOnMap: false) shape the zones but aren't boater waypoints: in only when asked (GIS, the in-app option)
      const offMap = t.showOnMap === false;
      if (offMap && !(ctx.include && ctx.include.docks)) continue;
      const base = { name: pr.name || t.label, named: !!pr.name, short: pr.short || '', tag: pr.tag, label: t.label, note: pr.note || '', color: t.color, offMap,
        status: pr.status || '', structure: pr.structure != null ? !!pr.structure : !!t.structure, sym: t.gpx, icon: t.kml, gpxShort: t.short || '' };
      const g = f.geometry;
      if (!g || !coordsOK(g)) continue;
      if (g.type === 'Point') points.push(Object.assign(base, { lon: round(g.coordinates[0], 7), lat: round(g.coordinates[1], 7) }));
      else if (g.type === 'LineString') lines.push(Object.assign(base, { coords: g.coordinates }));
      else if (g.type === 'Polygon' || g.type === 'MultiPolygon') areas.push(Object.assign(base, { polygons: geomPolys(g) }));
    }
    // a "longest lane" is only a lane when it meets the length
    let longest = null;
    if (res.runs && res.runs.longest) {
      const ft = res.runs.longest.m / 0.3048;
      longest = { ft, meets: ft >= p.run.ft,
        coords: [res.runs.longest.a, res.runs.longest.b].map(([x, y]) => eng.toLonLat(x, y).map(v => round(v, 7))) };
    }
    return {
      title: ctx.title || cfg.title, subtitle: ctx.subtitle || cfg.subtitle, url: ctx.url || '',
      generated: ctx.generated || localDate(), label: ctx.label || '', activity: act,
      status: cfg.status || '', mapVersion: cfg.mapVersion || '', rulesAsOf: cfg.rulesAsOf || '',
      official: !!ctx.official, levelOffsetFt: ctx.levelOffsetFt || 0,
      disclaimer: cfg.disclaimer, credits: cfg.credits, madeBy: cfg.madeBy || '', stats: S, params: p,
      keywords: (cfg.place && cfg.place.keywords) || '', towHours: towHoursText(cfg),
      layers, ruleLines, points, lines, areas, longest,
    };
  }
  // one line every format can carry: draft status, version, rules date, water level
  function stamp(m) {
    const lvl = m.levelOffsetFt ? `depths at today's lake level (${Math.abs(m.levelOffsetFt).toFixed(1)} ft ${m.levelOffsetFt > 0 ? 'below' : 'above'} full pool)` : 'depths at summer full pool (2,128 ft)';
    return [m.status, m.mapVersion && 'map ' + m.mapVersion, m.rulesAsOf && 'rules as of ' + m.rulesAsOf, 'built ' + m.generated, lvl].filter(Boolean).join(' · ');
  }

  // ---- KML -------------------------------------------------------------------
  function kmlCoords(ring) { return ring.map(c => c[0] + ',' + c[1] + ',0').join(' '); }
  function kmlPolygon(poly) {
    return '<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>' + kmlCoords(poly[0]) +
      '</coordinates></LinearRing></outerBoundaryIs>' +
      poly.slice(1).map(h => '<innerBoundaryIs><LinearRing><coordinates>' + kmlCoords(h) + '</coordinates></LinearRing></innerBoundaryIs>').join('') +
      '</Polygon>';
  }
  function toKML(m, opts) {
    opts = opts || {};
    const flat = !!opts.flat;   // Google My Maps: one Placemark per polygon, no MultiGeometry, no folders
    const st = [], body = [];
    const placemarks = (name, desc, styleUrl, polys) => flat
      ? polys.map((pg, k) => `<Placemark><name>${xmlEsc(name + (polys.length > 1 ? ' (' + (k + 1) + ')' : ''))}</name><description>${xmlEsc(desc)}</description>` +
          `<styleUrl>${styleUrl}</styleUrl>${kmlPolygon(pg)}</Placemark>`).join('')
      : `<Placemark><name>${xmlEsc(name)}</name><description>${xmlEsc(desc)}</description><styleUrl>${styleUrl}</styleUrl>` +
        `<MultiGeometry>${polys.map(kmlPolygon).join('')}</MultiGeometry></Placemark>`;
    const style = (id, line, lineW, fill, fillOn) => st.push(
      `<Style id="${id}"><LineStyle><color>${line}</color><width>${lineW}</width></LineStyle>` +
      `<PolyStyle><color>${fill}</color><fill>${fillOn ? 1 : 0}</fill><outline>1</outline></PolyStyle></Style>`);
    const folders = { zones: [], runs: [], width: [], rules: [], lines: [] };
    for (const [t, [c, o]] of Object.entries(ZONE_STYLE)) style('s_zone_' + t, hexToKml(c, 0.95), 2, hexToKml(c, o), true);
    for (const L of m.layers) {
      style('s_' + L.id, hexToKml(L.color, 0.95), L.outline ? 3 : 1.2, hexToKml(L.color, L.opacity), true);
      const area = L.area_ac != null ? ` · ${fmtAc(L.area_ac)} ac` : '';
      if (L.parts) {
        for (const part of L.parts) {
          if (!part.polygons.length) continue;
          folders[L.group].push(placemarks(part.name, part.note || L.desc, `#s_zone_${part.type || 'no_wake'}`, part.polygons));
        }
        continue;
      }
      if (!L.polygons.length) continue;
      folders[L.group].push(placemarks(L.name + area, L.desc, `#s_${L.id}`, L.polygons));
    }
    for (const ln of m.ruleLines || []) {
      style('s_line_' + ln.id, hexToKml(ln.color, 1), 2.5, '00000000', false);
      const xml = ring => `<LineString><tessellate>1</tessellate><coordinates>${kmlCoords(ring)}</coordinates></LineString>`;
      if (!ln.rings.length) continue;
      folders.lines.push(flat
        ? ln.rings.map((r, k) => `<Placemark><name>${xmlEsc(ln.name + (ln.rings.length > 1 ? ' (' + (k + 1) + ')' : ''))}</name><description>${xmlEsc(ln.desc)}</description><styleUrl>#s_line_${ln.id}</styleUrl>${xml(r)}</Placemark>`).join('')
        : `<Placemark><name>${xmlEsc(ln.name)}</name><description>${xmlEsc(ln.desc)}</description><styleUrl>#s_line_${ln.id}</styleUrl><MultiGeometry>${ln.rings.map(xml).join('')}</MultiGeometry></Placemark>`);
    }
    if (m.longest) {
      style('s_longest', 'ff000000', 3, '00000000', false);
      const nm = m.longest.meets ? `Longest straight lane · ${fmtFt(m.longest.ft)} ft` : `Longest straight run · ${fmtFt(m.longest.ft)} ft (shorter than ${fmtFt(m.params.run.ft)} ft)`;
      folders.runs.push(`<Placemark><name>${xmlEsc(nm)}</name>` +
        `<styleUrl>#s_longest</styleUrl><LineString><tessellate>1</tessellate><coordinates>${kmlCoords(m.longest.coords)}</coordinates></LineString></Placemark>`);
    }
    const tagStyles = new Set();
    const pinStyle = (pt) => {
      const id = 'p_' + pt.tag;
      if (!tagStyles.has(id)) {
        tagStyles.add(id);
        st.push(`<Style id="${id}"><IconStyle><color>${hexToKml(pt.color, 1)}</color><scale>${pt.tag === 'dock' ? 0.55 : 0.9}</scale>` +
          `<Icon><href>${xmlEsc(pt.icon || 'http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png')}</href></Icon></IconStyle>` +
          `<LabelStyle><scale>${pt.tag === 'dock' ? 0 : 0.8}</scale></LabelStyle>` +
          `<LineStyle><color>${hexToKml(pt.color, 1)}</color><width>3</width></LineStyle>` +
          `<PolyStyle><color>${hexToKml(pt.color, 0.3)}</color></PolyStyle></Style>`);
      }
      return '#' + id;
    };
    const featFolders = {}, hiddenFolders = new Set();
    const put = (f, xml) => {
      (featFolders[f.label] = featFolders[f.label] || []).push(xml);
      if (f.offMap) hiddenFolders.add(f.label);   // hundreds of private docks: off until asked for
    };
    const STATUS = { unreviewed: 'Found automatically — not yet reviewed.', approximate: 'Position approximate.', osm: 'From OpenStreetMap.',
                     derived: 'Derived from the 2004 depth survey.', imported: 'Imported — not yet reviewed.' };
    const descOf = f => [f.label, f.note, f.structure ? 'Counts as a structure for the distance rules.' : '', STATUS[f.status] || '']
      .filter(Boolean).join(' — ');
    for (const pt of m.points) put(pt, `<Placemark><name>${xmlEsc(pt.name)}</name><description>${xmlEsc(descOf(pt))}</description>` +
      `<styleUrl>${pinStyle(pt)}</styleUrl><Point><coordinates>${pt.lon},${pt.lat},0</coordinates></Point></Placemark>`);
    for (const ln of m.lines) put(ln, `<Placemark><name>${xmlEsc(ln.name)}</name><description>${xmlEsc(descOf(ln))}</description>` +
      `<styleUrl>${pinStyle(ln)}</styleUrl><LineString><tessellate>1</tessellate><coordinates>${kmlCoords(ln.coords)}</coordinates></LineString></Placemark>`);
    for (const ar of m.areas) put(ar, placemarks(ar.name, descOf(ar), pinStyle(ar), ar.polygons));

    // flat (My Maps) has no folders to hide, so whatever the model includes is written out
    const folder = (name, items, open, hidden) => !items.length ? '' : flat ? items.join('')
      : `<Folder><name>${xmlEsc(name)}</name>${hidden ? '<visibility>0</visibility>' : ''}<open>${open ? 1 : 0}</open>${items.join('')}</Folder>`;
    const s = m.stats || {};
    const summary = `${m.subtitle}. ${m.label ? m.label + '. ' : ''}Of ${fmtAc(s.water_ac || 0)} acres: tow zone ${fmtAc(s.tow_ok_ac || 0)} ac, ` +
      `of which ${fmtAc(s.surf_ok_ac || 0)} ac also meet the ${m.params.rules.surf.ft}-ft surf guideline; ${s.run_zones || 0} straight lane${s.run_zones === 1 ? '' : 's'} of ${fmtFt(m.params.run.ft)} ft or more. ` +
      `${m.towHours ? m.towHours + ' ' : ''}${stamp(m)}. ${m.disclaimer} ${m.madeBy || ''}${m.url ? ' Interactive map: ' + m.url : ''}`;
    body.push(folder('Setback bands', folders.zones, true));
    body.push(folder('Rule lines', folders.lines, false));
    body.push(folder('Straight lanes', folders.runs, true));
    body.push(folder('Room to pass', folders.width, false));
    body.push(folder('Designated zones (no wake, no motors, no entry)', folders.rules, true));
    for (const [lbl, items] of Object.entries(featFolders)) body.push(folder(lbl, items, false, hiddenFolders.has(lbl)));
    const draft = m.status && /draft/i.test(m.status) ? ' (DRAFT)' : '';
    return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
      `<name>${xmlEsc(m.title + draft + ' — ' + m.generated)}</name><open>1</open><description>${xmlEsc(summary)}</description>` +
      st.join('') + body.join('') + '</Document></kml>\n';
  }

  // ---- GPX 1.1 -----------------------------------------------------------------
  // Older plotters cut waypoint names at 14 characters and key waypoints by name:
  // shorten at a word boundary, then make every name unique.
  function shortName(name, max) {
    let s = String(name || '').replace(CTRL, ' ').replace(/\s*\([^)]*\)/g, '').replace(/\s+[—–-]\s.*$/, '').replace(/[’']/g, '').trim();
    if (s.length <= max) return s;
    let out = '';
    for (const w of s.split(/\s+/)) { if ((out ? out.length + 1 : 0) + w.length > max) break; out = out ? out + ' ' + w : w; }
    return (out || s.slice(0, max)).replace(/[\s,.;:/-]+$/, '');
  }
  function uniqueNames(items, max) {
    const seen = new Map(), out = [];
    for (const it of items) {
      let base = it.base.slice(0, max), name = base, k = 1;
      while (seen.has(name.toLowerCase())) { k++; const suf = ' ' + k; name = base.slice(0, max - suf.length).replace(/\s+$/, '') + suf; }
      seen.set(name.toLowerCase(), 1);
      out.push(name);
    }
    return out;
  }
  function toGPX(m, opts) {
    opts = opts || {};
    const max = opts.nameLen || 14;
    const counters = {};
    const bases = m.points.map(pt => {
      if (pt.short) return { base: shortName(pt.short, max) };
      if (pt.named) return { base: shortName(pt.name, max) };
      const tagShort = shortName(pt.gpxShort || pt.label, max - 4);   // unnamed pins: "Dock 012"
      counters[tagShort] = (counters[tagShort] || 0) + 1;
      return { base: `${tagShort} ${String(counters[tagShort]).padStart(3, '0')}` };
    });
    const names = uniqueNames(bases, max);
    const wpts = m.points.map((pt, i) =>
      `<wpt lat="${pt.lat}" lon="${pt.lon}"><name>${xmlEsc(names[i])}</name>` +
      `<cmt>${xmlEsc(pt.name)}</cmt><desc>${xmlEsc([pt.label, pt.note].filter(Boolean).join(' — '))}</desc>` +
      `<sym>${xmlEsc(pt.sym || 'Waypoint')}</sym><type>${xmlEsc(pt.label)}</type></wpt>`).join('\n');
    const trks = [];
    const seg = ring => '<trkseg>' + ring.map(c => `<trkpt lat="${c[1]}" lon="${c[0]}"/>`).join('') + '</trkseg>';
    const trk = (name, desc, type, rings) => rings.length && trks.push(`<trk><name>${xmlEsc(name)}</name><desc>${xmlEsc(desc || '')}</desc><type>${xmlEsc(type)}</type>` +
      rings.map(seg).join('') + '</trk>');
    // one track per rule line: "tow on the river side of the 150-ft line"
    for (const ln of m.ruleLines || []) trk(ln.name, ln.desc, 'rule-line', ln.rings);
    for (const L of m.layers) {
      if (L.parts) { for (const part of L.parts) trk(part.name, `${(ZONE_STYLE[part.type] || ZONE_STYLE.no_wake)[2]}${part.when === 'posted' ? ' (when posted)' : ''}. ${part.note || ''}`, part.type || 'no_wake', part.polygons.flat()); continue; }
      if (L.id === 'runs' || L.group === 'width') (L.polygons || []).forEach((pg, k) => trk(`${L.name}${L.polygons.length > 1 ? ' ' + (k + 1) : ''}`, L.desc, L.id, pg));
    }
    for (const ln of m.lines) trk(ln.name, [ln.label, ln.note].filter(Boolean).join(' — '), ln.tag, [ln.coords]);
    for (const ar of m.areas) trk(ar.name, [ar.label, ar.note].filter(Boolean).join(' — '), ar.tag, ar.polygons.flat());
    if (m.longest) trk(m.longest.meets ? `Longest straight lane ${fmtFt(m.longest.ft)} ft` : `Longest straight run ${fmtFt(m.longest.ft)} ft`, '', 'runs', [m.longest.coords]);
    const kw = [m.keywords || 'boating zones', m.official ? 'official' : 'custom', m.mapVersion, m.status].filter(Boolean).join(', ');
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<gpx version="1.1" creator="${xmlEsc(m.title)} map" xmlns="http://www.topografix.com/GPX/1/1" ` +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n' +
      `<metadata><name>${xmlEsc(m.title)}</name><desc>${xmlEsc(m.subtitle + (m.label ? ' · ' + m.label : '') + '. ' + (m.towHours ? m.towHours + ' ' : '') + stamp(m) + '. ' + m.disclaimer + (m.madeBy ? ' ' + m.madeBy + '.' : ''))}</desc>` +
      (m.url ? `<link href="${xmlEsc(m.url)}"><text>Interactive map</text></link>` : '') +
      `<time>${m.generated}T12:00:00Z</time><keywords>${xmlEsc(kw)}</keywords></metadata>\n` +
      wpts + '\n' + trks.join('\n') + '\n</gpx>\n';
  }

  // ---- GeoJSON -------------------------------------------------------------------
  function toGeoJSON(m) {
    const feats = [];
    for (const L of m.layers) {
      if (L.parts) {
        for (const part of L.parts) {
          if (!part.polygons || !part.polygons.length) continue;
          const zs = ZONE_STYLE[part.type] || ZONE_STYLE.no_wake;
          feats.push({ type: 'Feature', properties: { layer: 'designated_zone', zone_type: part.type || 'no_wake', when: part.when || 'always',
            name: part.name, description: part.note || L.desc || '', color: zs[0] }, geometry: { type: 'MultiPolygon', coordinates: part.polygons } });
        }
        continue;
      }
      if (!L.polygons || !L.polygons.length) continue;
      feats.push({ type: 'Feature', properties: { layer: L.id, name: L.name, description: L.desc || '',
        area_acres: L.area_ac != null ? Math.round(L.area_ac * 100) / 100 : undefined, color: L.color },
        geometry: { type: 'MultiPolygon', coordinates: L.polygons } });
    }
    for (const ln of m.ruleLines || []) if (ln.rings.length) feats.push({ type: 'Feature', properties: { layer: 'rule_line', rule: ln.id, name: ln.name, description: ln.desc, color: ln.color },
      geometry: { type: 'MultiLineString', coordinates: ln.rings } });
    for (const pt of m.points) feats.push({ type: 'Feature', properties: { layer: 'feature', tag: pt.tag, name: pt.name, note: pt.note, structure: pt.structure, status: pt.status },
      geometry: { type: 'Point', coordinates: [pt.lon, pt.lat] } });
    for (const ln of m.lines) feats.push({ type: 'Feature', properties: { layer: 'feature', tag: ln.tag, name: ln.name, note: ln.note, structure: ln.structure, status: ln.status },
      geometry: { type: 'LineString', coordinates: ln.coords } });
    for (const ar of m.areas) feats.push({ type: 'Feature', properties: { layer: 'feature', tag: ar.tag, name: ar.name, note: ar.note, structure: ar.structure, status: ar.status },
      geometry: { type: 'MultiPolygon', coordinates: ar.polygons } });
    if (m.longest) feats.push({ type: 'Feature', properties: { layer: m.longest.meets ? 'longest_lane' : 'longest_run_short', length_ft: Math.round(m.longest.ft) },
      geometry: { type: 'LineString', coordinates: m.longest.coords } });
    return JSON.stringify({ type: 'FeatureCollection', name: m.title,
      metadata: { subtitle: m.subtitle, generated: m.generated, status: m.status, map_version: m.mapVersion, rules_as_of: m.rulesAsOf,
        official: m.official, activity: m.activity, level_offset_ft: m.levelOffsetFt, criteria: m.label, rules: m.params, stats: m.stats,
        tow_hours: m.towHours, disclaimer: m.disclaimer, credits: m.credits, made_by: m.madeBy, url: m.url },
      features: feats });
  }

  // ---- ZIP (KMZ) ---------------------------------------------------------------------
  let CRC = null;
  function crc32(buf) {
    if (!CRC) {
      CRC = new Int32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC[n] = c; }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }
  // files: [{name, data: Uint8Array}]; deflateRaw: optional (Uint8Array) => Promise<Uint8Array>|Uint8Array
  async function zip(files, deflateRaw) {
    const enc = new TextEncoder(), locals = [], centrals = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data);
      let body = f.data, method = 0;
      if (deflateRaw) {
        try { const z = await deflateRaw(f.data); if (z && z.length < f.data.length) { body = z; method = 8; } } catch (_) { /* store */ }
      }
      const lf = new Uint8Array(30 + name.length), l = new DataView(lf.buffer);
      l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true); l.setUint16(8, method, true);
      l.setUint16(10, 0, true); l.setUint16(12, 0x21, true);       // 1980-01-01 00:00
      l.setUint32(14, crc, true); l.setUint32(18, body.length, true); l.setUint32(22, f.data.length, true);
      l.setUint16(26, name.length, true); lf.set(name, 30);
      const cd = new Uint8Array(46 + name.length), c = new DataView(cd.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, method, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true);
      c.setUint32(16, crc, true); c.setUint32(20, body.length, true); c.setUint32(24, f.data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true); cd.set(name, 46);
      locals.push(lf, body); centrals.push(cd);
      offset += lf.length + body.length;
    }
    const cdSize = centrals.reduce((s, b) => s + b.length, 0);
    const eo = new Uint8Array(22), e = new DataView(eo.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    const parts = [...locals, ...centrals, eo], out = new Uint8Array(offset + cdSize + 22);
    let o = 0;
    for (const b of parts) { out.set(b, o); o += b.length; }
    return out;
  }
  // browser deflate-raw via CompressionStream (Chrome 80+, Safari 16.4+, Firefox 113+)
  async function browserDeflateRaw(data) {
    if (typeof CompressionStream === 'undefined') return null;
    const cs = new CompressionStream('deflate-raw');
    const buf = await new Response(new Blob([data]).stream().pipeThrough(cs)).arrayBuffer();
    return new Uint8Array(buf);
  }

  // ---- features -> engine inputs (one rule for app, print page and build) -----------
  // A feature is a structure when its tag says so, unless its own `structure`
  // property overrides; designated zones (no-wake / no-motor / no-entry) all mean
  // "idle only" for the bands — the type changes the message.
  const ZONE_TAGS = { no_wake_zone: 'no_wake', no_motor_zone: 'no_motor', no_entry_zone: 'no_entry' };
  function engineInputs(eng, fc, cfg) {
    const tags = Object.create(null);    // no Object.prototype keys: 'constructor' is not a tag
    for (const t of cfg.tags) tags[t.id] = t;
    const utm = c => eng.fromLonLat(c[0], c[1]);
    const polys = g => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [])
      .filter(p => p.length && p[0].length > 3).map(p => p.map(r => r.map(utm)));
    const structures = [], zones = [];
    for (const f of fc.features) {
      const pr = f.properties || {}, g = f.geometry;
      // imported guesses and auto-detected candidates count only once someone confirms them (Edit map -> Review)
      if (!g || pr.hidden || PENDING[pr.status] || !coordsOK(g)) continue;
      const t = tags[pr.tag] || tags.other;
      if (ZONE_TAGS[pr.tag]) {
        const ps = polys(g);    // a zone needs an area; lines/points tagged as zones are skipped
        if (ps.length) zones.push({ polys: ps, ref: pr.id, name: pr.name, type: ZONE_TAGS[pr.tag], when: pr.when || 'always' });
        continue;
      }
      if (!(pr.structure != null ? !!pr.structure : !!t.structure)) continue;
      const r = t.radiusM || 0;
      const add = (type, c) => {
        if (type === 'Point') { const [x, y] = utm(c); structures.push({ kind: 'point', x, y, r, ref: pr.id }); }
        else if (type === 'LineString' && c.length) structures.push({ kind: 'line', pts: c.map(utm), hw: r, ref: pr.id });
      };
      if (g.type === 'Point' || g.type === 'LineString') add(g.type, g.coordinates);
      else if (g.type === 'MultiPoint') for (const c of g.coordinates) add('Point', c);
      else if (g.type === 'MultiLineString') for (const c of g.coordinates) add('LineString', c);
      else if (g.type === 'Polygon' || g.type === 'MultiPolygon') { const ps = polys(g); if (ps.length) structures.push({ kind: 'area', polys: ps, ref: pr.id }); }
    }
    return { structures, zones };
  }

  return { model, toKML, toGPX, toGeoJSON, zip, browserDeflateRaw, crc32, xmlEsc, hexToKml, engineInputs, coordsOK,
           label, labelDesc, fill, localDate, stamp, shortName, ZONE_TAGS };
});
