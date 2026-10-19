/* engine.js — boating-zone engine for one water (runs in the browser and in Node).
 *
 * Everything is measured, not rasterized-then-guessed:
 *   - exact Euclidean distance from every grid node to the shoreline polygon
 *     (vector segments, spatial-bucket search) — matches ArcGIS/shapely buffers
 *   - exact distance to every structure (dock points, log-boom lines, areas)
 *   - exact signed distance to the designated no-wake zones
 * Rule bands are fields built from those distances; their zero sets are traced
 * with marching squares (linear sub-cell interpolation), so zone edges are
 * smooth polygons that export cleanly to KML/GPX/GeoJSON.
 *
 * Coordinates: UTM (metres, y = northing) inside the engine; lon/lat at the
 * edges via an exact Krüger-series transverse Mercator.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZoneEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FT = 0.3048;
  const M2_PER_ACRE = 4046.8564224;
  const BIG = 1e7;
  // depths are stored in 0.5-ft steps and the TIN leaves plateaus exactly on contour values:
  // a node at exactly X ft counts as "X ft deep" (>=), never on both sides or neither. The
  // epsilon sits below the gauge's 0.01-ft resolution, so a level offset can't recreate a tie.
  const DEPTH_EPS = 0.005;

  // ---- projection: UTM <-> WGS84 (Karney 2011 / Krüger 6th order) ---------
  function makeUTM(zone, south) {
    const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996;   // GRS80 (NAD83 ≈ WGS84 here)
    const lon0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180, FE = 500000, FN = south ? 10000000 : 0;
    const e = Math.sqrt(f * (2 - f)), n = f / (2 - f);
    const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
    const A = a / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
    const al = [0,
      n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288 + 7891 * n6 / 37800,
      13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630 - 1983433 * n6 / 1935360,
      61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880 + 167603 * n6 / 181440,
      49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600,
      34729 * n5 / 80640 - 3418889 * n6 / 1995840,
      212378941 * n6 / 319334400];
    const be = [0,
      n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360 - 81 * n5 / 512 + 96199 * n6 / 604800,
      n2 / 48 + n3 / 15 - 437 * n4 / 1440 + 46 * n5 / 105 - 1118711 * n6 / 3870720,
      17 * n3 / 480 - 37 * n4 / 840 - 209 * n5 / 4480 + 5569 * n6 / 90720,
      4397 * n4 / 161280 - 11 * n5 / 504 - 830251 * n6 / 7257600,
      4583 * n5 / 161280 - 108847 * n6 / 3991680,
      20648693 * n6 / 638668800];
    function forward(lon, lat) {
      const phi = lat * Math.PI / 180, lam = lon * Math.PI / 180 - lon0;
      const tau = Math.tan(phi);
      const sigma = Math.sinh(e * Math.atanh(e * tau / Math.sqrt(1 + tau * tau)));
      const taup = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
      const xip = Math.atan2(taup, Math.cos(lam));
      const etap = Math.asinh(Math.sin(lam) / Math.sqrt(taup * taup + Math.cos(lam) ** 2));
      let xi = xip, eta = etap;
      for (let j = 1; j <= 6; j++) {
        xi += al[j] * Math.sin(2 * j * xip) * Math.cosh(2 * j * etap);
        eta += al[j] * Math.cos(2 * j * xip) * Math.sinh(2 * j * etap);
      }
      return [FE + k0 * A * eta, FN + k0 * A * xi];
    }
    function inverse(x, y) {
      const eta = (x - FE) / (k0 * A), xi = (y - FN) / (k0 * A);
      let xip = xi, etap = eta;
      for (let j = 1; j <= 6; j++) {
        xip -= be[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
        etap -= be[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
      }
      const sh = Math.sinh(etap), sx = Math.sin(xip), cx = Math.cos(xip);
      const taup = sx / Math.sqrt(sh * sh + cx * cx);
      const lam = Math.atan2(sh, cx);
      let tau = taup;
      for (let i = 0; i < 8; i++) {
        const sigma = Math.sinh(e * Math.atanh(e * tau / Math.sqrt(1 + tau * tau)));
        const ti = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
        const d = (taup - ti) / Math.sqrt(1 + ti * ti) *
          (1 + (1 - e * e) * tau * tau) / ((1 - e * e) * Math.sqrt(1 + tau * tau));
        tau += d;
        if (Math.abs(d) < 1e-13) break;
      }
      return [(lon0 + lam) * 180 / Math.PI, Math.atan(tau) * 180 / Math.PI];
    }
    return { forward, inverse };
  }

  // ---- geometry helpers ----------------------------------------------------
  function segDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + t * dx - px, qy = ay + t * dy - py;
    return qx * qx + qy * qy;
  }
  function ringArea(r) {           // signed shoelace (+ = counter-clockwise, y up)
    let s = 0;
    for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
    return s / 2;
  }
  function pointInRing(x, y, r) {
    let inside = false;
    for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) {
      const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  // polygons = [[outer, hole...], ...]; even-odd over every ring
  function pointInPolys(x, y, polys) {
    let inside = false;
    for (const p of polys) for (const r of p) if (pointInRing(x, y, r)) inside = !inside;
    return inside;
  }
  function ringsOf(polys) { const out = []; for (const p of polys) for (const r of p) out.push(r); return out; }
  function bboxOf(rings) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rings) for (const [x, y] of r) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  }
  // Douglas–Peucker on an open or closed ring (closed rings keep first/last)
  function simplify(pts, tol) {
    if (pts.length < 5 || tol <= 0) return pts;
    const t2 = tol * tol, keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let best = -1, bd = t2;
      for (let i = a + 1; i < b; i++) {
        const d = segDist2(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
        if (d > bd) { bd = d; best = i; }
      }
      if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
    }
    const out = [];
    for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }
  function simplifyRing(r, tol) {
    if (r.length < 8) return r;
    // split a closed ring at its farthest-from-start vertex so DP keeps it closed
    let far = 0, fd = -1;
    for (let i = 1; i < r.length; i++) {
      const d = (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2;
      if (d > fd) { fd = d; far = i; }
    }
    const a = simplify(r.slice(0, far + 1), tol), b = simplify(r.slice(far), tol);
    const out = a.concat(b.slice(1));
    return out.length >= 4 ? out : r;
  }
  // group rings (outer = ccw, hole = cw) into [[outer, hole...], ...]
  function nestRings(rings) {
    const outers = [], holes = [];
    for (const r of rings) {
      const a = ringArea(r);
      if (Math.abs(a) < 1e-6) continue;
      (a > 0 ? outers : holes).push({ r, a: Math.abs(a), bb: bboxOf([r]) });
    }
    outers.sort((p, q) => p.a - q.a);
    const polys = outers.map(o => ({ o, holes: [] }));
    for (const h of holes) {
      const [x, y] = h.r[0];
      for (const p of polys) {           // smallest containing outer wins
        const bb = p.o.bb;
        if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3] || p.o.a < h.a) continue;
        if (pointInRing(x, y, p.o.r)) { p.holes.push(h.r); break; }
      }
    }
    return polys.map(p => [p.o.r, ...p.holes]);
  }

  // ---- marching squares ------------------------------------------------------
  // Traces {f > 0} on node values f (row-major, w x h; node (c,r) at grid
  // position c, r). Returns closed rings in grid coordinates with the region on
  // the left in y-up terms: outers counter-clockwise, holes clockwise.
  function makeContourer(w, h) {
    const H = h * (w - 1), NE = H + (h - 1) * w;
    const next = new Int32Array(NE).fill(-1);
    const frac = new Float32Array(NE);
    const touched = [];
    function hId(c, r) { return r * (w - 1) + c; }          // (c,r)-(c+1,r)
    function vId(c, r) { return H + r * w + c; }            // (c,r)-(c,r+1)
    function edgePoint(id) {
      if (id < H) { const r = (id / (w - 1)) | 0, c = id - r * (w - 1); return [c + frac[id], r]; }
      const k = id - H, r = (k / w) | 0, c = k - r * w;
      return [c, r + frac[id]];
    }
    // corners in walk order TL, TR, BR, BL; edge k joins corner k -> corner k+1
    return function contour(f, bbox) {
      const c0 = bbox ? Math.max(0, bbox[0]) : 0, r0 = bbox ? Math.max(0, bbox[1]) : 0;
      const c1 = bbox ? Math.min(w - 1, bbox[2]) : w - 1, r1 = bbox ? Math.min(h - 1, bbox[3]) : h - 1;
      const ids = [0, 0, 0, 0], vals = [0, 0, 0, 0], typ = [0, 0, 0, 0], at = [0, 0, 0, 0];
      for (let r = r0; r < r1; r++) {
        for (let c = c0; c < c1; c++) {
          const i = r * w + c;
          const a = f[i], b = f[i + 1], d = f[i + w + 1], e = f[i + w];   // TL TR BR BL
          const code = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (d > 0 ? 4 : 0) | (e > 0 ? 8 : 0);
          if (code === 0 || code === 15) continue;
          vals[0] = a; vals[1] = b; vals[2] = d; vals[3] = e;
          let n = 0;
          for (let k = 0; k < 4; k++) {
            const va = vals[k], vb = vals[(k + 1) & 3];
            const ia = va > 0, ib = vb > 0;
            if (ia === ib) continue;
            let id, t;
            const tt = va / (va - vb);   // fraction from corner k toward corner k+1
            if (k === 0) { id = hId(c, r); t = tt; }
            else if (k === 1) { id = vId(c + 1, r); t = tt; }
            else if (k === 2) { id = hId(c, r + 1); t = 1 - tt; }
            else { id = vId(c, r); t = 1 - tt; }
            frac[id] = t;
            ids[n] = id; typ[n] = ia ? 1 : 0;   // 1 = exit (inside -> outside), 0 = entry
            at[n] = k; n++;
          }
          if (n === 2) {
            const en = typ[0] === 0 ? 0 : 1, ex = 1 - en;
            next[ids[en]] = ids[ex]; touched.push(ids[en]);
          } else if (n === 4) {
            const centre = (a + b + d + e) / 4 > 0;
            for (let k = 0; k < 4; k++) {
              if (typ[k] !== 0) continue;                    // entries only
              const j = centre ? (k + 3) & 3 : (k + 1) & 3;  // previous / next exit
              next[ids[k]] = ids[j]; touched.push(ids[k]);
            }
          }
        }
      }
      const rings = [];
      for (const s of touched) {
        if (next[s] < 0) continue;
        const ring = [];
        let cur = s, guard = 0;
        while (next[cur] >= 0 && guard++ < 4e6) {
          ring.push(edgePoint(cur));
          const nx = next[cur]; next[cur] = -1; cur = nx;
        }
        if (ring.length >= 3) { ring.push(ring[0]); rings.push(ring); }
      }
      touched.length = 0;
      return rings;
    };
  }

  // ---- scanline fill of polygons at node centres (even-odd) ------------------
  function fillPolys(polys, g, out, value) {
    const rings = ringsOf(polys);
    const xs = [];
    for (let r = 0; r < g.h; r++) {
      const y = g.Y(r);
      xs.length = 0;
      for (const ring of rings) {
        for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
          const yi = ring[i][1], yj = ring[j][1];
          if ((yi > y) !== (yj > y)) xs.push(ring[i][0] + (y - yi) * (ring[j][0] - ring[i][0]) / (yj - yi));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const ca = Math.max(0, Math.ceil(g.colF(xs[k]))), cb = Math.min(g.w - 1, Math.floor(g.colF(xs[k + 1])));
        for (let c = ca; c <= cb; c++) out[r * g.w + c] = value;
      }
    }
  }

  // ---- segment bucket index (exact nearest-segment distance) ----------------
  function makeSegIndex(segs, B) {           // segs: Float64Array [ax,ay,bx,by,...]
    const ns = segs.length / 4;
    if (!ns) return { nearest: (px, py, maxD) => maxD };   // nothing to measure to
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let s = 0; s < ns; s++) {
      const o = s * 4;
      x0 = Math.min(x0, segs[o], segs[o + 2]); x1 = Math.max(x1, segs[o], segs[o + 2]);
      y0 = Math.min(y0, segs[o + 1], segs[o + 3]); y1 = Math.max(y1, segs[o + 1], segs[o + 3]);
    }
    const bw = Math.max(1, Math.ceil((x1 - x0) / B) + 1), bh = Math.max(1, Math.ceil((y1 - y0) / B) + 1);
    const buckets = Array.from({ length: bw * bh }, () => []);
    for (let s = 0; s < ns; s++) {
      const o = s * 4;
      const ba = Math.floor((Math.min(segs[o], segs[o + 2]) - x0) / B), bb = Math.floor((Math.max(segs[o], segs[o + 2]) - x0) / B);
      const ca = Math.floor((Math.min(segs[o + 1], segs[o + 3]) - y0) / B), cb = Math.floor((Math.max(segs[o + 1], segs[o + 3]) - y0) / B);
      for (let j = ca; j <= cb; j++) for (let i = ba; i <= bb; i++) buckets[j * bw + i].push(s);
    }
    const stamp = new Int32Array(ns).fill(-1);
    let tick = 0;
    function nearest(px, py, maxD) {          // -> distance (capped at maxD)
      tick++;
      const bi = Math.floor((px - x0) / B), bj = Math.floor((py - y0) / B);
      let best2 = maxD * maxD;
      const kmax = Math.ceil(maxD / B) + 1;
      for (let k = 0; k <= kmax; k++) {
        if (k >= 2 && (k - 1) * B * (k - 1) * B >= best2) break;
        for (let j = bj - k; j <= bj + k; j++) {
          if (j < 0 || j >= bh) continue;
          const edge = j === bj - k || j === bj + k;
          for (let i = bi - k; i <= bi + k; i += (edge ? 1 : 2 * k || 1)) {
            if (i < 0 || i >= bw) continue;
            const list = buckets[j * bw + i];
            for (let q = 0; q < list.length; q++) {
              const s = list[q];
              if (stamp[s] === tick) continue;
              stamp[s] = tick;
              const o = s * 4;
              const d2 = segDist2(px, py, segs[o], segs[o + 1], segs[o + 2], segs[o + 3]);
              if (d2 < best2) best2 = d2;
            }
          }
        }
      }
      return Math.sqrt(best2);
    }
    return { nearest };
  }
  function segsFromRings(rings) {
    let n = 0;
    for (const r of rings) n += Math.max(0, r.length - 1);
    const segs = new Float64Array(n * 4);
    let o = 0;
    for (const r of rings) for (let i = 0; i + 1 < r.length; i++) {
      segs[o++] = r[i][0]; segs[o++] = r[i][1]; segs[o++] = r[i + 1][0]; segs[o++] = r[i + 1][1];
    }
    return segs;
  }

  // ---- straight lanes: exact scanlines across a traced region ------------------
  // polys: grid-space polygons (x = col, y = row; [outer, hole..]) of the water a lane's
  // centre line may use. For every heading (stepDeg) the parallel lines `spacing` cells
  // apart are cut exactly by the region's edges (even-odd); each inside interval at
  // least needC cells long is a centre line, handed to onLine(deg, v, ua, ub, ax, ay, nx, ny).
  function scanLanes(polys, needC, stepDeg, spacing, onLine) {
    const rings = [];
    for (const p of polys) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of p[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (Math.hypot(x1 - x0, y1 - y0) >= needC) rings.push(...p);   // too small to hold a lane
    }
    let cap = 0;
    for (const r of rings) for (let k = 0; k + 1 < r.length; k++) cap += Math.ceil(Math.hypot(r[k + 1][0] - r[k][0], r[k + 1][1] - r[k][1]) / spacing) + 1;
    const KS = new Int32Array(cap), US = new Float64Array(cap), ORD = new Float64Array(cap);
    let best = { m: 0, deg: 0, a: null, b: null };
    if (!cap) return best;
    for (let deg = 0; deg < 180 - 1e-9; deg += stepDeg) {
      const th = deg * Math.PI / 180, ax = Math.cos(th), ay = -Math.sin(th);   // along the line (grid y points down)
      const nx = -ay, ny = ax;                                                  // across
      let nc = 0, kmin = Infinity, kmax = -Infinity;
      for (const r of rings) for (let k = 0; k + 1 < r.length; k++) {
        const px = r[k][0], py = r[k][1], qx = r[k + 1][0], qy = r[k + 1][1];
        const vp = px * nx + py * ny, vq = qx * nx + qy * ny;
        if (vp === vq) continue;
        // lines sit at v = (j + 0.5) * spacing; half-open [lo, hi) counts shared vertices once
        const j0 = Math.ceil(Math.min(vp, vq) / spacing - 0.5), j1 = Math.ceil(Math.max(vp, vq) / spacing - 0.5) - 1;
        if (j1 < j0) continue;
        const up = px * ax + py * ay, uq = qx * ax + qy * ay;
        for (let j = j0; j <= j1; j++) {
          const t = ((j + 0.5) * spacing - vp) / (vq - vp);
          KS[nc] = j; US[nc] = up + t * (uq - up); nc++;
        }
        if (j0 < kmin) kmin = j0; if (j1 > kmax) kmax = j1;
      }
      if (!nc) continue;
      // bucket the crossings by line (counting sort), then sort each line's few crossings by u
      const nb = kmax - kmin + 1, start = new Int32Array(nb + 1);
      for (let q = 0; q < nc; q++) start[KS[q] - kmin + 1]++;
      for (let b = 0; b < nb; b++) start[b + 1] += start[b];
      const fill = start.slice(0, nb);
      for (let q = 0; q < nc; q++) ORD[fill[KS[q] - kmin]++] = US[q];
      for (let b = 0; b < nb; b++) {
        const lo = start[b], hi = start[b + 1];
        for (let q = lo + 1; q < hi; q++) { const u = ORD[q]; let z = q - 1; while (z >= lo && ORD[z] > u) { ORD[z + 1] = ORD[z]; z--; } ORD[z + 1] = u; }
        const v = (b + kmin + 0.5) * spacing;
        for (let q = lo; q + 1 < hi; q += 2) {
          const ua = ORD[q], ub = ORD[q + 1];
          if (ub - ua < needC) continue;
          onLine(deg, v, ua, ub, ax, ay, nx, ny);
          if (ub - ua > best.m) best = { m: ub - ua, deg, a: [ua * ax + v * nx, ua * ay + v * ny], b: [ub * ax + v * nx, ub * ay + v * ny] };
        }
      }
    }
    return best;
  }

  // exact Euclidean distance transform (Felzenszwalb & Huttenlocher), in cells,
  // to the nearest truthy seed — the same routine the main explorer's dock editor uses
  function edtSq1d(f, n, d, v, z) {
    let k = 0; v[0] = 0; z[0] = -1e20; z[1] = 1e20;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = 1e20;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  }
  function edt(seed, w, h) {
    const INF = 1e12, m = Math.max(w, h);
    const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
    const g = new Float64Array(w * h), out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = seed[y * w + x] ? 0 : INF;
      edtSq1d(f, h, d, v, z);
      for (let y = 0; y < h; y++) g[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) f[x] = g[y * w + x];
      edtSq1d(f, w, d, v, z);
      for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
    }
    return out;
  }

  function b64ToBytes(b64) {
    if (typeof atob === 'function') {
      const bin = atob(b64), out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  // =====================================================================
  function create(reach, opts) {
    opts = opts || {};
    const proj = makeUTM(reach.crs.zone, reach.crs.south);
    const G = reach.grid, cell = G.cell;
    const waterPolys = reach.water.polygons;
    const waterRings = ringsOf(waterPolys);

    // work window: the analysed water + a land margin (the shipped grid also
    // covers the display-only lake approach, which is never analysed)
    const margin = (opts.marginM || 60);
    const bb = bboxOf(waterRings);
    const wc0 = Math.max(0, Math.floor((bb[0] - margin - G.x0) / cell));
    const wc1 = Math.min(G.cols - 1, Math.ceil((bb[2] + margin - G.x0) / cell));
    const wr0 = Math.max(0, Math.floor((G.y0 - (bb[3] + margin)) / cell));
    const wr1 = Math.min(G.rows - 1, Math.ceil((G.y0 - (bb[1] - margin)) / cell));
    const w = wc1 - wc0 + 1, h = wr1 - wr0 + 1, N = w * h;
    const ox = G.x0 + wc0 * cell, oy = G.y0 - wr0 * cell;        // window NW corner
    const g = {
      w, h, cell,
      X: c => ox + (c + 0.5) * cell, Y: r => oy - (r + 0.5) * cell,
      colF: x => (x - ox) / cell - 0.5, rowF: y => (oy - y) / cell - 0.5,
    };

    // depth (ft below full pool) sampled into the window
    const depthAll = reach.depth ? b64ToBytes(reach.depth.data) : null;
    const DEPTH = new Float32Array(N).fill(NaN);
    if (depthAll) {
      const s = reach.depth.scale_ft, nd = reach.depth.nodata;
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        const v = depthAll[(r + wr0) * G.cols + (c + wc0)];
        if (v !== nd) DEPTH[r * w + c] = v * s;
      }
    }

    // water mask + exact signed distance to the shoreline (m): + in water,
    // - on the land rim (only the rim matters for tracing the shore itself)
    const WATER = new Uint8Array(N);
    fillPolys(waterPolys, g, WATER, 1);
    const shoreIdx = makeSegIndex(segsFromRings(waterRings), 40);
    const W = new Float32Array(N).fill(-2 * cell);
    let maxShore = 0;
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const i = r * w + c;
      let rim = WATER[i];
      if (!rim) {
        for (let dr = -1; dr <= 1 && !rim; dr++) for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < h && cc >= 0 && cc < w && WATER[rr * w + cc]) { rim = 1; break; }
        }
      }
      if (!rim) continue;
      const d = shoreIdx.nearest(g.X(c), g.Y(r), 2000);
      W[i] = WATER[i] ? d : -d;
      if (WATER[i] && d > maxShore) maxShore = d;
    }
    const waterArea = (function () { let s = 0; for (const p of waterPolys) for (const rg of p) s += ringArea(rg); return s; })();

    let STRUCT = new Float32Array(N).fill(BIG);   // distance to nearest structure
    let structures = [];
    let NWZ = new Float32Array(N).fill(BIG);      // signed distance to no-wake zones (- inside)
    let zones = [], zoneIdx = null;
    const contour = makeContourer(w, h);
    const F1 = new Float32Array(N), F2 = new Float32Array(N), F3 = new Float32Array(N), TMP = new Float32Array(N);
    let WIDTH = null, widthKey = '';

    function toLonLat(x, y) { return proj.inverse(x, y); }
    function fromLonLat(lon, lat) { return proj.forward(lon, lat); }
    function gridRingToUTM(r) { return r.map(p => [ox + (p[0] + 0.5) * cell, oy - (p[1] + 0.5) * cell]); }

    // ---- structures: [{kind:'point', x, y, r} | {kind:'line', pts:[[x,y]..], hw} | {kind:'area', polys}]
    // distances are painted out to capM (default 520 m): rules go to 1,000 ft and a field
    // must stay a true distance a further ~200 m (the widest water) for lanes and U-turns
    function setStructures(list, capM) {
      structures = list || [];
      const cap = capM || 520;
      STRUCT = new Float32Array(N).fill(BIG);
      const capC = Math.ceil(cap / cell) + 1;
      const XS = new Float64Array(w), YS = new Float64Array(h);
      for (let c = 0; c < w; c++) XS[c] = g.X(c);
      for (let r = 0; r < h; r++) YS[r] = g.Y(r);
      const paintPoint = (x, y, rad) => {
        const cc = Math.round(g.colF(x)), rr = Math.round(g.rowF(y));
        const ca = Math.max(0, cc - capC), cb = Math.min(w - 1, cc + capC);
        for (let r = Math.max(0, rr - capC); r <= Math.min(h - 1, rr + capC); r++) {
          const dy = YS[r] - y, dy2 = dy * dy, o = r * w;
          for (let c = ca; c <= cb; c++) {
            const dx = XS[c] - x, d = Math.sqrt(dx * dx + dy2) - rad;
            if (d < STRUCT[o + c]) STRUCT[o + c] = d;
          }
        }
      };
      const paintSeg = (ax, ay, bx, by, hw) => {
        const c0 = Math.max(0, Math.floor(g.colF(Math.min(ax, bx) - cap))), c1 = Math.min(w - 1, Math.ceil(g.colF(Math.max(ax, bx) + cap)));
        const r0 = Math.max(0, Math.floor(g.rowF(Math.max(ay, by) + cap))), r1 = Math.min(h - 1, Math.ceil(g.rowF(Math.min(ay, by) - cap)));
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          const d = Math.sqrt(segDist2(XS[c], YS[r], ax, ay, bx, by)) - hw, i = r * w + c;
          if (d < STRUCT[i]) STRUCT[i] = d;
        }
      };
      for (const s of structures) {
        if (s.kind === 'point') paintPoint(s.x, s.y, s.r || 0);
        else if (s.kind === 'line') {
          for (let k = 0; k + 1 < s.pts.length; k++) paintSeg(s.pts[k][0], s.pts[k][1], s.pts[k + 1][0], s.pts[k + 1][1], s.hw || 0);
          if (s.pts.length === 1) paintPoint(s.pts[0][0], s.pts[0][1], s.hw || 0);
        } else if (s.kind === 'area') {
          for (const rg of ringsOf(s.polys)) for (let k = 0; k + 1 < rg.length; k++) paintSeg(rg[k][0], rg[k][1], rg[k + 1][0], rg[k + 1][1], 0);
          const inside = new Uint8Array(N);
          fillPolys(s.polys, g, inside, 1);
          for (let i = 0; i < N; i++) if (inside[i]) STRUCT[i] = -Math.abs(STRUCT[i]);
        }
      }
      widthKey = '';
    }

    // ---- designated no-wake zones: polys in UTM ([[outer, hole..], ..] each)
    function setZones(list) {
      zones = (list || []).filter(z => z.polys && z.polys.some(pp => pp.length && pp[0].length > 3));   // rings only
      NWZ = new Float32Array(N).fill(BIG);
      zoneIdx = null;
      if (!zones.length) return;
      const all = [];
      for (const z of zones) for (const p of z.polys) all.push(p);
      const inside = new Uint8Array(N);
      for (const z of zones) {
        const m = new Uint8Array(N);
        fillPolys(z.polys, g, m, 1);
        for (let i = 0; i < N; i++) if (m[i]) inside[i] = 1;   // union across zones
      }
      const idx = zoneIdx = makeSegIndex(segsFromRings(ringsOf(all)), 40);
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        const i = r * w + c;
        if (W[i] <= -2 * cell + 1e-6 && !WATER[i]) continue;   // far land: irrelevant
        const d = idx.nearest(g.X(c), g.Y(r), 320);   // only matters where it beats the shore distance
        NWZ[i] = inside[i] ? -d : d;
      }
    }

    // a depth minimum as a hard mask with a true clearance (m): + where today's depth is at
    // least md, - elsewhere, with the edge midway between grid nodes. Lanes, U-turn spots and
    // "widest" read the fields as metres of room, so depth must be a distance too.
    let DEPC = null, depcKey = '';
    function depthClear(md, lvl) {
      const key = md + '|' + lvl;
      if (DEPC && depcKey === key) return DEPC;
      const ok = new Uint8Array(N), bad = new Uint8Array(N);
      for (let i = 0; i < N; i++) { const dp = DEPTH[i] - lvl; if (dp >= md - DEPTH_EPS) ok[i] = 1; else bad[i] = 1; }   // NaN -> bad
      const dIn = edt(bad, w, h), dOut = edt(ok, w, h);
      DEPC = new Float32Array(N);
      for (let i = 0; i < N; i++) DEPC[i] = ok[i] ? (dIn[i] - 0.5) * cell : -(dOut[i] - 0.5) * cell;
      depcKey = key;
      return DEPC;
    }

    // per-rule field: region where the rule allows the activity
    function ruleField(rule, zonesOn, levelOffFt, out) {
      const t = rule.ft * FT, md = rule.minDepthFt || 0;
      const dc = md > 0 ? depthClear(md, levelOffFt || 0) : null;
      for (let i = 0; i < N; i++) {
        let v = W[i];
        if (v > -BIG) {
          let d = BIG;
          if (rule.shore) d = W[i];
          if (rule.structures && STRUCT[i] < d) d = STRUCT[i];
          if (d - t < v) v = d - t;
          if (zonesOn && NWZ[i] < v) v = NWZ[i];
          if (dc && dc[i] < v) v = dc[i];
        }
        out[i] = v;
      }
      return out;
    }

    function areaOf(rings) { let s = 0; for (const r of rings) s += ringArea(r); return s; }

    function traceUTM(field) {
      const rings = contour(field).map(gridRingToUTM);
      return { rings, area: areaOf(rings) };
    }

    // local channel width (diameter of the largest inscribed circle covering
    // each node), from the shore+structure distance — the "room to pass" metric
    function widthField() {
      const key = structures.length + ':' + (STRUCT[0] || 0);
      if (WIDTH && widthKey === key) return WIDTH;
      const D = new Float32Array(N);
      for (let i = 0; i < N; i++) D[i] = WATER[i] ? Math.max(0, Math.min(W[i], STRUCT[i])) : 0;
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) out[i] = WATER[i] ? 2 * D[i] : 0;
      const eps = 0.12 * cell, diag = Math.SQRT2 * cell;
      for (let r = 1; r < h - 1; r++) for (let c = 1; c < w - 1; c++) {
        const i = r * w + c, dc = D[i];
        if (!WATER[i] || dc < cell) continue;
        let ridge = true;
        for (let dr = -1; dr <= 1 && ridge; dr++) for (let dd = -1; dd <= 1; dd++) {
          if (!dr && !dd) continue;
          const step = dr && dd ? diag : cell;
          if (D[i + dr * w + dd] >= dc + step - eps) { ridge = false; break; }
        }
        if (!ridge) continue;
        const R = dc / cell, Ri = Math.ceil(R), R2 = R * R, val = 2 * dc;
        for (let y = -Ri; y <= Ri; y++) {
          const rr = r + y; if (rr < 0 || rr >= h) continue;
          const span = Math.floor(Math.sqrt(Math.max(0, R2 - y * y)));
          for (let x = -span; x <= span; x++) {
            const cc = c + x; if (cc < 0 || cc >= w) continue;
            const j = rr * w + cc;
            if (WATER[j] && out[j] < val) out[j] = val;
          }
        }
      }
      WIDTH = out; widthKey = key;
      return out;
    }

    // F1 = wake allowed, F2 = tow allowed, F3 = surf (guideline) allowed, for params p.
    // Everything that reads these fields refills them from its own params first, so
    // no query depends on which compute happened to run last.
    function fillFields(p) {
      const zonesOn = p.zonesOn !== false && zones.length > 0;
      const lvl = p.levelOffsetFt || 0;
      const R = p.rules;
      ruleField(R.nowake, zonesOn, lvl, F1);
      ruleField(R.tow, zonesOn, lvl, F2);
      for (let i = 0; i < N; i++) if (F1[i] < F2[i]) F2[i] = F1[i];
      ruleField(R.surf, zonesOn, lvl, F3);
      for (let i = 0; i < N; i++) if (F2[i] < F3[i]) F3[i] = F2[i];
      if (p.allNoWake) for (let i = 0; i < N; i++) { const v = Math.min(W[i], -cell); F1[i] = v; F2[i] = v; F3[i] = v; }   // river-wide no-wake (high water)
      return zonesOn;
    }

    // ---- main entry --------------------------------------------------------
    function compute(p) {
      const t0 = Date.now();
      const lvl = p.levelOffsetFt || 0;
      const R = p.rules;
      const zonesOn = fillFields(p);

      const res = { bands: {}, stats: {}, timings: {} };
      const band = (fill) => { fill(TMP); return traceUTM(TMP); };
      res.bands.idle = band(o => { for (let i = 0; i < N; i++) o[i] = Math.min(W[i], -F1[i]); });
      res.bands.cruise = band(o => { for (let i = 0; i < N; i++) o[i] = Math.min(F1[i], -F2[i]); });
      res.bands.tow = band(o => { for (let i = 0; i < N; i++) o[i] = Math.min(F2[i], -F3[i]); });
      res.bands.surf = band(o => { o.set(F3); });
      res.timings.bands = Date.now() - t0;

      // designated-zone footprint inside the water (for stats / the waterfall)
      let zoneArea = 0;
      if (zones.length) {
        for (let i = 0; i < N; i++) TMP[i] = Math.min(W[i], -NWZ[i]);
        zoneArea = areaOf(contour(TMP).map(gridRingToUTM));
      }

      // straight runs inside the chosen activity's water, as LANES: a centre line of at
      // least `ft` with `laneFt`/2 of clearance on both sides (a boat plus its skier's or
      // surfer's swath), grown back to the lane width. The fields are distances, so the
      // centre lines live in {field > laneFt/2}; that region is traced and cut exactly by
      // parallel lines at every heading — no grid stair-steps, exact lengths.
      const t1 = Date.now();
      const act = p.run && p.run.activity === 'surf' ? F3 : p.run && p.run.activity === 'cruise' ? F1 : F2;
      const runM = (p.run ? p.run.ft : 0) * FT;
      const laneH = Math.max(5, ((p.run && p.run.laneFt != null ? p.run.laneFt : 50) * FT) / 2);
      const stepDeg = p.run && p.run.stepDeg > 0 ? p.run.stepDeg : 1;
      for (let i = 0; i < N; i++) TMP[i] = act[i] - laneH;
      const CLM = new Uint8Array(N);
      let mc0 = w, mc1 = -1, mr0 = h, mr1 = -1;
      // contour rings are oriented y-up; nest them as such (flip rows), then flip back
      const flipY = r => r.map(q => [q[0], -q[1]]);
      const lanePolys = nestRings(contour(TMP).map(flipY)).map(pp => pp.map(flipY));
      const best = scanLanes(lanePolys, Math.max(runM, cell) / cell, stepDeg, 0.4, (deg, v, ua, ub, ax, ay, nx, ny) => {
        for (let u = ua; u <= ub; u += 0.5) {
          const c = Math.round(u * ax + v * nx), r = Math.round(u * ay + v * ny);
          if (c < 0 || r < 0 || c >= w || r >= h) continue;
          CLM[r * w + c] = 1;
          if (c < mc0) mc0 = c; if (c > mc1) mc1 = c; if (r < mr0) mr0 = r; if (r > mr1) mr1 = r;
        }
      });
      // grow the centre lines back to the lane width (exact distance transform, cropped)
      TMP.fill(-cell);
      if (mc1 >= 0) {
        const pad = Math.ceil(laneH / cell) + 2;
        const c0 = Math.max(0, mc0 - pad), c1 = Math.min(w - 1, mc1 + pad), r0 = Math.max(0, mr0 - pad), r1 = Math.min(h - 1, mr1 + pad);
        const cw = c1 - c0 + 1, chh = r1 - r0 + 1, seed = new Uint8Array(cw * chh);
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) seed[(r - r0) * cw + (c - c0)] = CLM[r * w + c];
        const E = edt(seed, cw, chh);
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          const i = r * w + c;
          TMP[i] = Math.min(act[i], laneH - E[(r - r0) * cw + (c - c0)] * cell);
        }
      }
      res.runs = traceUTM(TMP);
      // a real lane covers at least ~length x width; anything far smaller is a sliver of the
      // grow-back. Holes are dropped: a strip of clearance around a centre line can't hold land.
      const minLane = 0.5 * runM * (2 * laneH);
      const lanes = nestRings(res.runs.rings).filter(pp => pp.reduce((a, rg) => a + ringArea(rg), 0) >= minLane).map(pp => [pp[0]]);
      res.runs.rings = lanes.flat();
      res.runs.area = areaOf(res.runs.rings);
      res.runs.zones = lanes.length;
      res.runs.laneFt = 2 * laneH / FT;
      const toU = q => [ox + (q[0] + 0.5) * cell, oy - (q[1] + 0.5) * cell];
      res.runs.longest = best.a ? { m: best.m * cell, deg: best.deg, a: toU(best.a), b: toU(best.b) } : null;
      res.timings.runs = Date.now() - t1;

      // room to pass: lane capacity from the local channel width
      if (p.width) {
        const t2 = Date.now();
        const WD = widthField();
        const n = R.nowake.ft * FT, s = R.surf.ft * FT, pass = (p.passFt || 100) * FT;
        const T1 = 2 * n + pass, T2 = Math.max(2 * s, 2 * n + 2 * pass);
        const zf = i => (zonesOn ? NWZ[i] : BIG);
        res.width = { T1ft: T1 / FT, T2ft: T2 / FT, classes: {} };
        res.width.classes.narrow = band(o => { for (let i = 0; i < N; i++) o[i] = Math.min(W[i], zf(i), WATER[i] ? T1 - WD[i] : -cell); });
        res.width.classes.twoway = band(o => { for (let i = 0; i < N; i++) o[i] = Math.min(W[i], zf(i), WATER[i] ? Math.min(WD[i] - T1, T2 - WD[i]) : -cell); });
        res.width.classes.surfpass = band(o => { for (let i = 0; i < N; i++) o[i] = Math.min(W[i], zf(i), WATER[i] ? WD[i] - T2 : -cell); });
        res.timings.width = Date.now() - t2;
      }

      // the rule lines themselves (cumulative: wake / tow / surf allowed) for exports
      if (p.lines) {
        fillFields(p);
        res.lines = { wake: contour(F1).map(gridRingToUTM), tow: contour(F2).map(gridRingToUTM), surf: contour(F3).map(gridRingToUTM) };
      }

      // single-rule view ("where you could boat following only this rule")
      if (p.single && R[p.single]) {
        ruleField(Object.assign({}, R[p.single]), false, lvl, TMP);
        res.single = Object.assign({ rule: p.single }, traceUTM(TMP));
      }

      const ac = m2 => m2 / M2_PER_ACRE;
      const A = { idle: res.bands.idle.area, cruise: res.bands.cruise.area, tow: res.bands.tow.area, surf: res.bands.surf.area };
      res.stats = {
        water_ac: ac(waterArea),
        zone_ac: ac(zoneArea),
        idle_ac: ac(A.idle), cruise_ac: ac(A.cruise), tow_ac: ac(A.tow), surf_ac: ac(A.surf),
        wake_ok_ac: ac(A.cruise + A.tow + A.surf),
        tow_ok_ac: ac(A.tow + A.surf),
        surf_ok_ac: ac(A.surf),
        runs_ac: ac(res.runs.area), run_zones: res.runs.zones,
        longest_run_ft: res.runs.longest ? res.runs.longest.m / FT : 0,
      };
      res.timings.total = Date.now() - t0;
      return res;
    }

    // the most restrictive designated zone at a point — zones overlap (the Templin's
    // no-wake zone covers the dam's No Entry water), so file order must not decide
    const ZONE_RANK = { no_entry: 4, no_motor: 2, no_wake: 1 };
    function zoneAt(x, y) {
      let best = null, rank = 0;
      for (const z of zones) {
        if (!pointInPolys(x, y, z.polys)) continue;
        const r = (ZONE_RANK[z.type] || 1) - (z.type === 'no_entry' && z.when === 'posted' ? 1 : 0);
        if (r > rank) { rank = r; best = z; }
      }
      return best ? { ref: best.ref, name: best.name, type: best.type || 'no_wake', when: best.when || 'always' } : null;
    }

    // ---- point readout (bilinear on the fields, exact for zones) ------------
    function bil(arr, fc, fr) {
      const c0 = Math.max(0, Math.min(w - 2, Math.floor(fc))), r0 = Math.max(0, Math.min(h - 2, Math.floor(fr)));
      const fx = Math.max(0, Math.min(1, fc - c0)), fy = Math.max(0, Math.min(1, fr - r0)), i = r0 * w + c0;
      const v = [arr[i], arr[i + 1], arr[i + w], arr[i + w + 1]];
      if (v.some(q => !Number.isFinite(q))) {         // depth near the edge: nearest valid
        const ok = v.filter(Number.isFinite);
        return ok.length ? ok.reduce((s, q) => s + q, 0) / ok.length : NaN;
      }
      return (v[0] * (1 - fx) + v[1] * fx) * (1 - fy) + (v[2] * (1 - fx) + v[3] * fx) * fy;
    }
    function sample(x, y, p) {
      const fc = g.colF(x), fr = g.rowF(y);
      const inGrid = fc >= 0 && fr >= 0 && fc <= w - 1 && fr <= h - 1;
      const inWater = pointInPolys(x, y, waterPolys);
      const out = { x, y, inGrid, inWater };
      if (!inGrid || !inWater) return out;
      out.shore_m = shoreIdx.nearest(x, y, 3000);
      let sd = Infinity, which = null;
      for (const s of structures) {
        let d;
        if (s.kind === 'point') d = Math.hypot(x - s.x, y - s.y) - (s.r || 0);
        else if (s.kind === 'line') {
          d = s.pts.length === 1 ? Math.hypot(x - s.pts[0][0], y - s.pts[0][1]) - (s.hw || 0) : Infinity;
          for (let k = 0; k + 1 < s.pts.length; k++) d = Math.min(d, Math.sqrt(segDist2(x, y, s.pts[k][0], s.pts[k][1], s.pts[k + 1][0], s.pts[k + 1][1])) - (s.hw || 0));
        }
        else { d = pointInPolys(x, y, s.polys) ? 0 : Infinity; for (const rg of ringsOf(s.polys)) for (let k = 0; k + 1 < rg.length; k++) d = Math.min(d, Math.sqrt(segDist2(x, y, rg[k][0], rg[k][1], rg[k + 1][0], rg[k + 1][1]))); }
        if (d < sd) { sd = d; which = s; }
      }
      out.struct_m = Number.isFinite(sd) ? Math.max(0, sd) : null;
      out.struct = which ? (which.ref || null) : null;
      const zh = zoneAt(x, y);
      out.zone_edge_m = zoneIdx ? zoneIdx.nearest(x, y, 1000) : null;
      out.zone = zh ? zh.ref || zh.name || 'zone' : null;
      out.zoneType = zh ? zh.type : null;
      out.zoneWhen = zh ? zh.when : null;
      const dp = bil(DEPTH, fc, fr);
      out.depth_ft = Number.isFinite(dp) ? Math.max(0, dp - ((p && p.levelOffsetFt) || 0)) : null;
      out.depth_full_pool_ft = Number.isFinite(dp) ? dp : null;
      if (WIDTH) out.width_m = WIDTH[Math.round(fr) * w + Math.round(fc)] || null;
      return out;
    }

    // ---- river miles along the centreline (RM 0 = Post Falls Dam) ----------------
    const CL = reach.centerline ? reach.centerline.coords : null;
    const CUM = [];
    if (CL) { let c = 0; CUM.push(0); for (let i = 1; i < CL.length; i++) { c += Math.hypot(CL[i][0] - CL[i - 1][0], CL[i][1] - CL[i - 1][1]); CUM.push(c); } }
    const MI = 1609.344;
    function riverMile(x, y) {
      if (!CL) return null;
      let best = Infinity, at = 0;
      for (let i = 0; i + 1 < CL.length; i++) {
        const ax = CL[i][0], ay = CL[i][1], dx = CL[i + 1][0] - ax, dy = CL[i + 1][1] - ay, L2 = dx * dx + dy * dy;
        let t = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + t * dx - x, qy = ay + t * dy - y, d = qx * qx + qy * qy;
        if (d < best) { best = d; at = CUM[i] + t * Math.sqrt(L2); }
      }
      return at / MI;
    }
    function pointAtMile(rm) {
      if (!CL) return null;
      const m = rm * MI;
      for (let i = 0; i + 1 < CL.length; i++) if (CUM[i + 1] >= m) {
        const t = (m - CUM[i]) / ((CUM[i + 1] - CUM[i]) || 1);
        return { x: CL[i][0] + t * (CL[i + 1][0] - CL[i][0]), y: CL[i][1] + t * (CL[i + 1][1] - CL[i][1]),
                 deg: Math.atan2(CL[i + 1][1] - CL[i][1], CL[i + 1][0] - CL[i][0]) * 180 / Math.PI };
      }
      return null;
    }
    function ticks(stepMi) {
      const out = [];
      if (!CL) return out;
      const total = CUM[CUM.length - 1] / MI;
      for (let k = 0; k * stepMi <= total + 1e-9; k++) { const p = pointAtMile(k * stepMi); if (p) out.push(Object.assign({ rm: Math.round(k * stepMi * 100) / 100 }, p)); }
      return out;
    }

    // ---- corridors: connected stretches of an activity's legal water ----------------
    // A stretch is a piece of water where a boat and its rider (opts.minWidthFt wide) can
    // travel without leaving the legal water: 8-connected pieces of {field > minWidth/2},
    // grown back to the full legal water around them (a 5-m pinch doesn't join two
    // stretches). For each: river-mile extent, area, widest legal width, depth range
    // (today), and turnaround spots (room for a U-turn of turnM radius).
    function corridors(field, opts) {
      opts = opts || {};
      const turnM = (opts.turnFt || 100) * FT, minAc = opts.minAc != null ? opts.minAc : 1.5, lvl = opts.levelOffsetFt || 0;
      const hw = Math.max(0, (opts.minWidthFt || 0) * FT / 2);
      const lab = new Int32Array(N), stack = [], out = [];
      let n = 0;
      for (let i0 = 0; i0 < N; i0++) {             // label the cores
        if (field[i0] <= hw || lab[i0]) continue;
        n++; stack.push(i0); lab[i0] = n;
        while (stack.length) {
          const j = stack.pop(), x = j % w, y = (j / w) | 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const k = yy * w + xx;
            if (field[k] > hw && !lab[k]) { lab[k] = n; stack.push(k); }
          }
        }
      }
      if (hw > 0) {                                  // grow each core back over the legal water within hw
        let front = [];
        for (let i = 0; i < N; i++) if (lab[i]) front.push(i);
        for (let step = 0; step * cell < hw + cell && front.length; step++) {
          const next = [];
          for (const j of front) {
            const x = j % w, y = (j / w) | 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx, yy = y + dy;
              if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
              const k = yy * w + xx;
              if (field[k] > 0 && !lab[k]) { lab[k] = lab[j]; next.push(k); }
            }
          }
          front = next;
        }
      }
      const members = Array.from({ length: n + 1 }, () => []);
      for (let i = 0; i < N; i++) if (lab[i]) members[lab[i]].push(i);
      for (let id = 1; id <= n; id++) {
        const cells = members[id];
        let cnt = 0, bestV = -Infinity, best = cells[0], rmMin = Infinity, rmMax = -Infinity;
        const hist = new Uint32Array(141);
        for (const j of cells) {
          const x = j % w, y = (j / w) | 0;
          cnt++;
          if (field[j] > bestV) { bestV = field[j]; best = j; }
          const d = DEPTH[j] - lvl;
          if (Number.isFinite(d)) hist[Math.max(0, Math.min(140, Math.round(d * 2)))]++;
          if ((cnt & 7) === 1 && CL) { const rm = riverMile(g.X(x), g.Y(y)); if (rm < rmMin) rmMin = rm; if (rm > rmMax) rmMax = rm; }
        }
        const ac = cnt * cell * cell / M2_PER_ACRE;
        if (ac < minAc) continue;
        let tot = 0; for (const c of hist) tot += c;
        const q = f => { let a = 0; for (let k = 0; k <= 140; k++) { a += hist[k]; if (a >= f * tot) return k / 2; } return 70; };
        // turnaround spots: sub-pieces of {field >= turnM}, each marked at its deepest-inside point
        const turns = [], tl = new Map();
        for (const j of cells) {
          if (field[j] < turnM || tl.has(j) || lab[j] !== id) continue;
          let bj = j, bv = field[j];
          const st = [j]; tl.set(j, 1);
          while (st.length) {
            const k = st.pop(), x = k % w, y = (k / w) | 0;
            if (field[k] > bv) { bv = field[k]; bj = k; }
            for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const xx = x + ddx, yy = y + ddy, kk = yy * w + xx;
              if (xx < 0 || yy < 0 || xx >= w || yy >= h || tl.has(kk) || field[kk] < turnM || lab[kk] !== id) continue;
              tl.set(kk, 1); st.push(kk);
            }
          }
          const tx = g.X(bj % w), ty = g.Y((bj / w) | 0);
          const dd = DEPTH[bj] - lvl;
          turns.push({ x: tx, y: ty, rm: riverMile(tx, ty), clearFt: bv / FT, depthFt: Number.isFinite(dd) ? dd : null });
        }
        // one spot per basin: keep the roomiest, drop others within a turn's width of it
        turns.sort((a, b) => b.clearFt - a.clearFt);
        const keep = [], sep = 2 * turnM + 30;
        for (const t of turns) if (keep.every(k => Math.hypot(k.x - t.x, k.y - t.y) > sep)) keep.push(t);
        turns.length = 0; turns.push(...keep);
        turns.sort((a, b) => (a.rm || 0) - (b.rm || 0));
        const bx = g.X(best % w), by = g.Y((best / w) | 0);
        out.push({ area_ac: ac, rm0: rmMin, rm1: rmMax, lengthFt: Number.isFinite(rmMin) ? (rmMax - rmMin) * 5280 : null,
          widestFt: 2 * bestV / FT, center: [bx, by], depth: tot ? { min: q(0.02), p50: q(0.5), max: q(0.98) } : null, turns });
      }
      out.sort((a, b) => (b.lengthFt || 0) - (a.lengthFt || 0));
      out.forEach((c, k) => { c.label = String.fromCharCode(65 + (k % 26)); });
      return out;
    }

    return {
      version: 1, cell, w, h, N, waterArea, maxShore,
      riverMile, pointAtMile, ticks, centerlineLengthMi: CL ? CUM[CUM.length - 1] / MI : null, zoneAt,
      corridors(kind, params, opts) { fillFields(params); return corridors(kind === 'surf' ? F3 : kind === 'cruise' ? F1 : F2, opts); },
      toLonLat, fromLonLat, setStructures, setZones, compute, sample,
      widthField, simplifyRing, nestRings, ringArea, pointInPolys,
      waterPolys, approachPolys: reach.approach ? reach.approach.polygons : [],
      depthAt(x, y) { const v = bil(DEPTH, g.colF(x), g.rowF(y)); return Number.isFinite(v) ? v : null; },
      // depth bands (static): [[lo, hi], ...] in ft below full pool, adjusted by the level offset
      depthBands(edges, levelOffFt) {
        const out = [];
        for (let k = 0; k < edges.length; k++) {
          const lo = edges[k], hi = k + 1 < edges.length ? edges[k + 1] : Infinity;
          for (let i = 0; i < N; i++) {
            const d = DEPTH[i] - (levelOffFt || 0);
            if (!WATER[i] || !Number.isFinite(d)) { TMP[i] = Math.min(W[i], -0.5); continue; }
            TMP[i] = Math.min(W[i], (d - lo + DEPTH_EPS) * FT * 3, (hi - d - DEPTH_EPS) * FT * 3);
          }
          out.push(Object.assign({ lo, hi }, traceUTM(TMP)));
        }
        return out;
      },
      // contour where today's depth crosses `ft` (rings bound the deeper side), inside the water
      depthLine(ft, levelOffFt) {
        for (let i = 0; i < N; i++) {
          const d = DEPTH[i] - (levelOffFt || 0);
          TMP[i] = WATER[i] && Number.isFinite(d) ? Math.min(W[i] + cell, (d - ft + DEPTH_EPS) * FT * 3) : -cell;
        }
        return traceUTM(TMP).rings;
      },
      // water where a wake is allowed (under params) but today's depth is under `ft`
      shallowInUse(ft, params) {
        fillFields(params);
        const levelOffFt = params.levelOffsetFt || 0;
        for (let i = 0; i < N; i++) {
          const d = DEPTH[i] - (levelOffFt || 0);
          TMP[i] = Number.isFinite(d) ? Math.min(F1[i], (ft - d - DEPTH_EPS) * FT * 3) : -cell;
        }
        return traceUTM(TMP);
      },
      grid: { ox, oy, w, h, cell },
    };
  }

  return { create, makeUTM, simplify, simplifyRing, nestRings, ringArea, pointInPolys, FT, M2_PER_ACRE };
});
