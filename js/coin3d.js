/* Crypto.M — everything 3D (three.js r128, global THREE from cdnjs).
 *
 *  Coin3D.podium(el, onPick)  top-3 early movers floating over lit pedestals
 *  Coin3D.single(el)          one draggable coin for the detail panel
 *  Coin3D.thumb(base)         Promise<dataURL> — a 3D coin rendered once, used as the list thumbnail
 *  Coin3D.icon(kind)          Promise<dataURL> — 3D-rendered UI icons (radar, markets, wallet, trophy, mark)
 *
 * Coin faces use the coin's real logo. Logo sources, first that loads wins:
 *   window.COIN_LOGOS (embedded, demo build) → img/coins/<BASE>.png (bundled) → Binance logo from
 *   data/bn_assets.json → same logo via an image proxy that allows WebGL use → painted symbol.
 * If WebGL or three.js is missing, every call degrades to the flat badge (callers handle null). */
(function (root) {
  "use strict";
  const T = () => root.THREE;
  const reduced = () => root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const GOLD = "#F0B90B";

  /* ---------------- colours ---------------- */
  const BRAND = { BTC: "#F7931A", ETH: "#8A92B2", SOL: "#9945FF", BNB: "#F0B90B", DOGE: "#C2A633", PEPE: "#4C9540",
    WIF: "#B98C6A", BONK: "#F5A524", SHIB: "#E8452C", XRP: "#9AA4B2", FLOKI: "#D9822B", SUI: "#4DA2FF", TRUMP: "#C9A227",
    NEIRO: "#E9A23B", PNUT: "#B9783F", POPCAT: "#D9C9B6", FET: "#2A3B6E", TURBO: "#6CC24A", MOODENG: "#9B7B6A",
    AVAX: "#E84142", LINK: "#2A5ADA", WLD: "#9AA4B2", ENA: "#9AA4B2", MEW: "#E8414F", PENGU: "#7FB5E8", GOAT: "#8A8A8A",
    BOME: "#5C9A3A", ORDI: "#9AA4B2", MEME: "#D4A13A", FARTCOIN: "#7C8A5A" };
  const SWATCH = ["#F0B90B", "#0ECB81", "#3B82F6", "#A855F7", "#F97316", "#14B8A6", "#EC4899", "#94A3B8"];
  const learned = {};
  function colorFor(base) {
    if (BRAND[base]) return BRAND[base];
    if (learned[base]) return learned[base];
    let h = 0; for (const ch of String(base)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return SWATCH[h % SWATCH.length];
  }
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
    return "#" + [f(n >> 16), f((n >> 8) & 255), f(n & 255)].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  /** Most saturated average colour of a logo (for coins without a brand colour). */
  function learnColor(base, img) {
    if (BRAND[base] || learned[base]) return;
    try {
      const c = document.createElement("canvas"); c.width = c.height = 24;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0, 24, 24);
      const d = g.getImageData(0, 0, 24, 24).data; let r = 0, gg = 0, b = 0, w = 0;
      for (let i = 0; i < d.length; i += 4) {
        const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        const sat = mx ? (mx - mn) / mx : 0, wt = (d[i + 3] / 255) * (0.15 + sat);
        r += d[i] * wt; gg += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
      }
      if (w > 0) learned[base] = "#" + [r / w, gg / w, b / w].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    } catch (_) {}
  }

  /* ---------------- logos ---------------- */
  const LOCAL = new Set(["AVAX", "BNB", "BOME", "BONK", "BTC", "DOGE", "ENA", "ETH", "FARTCOIN", "FET", "FLOKI", "GOAT", "LINK", "MEME",
    "MEW", "MOODENG", "NEIRO", "ORDI", "PENGU", "PEPE", "PNUT", "POPCAT", "SHIB", "SOL", "SUI", "TRUMP", "TURBO", "WIF", "WLD", "XRP"]);
  let assets = {}; // base → { n: name, l: logo url } from data/bn_assets.json
  function setAssets(a) { assets = a || {}; }
  function logoSources(base) {
    const out = [];
    if (root.COIN_LOGOS && root.COIN_LOGOS[base]) out.push(root.COIN_LOGOS[base]);
    else if (LOCAL.has(base) && !root.COIN_LOGOS) out.push("img/coins/" + base + ".png");
    const bn = assets[base] && assets[base].l;
    if (bn) { out.push(bn); out.push("https://images.weserv.nl/?w=256&url=" + encodeURIComponent(bn.replace(/^https?:\/\//, ""))); }
    return out;
  }
  /** First logo URL for a plain <img> (no CORS needed). */
  function logoUrl(base) { return logoSources(base)[0] || null; }
  const logoCache = new Map();
  function loadLogo(base) {
    if (logoCache.has(base)) return logoCache.get(base);
    const p = (async () => {
      for (const src of logoSources(base)) {
        const img = await new Promise((res) => {
          const im = new Image();
          if (!src.startsWith("data:")) im.crossOrigin = "anonymous";
          im.onload = () => res(im); im.onerror = () => res(null); im.src = src;
          setTimeout(() => res(null), 6000);
        });
        if (img && img.naturalWidth) {
          // a CORS-less image would taint WebGL — test it
          try { const c = document.createElement("canvas"); c.width = c.height = 2; const g = c.getContext("2d"); g.drawImage(img, 0, 0, 2, 2); g.getImageData(0, 0, 1, 1); }
          catch (_) { continue; }
          learnColor(base, img);
          return img;
        }
      }
      return null;
    })();
    logoCache.set(base, p);
    return p;
  }

  function supported() {
    if (!T()) return false;
    if (supported._v != null) return supported._v;
    try { const c = document.createElement("canvas"); supported._v = !!(c.getContext("webgl2") || c.getContext("webgl")); } catch (_) { supported._v = false; }
    return supported._v;
  }

  /* ---------------- textures ---------------- */
  function faceCanvas(base, logo) {
    const S = 512, cv = document.createElement("canvas"); cv.width = cv.height = S;
    const g = cv.getContext("2d"), col = colorFor(base), cx = S / 2;
    // outer rim band: brushed metal tinted with the coin colour
    const rim = g.createRadialGradient(cx * 0.7, cx * 0.6, S * 0.1, cx, cx, S * 0.52);
    rim.addColorStop(0, shade(col, 0.32)); rim.addColorStop(0.55, col); rim.addColorStop(1, shade(col, -0.3));
    g.fillStyle = rim; g.fillRect(0, 0, S, S);
    g.fillStyle = "rgba(255,255,255,0.22)";
    for (let a = 0; a < 72; a++) { const t = a / 72 * Math.PI * 2; g.beginPath(); g.arc(cx + Math.cos(t) * S * 0.455, cx + Math.sin(t) * S * 0.455, 3.2, 0, Math.PI * 2); g.fill(); }
    // inner well
    g.beginPath(); g.arc(cx, cx, S * 0.405, 0, Math.PI * 2); g.fillStyle = shade(col, -0.38); g.fill();
    g.lineWidth = 6; g.strokeStyle = "rgba(255,255,255,0.35)"; g.stroke();
    if (logo) {
      g.save(); g.beginPath(); g.arc(cx, cx, S * 0.385, 0, Math.PI * 2); g.clip();
      g.fillStyle = "#fff"; g.fill();
      const r = S * 0.385 * 2, iw = logo.naturalWidth, ih = logo.naturalHeight, k = Math.max(r / iw, r / ih);
      g.drawImage(logo, cx - iw * k / 2, cx - ih * k / 2, iw * k, ih * k);
      // glass highlight
      const gl = g.createLinearGradient(0, cx - r / 2, 0, cx + r / 2);
      gl.addColorStop(0, "rgba(255,255,255,0.28)"); gl.addColorStop(0.45, "rgba(255,255,255,0)");
      g.fillStyle = gl; g.fillRect(0, 0, S, S);
      g.restore();
    } else {
      const txt = String(base).slice(0, 8);
      let size = 170; const font = (z) => `800 ${z}px "Bricolage Grotesque", system-ui, sans-serif`;
      g.font = font(size); while (size > 40 && g.measureText(txt).width > S * 0.6) { size -= 6; g.font = font(size); }
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillStyle = "rgba(0,0,0,0.35)"; g.fillText(txt, cx + 4, cx + 7);
      g.fillStyle = "#fff"; g.fillText(txt, cx, cx);
    }
    return cv;
  }
  function edgeTexture() {
    const cv = document.createElement("canvas"); cv.width = 512; cv.height = 8;
    const g = cv.getContext("2d");
    for (let x = 0; x < 512; x += 4) { g.fillStyle = x % 8 ? "#8a8a8a" : "#ffffff"; g.fillRect(x, 0, 4, 8); }
    const tex = new (T().CanvasTexture)(cv); tex.wrapS = T().RepeatWrapping; tex.repeat.set(8, 1);
    return tex;
  }
  /** Dark studio with warm strip lights, so metal reads as metal on a black page. */
  function studioEnv(renderer) {
    const cv = document.createElement("canvas"); cv.width = 512; cv.height = 256;
    const g = cv.getContext("2d");
    const sky = g.createLinearGradient(0, 0, 0, 256);
    sky.addColorStop(0, "#3a3f4a"); sky.addColorStop(0.48, "#1a1d23"); sky.addColorStop(0.52, "#0d0f12"); sky.addColorStop(1, "#050607");
    g.fillStyle = sky; g.fillRect(0, 0, 512, 256);
    g.fillStyle = "#ffffff"; g.fillRect(70, 34, 110, 26); g.fillRect(350, 60, 70, 18);
    g.fillStyle = "#ffd24a"; g.fillRect(0, 118, 512, 10); g.fillRect(230, 20, 40, 60);
    const tex = new (T().CanvasTexture)(cv); tex.mapping = T().EquirectangularReflectionMapping;
    const pm = new (T().PMREMGenerator)(renderer);
    const env = pm.fromEquirectangular(tex).texture; tex.dispose(); pm.dispose();
    return env;
  }
  function glowTexture(rgba) {
    const cv = document.createElement("canvas"); cv.width = cv.height = 128;
    const g = cv.getContext("2d"), grd = g.createRadialGradient(64, 64, 2, 64, 64, 62);
    grd.addColorStop(0, rgba); grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    return new (T().CanvasTexture)(cv);
  }

  /* ---------------- coin model ---------------- */
  let _bodyGeo = null, _faceGeo = null, _edgeTex = null;
  const H = 0.11;
  function geos() {
    if (_bodyGeo) return;
    const V = T().Vector2, R = 1, pts = [];
    pts.push(new V(0, H * 0.72), new V(0.86, H * 0.72), new V(0.88, H), new V(0.97, H), new V(R, H * 0.8),
      new V(R, -H * 0.8), new V(0.97, -H), new V(0.88, -H), new V(0.86, -H * 0.72), new V(0, -H * 0.72));
    _bodyGeo = new (T().LatheGeometry)(pts, 96); _bodyGeo.computeVertexNormals();
    _faceGeo = new (T().CircleGeometry)(0.86, 96);
  }
  function makeCoin(base, env) {
    const THREE = T(); geos();
    if (!_edgeTex) _edgeTex = edgeTexture();
    const col = new THREE.Color(colorFor(base));
    const metal = new THREE.MeshStandardMaterial({ color: col, metalness: 1, roughness: 0.22, envMap: env, envMapIntensity: 1.4, bumpMap: _edgeTex, bumpScale: 0.012 });
    const faceTex = new THREE.CanvasTexture(faceCanvas(base, null));
    faceTex.anisotropy = 4; if (THREE.sRGBEncoding) faceTex.encoding = THREE.sRGBEncoding;
    const faceMat = new THREE.MeshStandardMaterial({ map: faceTex, metalness: 0.2, roughness: 0.35, envMap: env, envMapIntensity: 0.5 });
    const group = new THREE.Group();
    const body = new THREE.Mesh(_bodyGeo, metal); body.rotation.x = Math.PI / 2; group.add(body);
    const front = new THREE.Mesh(_faceGeo, faceMat); front.position.z = H * 0.72 + 0.001; group.add(front);
    const back = new THREE.Mesh(_faceGeo, faceMat); back.position.z = -(H * 0.72 + 0.001); back.rotation.y = Math.PI; group.add(back);
    let alive = true;
    const ready = loadLogo(base).then((logo) => {
      if (!alive) return;
      metal.color.set(colorFor(base));
      faceTex.image = faceCanvas(base, logo); faceTex.needsUpdate = true;
    });
    group.userData = { base, ready, dispose() { alive = false; metal.dispose(); faceTex.dispose(); faceMat.dispose(); } };
    return group;
  }

  /* ---------------- renderer helpers ---------------- */
  function lights(scene) {
    const THREE = T();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x202530, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.15); key.position.set(3, 5, 6); scene.add(key);
    const warm = new THREE.DirectionalLight(0xffc940, 0.7); warm.position.set(-5, 1, 3); scene.add(warm);
    const rim = new THREE.DirectionalLight(0x9db4ff, 0.45); rim.position.set(2, 3, -5); scene.add(rim);
  }
  function makeRenderer(opts) {
    const THREE = T();
    const r = new THREE.WebGLRenderer(Object.assign({ antialias: true, alpha: true, powerPreference: "low-power" }, opts || {}));
    r.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
    if (THREE.sRGBEncoding) r.outputEncoding = THREE.sRGBEncoding;
    r.toneMapping = THREE.NoToneMapping;
    return r;
  }
  function stage(el) {
    const THREE = T(), renderer = makeRenderer();
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    const env = studioEnv(renderer); lights(scene);
    let w = 0, h = 0;
    function resize() {
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false;
      if (r.width === w && r.height === h) return true;
      w = r.width; h = r.height; renderer.setSize(w, h, false);
      renderer.domElement.style.width = w + "px"; renderer.domElement.style.height = h + "px";
      camera.aspect = w / h; camera.updateProjectionMatrix(); return true;
    }
    return { THREE, renderer, scene, camera, env, resize, get w() { return w; }, get h() { return h; } };
  }
  function loop(st, frame) {
    let raf = 0, visible = true, last = performance.now();
    const io = "IntersectionObserver" in root ? new IntersectionObserver((e) => { visible = e[0].isIntersecting; if (visible && !raf) tick(); }) : null;
    io && io.observe(st.renderer.domElement);
    function tick() {
      raf = 0;
      if (!visible || document.hidden) return;
      const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (st.resize()) { frame(dt, now / 1000); st.renderer.render(st.scene, st.camera); }
      raf = requestAnimationFrame(tick);
    }
    document.addEventListener("visibilitychange", () => { if (!document.hidden && !raf) { last = performance.now(); tick(); } });
    tick();
    return () => { cancelAnimationFrame(raf); io && io.disconnect(); };
  }

  /* ---------------- podium ---------------- */
  function podium(el, onPick) {
    if (!supported()) return null;
    const st = stage(el), THREE = st.THREE;
    st.scene.fog = new THREE.Fog(0x0d1013, 7, 15);
    const grid = new THREE.GridHelper(24, 32, 0x6b5714, 0x2a3038); grid.position.y = -1.6;
    grid.material.transparent = true; grid.material.opacity = 0.32; grid.material.depthWrite = false; st.scene.add(grid);
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshBasicMaterial({ map: glowTexture("rgba(240,185,11,0.35)"), transparent: true, depthWrite: false }));
    pool.rotation.x = -Math.PI / 2; pool.position.y = -1.59; st.scene.add(pool);
    const pedMat = new THREE.MeshStandardMaterial({ color: 0x1c2026, metalness: 0.85, roughness: 0.3, envMap: st.env, envMapIntensity: 1 });
    const glowTex = glowTexture("rgba(255,214,90,0.9)");
    const HEIGHTS = [1.0, 0.6, 0.35]; // rank 1, 2, 3
    let items = [];
    const ray = new THREE.Raycaster(), ptr = new THREE.Vector2(); let hover = null; const tilt = { x: 0, y: 0 };

    function layout() {
      const narrow = st.w < 520;
      st.camera.position.set(0, 1.5, narrow ? 9.0 : 8.2);
      st.camera.lookAt(0, narrow ? -0.55 : -0.3, 0);
      const gap = narrow ? 2.2 : 2.6;
      items.forEach((it, i) => { it.x = i === 0 ? 0 : i === 1 ? -gap : gap; });
    }
    function set(list) {
      for (const it of items) { st.scene.remove(it.group, it.ped, it.ring, it.halo); it.group.userData.dispose(); }
      items = list.slice(0, 3).map((c, i) => {
        const group = makeCoin(c.base, st.env);
        const scale = i === 0 ? 1.0 : 0.82; group.scale.setScalar(scale);
        const hgt = HEIGHTS[i];
        const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.05, hgt, 64), pedMat);
        ped.position.y = -1.6 + hgt / 2;
        const ringCol = c.stage === "late" ? 0x5e6673 : c.stage === "build" ? 0x8aa4ff : 0xf0b90b;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.96, 0.03, 12, 96), new THREE.MeshBasicMaterial({ color: ringCol }));
        ring.rotation.x = -Math.PI / 2; ring.position.y = -1.6 + hgt;
        const halo = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), new THREE.MeshBasicMaterial({ map: glowTex, color: ringCol, transparent: true, depthWrite: false, opacity: 0.55 }));
        halo.rotation.x = -Math.PI / 2; halo.position.y = -1.6 + hgt + 0.01;
        st.scene.add(group, ped, ring, halo);
        group.rotation.y = -0.5 + i * 0.7;
        return { group, ped, ring, halo, sym: c.sym, top: -1.6 + hgt, y: -1.6, spin: 0.4 + i * 0.05, phase: i * 1.7, scale };
      });
      layout();
    }
    function pick(ev) {
      const r = st.renderer.domElement.getBoundingClientRect();
      ptr.x = ((ev.clientX - r.left) / r.width) * 2 - 1; ptr.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(ptr, st.camera);
      const hit = ray.intersectObjects(items.flatMap((i) => [i.group, i.ped]), true)[0];
      if (!hit) return null;
      return items.find((i) => i.ped === hit.object || i.group === hit.object || i.group.children.includes(hit.object)) || null;
    }
    const cv = st.renderer.domElement;
    cv.addEventListener("pointermove", (ev) => {
      const r = cv.getBoundingClientRect();
      tilt.x = ((ev.clientY - r.top) / r.height - 0.5) * 0.2; tilt.y = ((ev.clientX - r.left) / r.width - 0.5) * 0.4;
      hover = pick(ev); cv.style.cursor = hover ? "pointer" : "default";
    });
    cv.addEventListener("pointerleave", () => { hover = null; tilt.x = tilt.y = 0; });
    cv.addEventListener("click", (ev) => { const it = pick(ev); if (it && onPick) onPick(it.sym); });

    const still = reduced();
    const stop = loop(st, (dt, t) => {
      layout();
      for (const it of items) {
        const target = it.top + 1.15 * it.scale;
        it.y += (target - it.y) * Math.min(1, dt * 3);
        const bob = still ? 0 : Math.sin(t * 1.4 + it.phase) * 0.07;
        it.group.position.set(it.x, it.y + bob, 0);
        it.ped.position.x = it.ring.position.x = it.halo.position.x = it.x;
        if (!still) it.group.rotation.y += dt * (hover === it ? 2.4 : it.spin);
        it.group.rotation.x = tilt.x;
        const s = hover === it ? it.scale * 1.07 : it.scale;
        it.group.scale.setScalar(it.group.scale.x + (s - it.group.scale.x) * Math.min(1, dt * 8));
        it.halo.material.opacity = 0.45 + (still ? 0 : Math.sin(t * 2 + it.phase) * 0.12);
      }
      st.scene.rotation.y += (tilt.y * 0.35 - st.scene.rotation.y) * Math.min(1, dt * 4);
    });
    return { set, destroy() { stop(); st.renderer.dispose(); cv.remove(); } };
  }

  /* ---------------- single coin ---------------- */
  function single(el) {
    if (!supported()) return null;
    const st = stage(el); let coin = null, drag = null, vel = 0.9;
    st.camera.position.set(0, 0, 4.4); st.camera.lookAt(0, 0, 0);
    const halo = new st.THREE.Mesh(new st.THREE.PlaneGeometry(4.2, 4.2), new st.THREE.MeshBasicMaterial({ map: glowTexture("rgba(240,185,11,0.32)"), transparent: true, depthWrite: false }));
    halo.position.z = -1.2; st.scene.add(halo);
    const cv = st.renderer.domElement;
    cv.addEventListener("pointerdown", (e) => { drag = e.clientX; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener("pointermove", (e) => { if (drag == null || !coin) return; const d = (e.clientX - drag) / 60; coin.rotation.y += d; vel = d * 30; drag = e.clientX; });
    cv.addEventListener("pointerup", () => { drag = null; });
    const still = reduced();
    const stop = loop(st, (dt, t) => {
      if (!coin) return;
      if (drag == null) { vel += ((still ? 0 : 0.9) - vel) * Math.min(1, dt * 1.5); coin.rotation.y += vel * dt; }
      coin.position.y = still ? 0 : Math.sin(t * 1.6) * 0.05;
    });
    return {
      set(base) {
        if (coin && coin.userData.base === base) return;
        if (coin) { st.scene.remove(coin); coin.userData.dispose(); }
        coin = makeCoin(base, st.env); coin.rotation.y = -0.6; coin.scale.setScalar(1.05); st.scene.add(coin);
      },
      destroy() { stop(); st.renderer.dispose(); cv.remove(); },
    };
  }


  /* ---------------- engineer mascot ---------------- */
  /** Original chibi engineer: yellow hard hat with an M badge, high-vis vest, waving right arm, wrench in the left hand. */
  function buildEngineer(env) {
    const THREE = T(), g = new THREE.Group();
    const std = (color, o) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.55, metalness: 0.05, envMap: env, envMapIntensity: 0.35 }, o || {}));
    const skin = std(0xf2c29b, { roughness: 0.7 }), shirt = std(0x1e3a6e), vest = std(0xff5a00, { roughness: 0.6 });
    const reflect = std(0xe8edf2, { metalness: 0.9, roughness: 0.2, envMapIntensity: 1.2 });
    const hat = std(0xf0b90b, { metalness: 0.35, roughness: 0.22, envMapIntensity: 1.1 });
    const dark = std(0x14181d, { roughness: 0.4 }), white = std(0xffffff, { roughness: 0.3 }), pink = std(0xff9a9a, { roughness: 0.8 });
    const steel = std(0xaab3bd, { metalness: 1, roughness: 0.25, envMapIntensity: 1.3 });
    const mesh = (geo, mat, x, y, z, parent) => { const m = new THREE.Mesh(geo, mat); m.position.set(x || 0, y || 0, z || 0); (parent || g).add(m); return m; };
    const capsule = (r, len, mat, parent) => { const c = new THREE.Group();
      mesh(new THREE.CylinderGeometry(r, r, len, 24), mat, 0, 0, 0, c); mesh(new THREE.SphereGeometry(r, 24, 16), mat, 0, len / 2, 0, c); mesh(new THREE.SphereGeometry(r, 24, 16), mat, 0, -len / 2, 0, c);
      (parent || g).add(c); return c; };
    const V = THREE.Vector2;
    // legs + shoes
    for (const x of [-0.24, 0.24]) {
      mesh(new THREE.CylinderGeometry(0.16, 0.15, 0.5, 20), shirt, x, -0.85, 0);
      const shoe = mesh(new THREE.SphereGeometry(0.2, 20, 14), dark, x, -1.12, 0.07); shoe.scale.set(1, 0.55, 1.35);
    }
    // torso (lathe) + vest shell + reflective stripes
    const torsoPts = [new V(0, -0.62), new V(0.5, -0.6), new V(0.6, -0.4), new V(0.6, 0.05), new V(0.52, 0.4), new V(0.3, 0.55), new V(0, 0.58)];
    mesh(new THREE.LatheGeometry(torsoPts, 40), shirt, 0, -0.05, 0);
    const vestShell = mesh(new THREE.LatheGeometry(torsoPts.slice(0, 6).map((p) => new V(p.x * 1.04, p.y)), 40, -Math.PI * 0.62, Math.PI * 1.24), vest, 0, -0.05, 0);
    vestShell.material = vest.clone(); vestShell.material.side = THREE.DoubleSide;
    for (const y of [-0.4, -0.12]) { const band = mesh(new THREE.CylinderGeometry(0.635, 0.635, 0.07, 40, 1, true, -Math.PI * 0.62, Math.PI * 1.24), reflect, 0, y, 0); band.material = reflect.clone(); band.material.side = THREE.DoubleSide; }
    mesh(new THREE.SphereGeometry(0.05, 12, 10), white, 0, 0.25, 0.57); mesh(new THREE.SphereGeometry(0.05, 12, 10), white, 0, 0.05, 0.6);
    // head
    const head = new THREE.Group(); head.position.y = 1.08; g.add(head);
    mesh(new THREE.SphereGeometry(0.62, 40, 30), skin, 0, 0, 0, head);
    const eyes = new THREE.Group(); head.add(eyes);
    for (const x of [-0.21, 0.21]) {
      const e = mesh(new THREE.SphereGeometry(0.085, 20, 14), dark, x, -0.02, 0.56, eyes); e.scale.set(1, 1.25, 0.6);
      mesh(new THREE.SphereGeometry(0.028, 10, 8), white, x + 0.03, 0.03, 0.6, eyes);
      const ck = mesh(new THREE.SphereGeometry(0.09, 16, 12), pink, x * 1.55, -0.17, 0.47, head); ck.scale.set(1, 0.6, 0.4);
    }
    const smile = mesh(new THREE.TorusGeometry(0.11, 0.022, 10, 24, Math.PI), dark, 0, -0.17, 0.58, head); smile.rotation.z = Math.PI;
    for (const x of [-0.6, 0.6]) mesh(new THREE.SphereGeometry(0.11, 14, 10), skin, x, -0.02, 0, head);
    // hard hat: dome, brim with front visor, centre ridge, M badge
    const hatG = new THREE.Group(); hatG.position.y = 0.12; hatG.rotation.x = -0.12; head.add(hatG);
    mesh(new THREE.SphereGeometry(0.68, 40, 24, 0, Math.PI * 2, 0, Math.PI / 2), hat, 0, 0, 0, hatG);
    const brim = mesh(new THREE.CylinderGeometry(0.76, 0.78, 0.06, 48), hat, 0, 0.0, 0.05, hatG); brim.scale.set(1, 1, 1.12);
    const ridge = mesh(new THREE.TorusGeometry(0.66, 0.06, 12, 40, Math.PI), hat, 0, 0, 0, hatG); ridge.rotation.y = Math.PI / 2;
    const badge = mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.04, 32), hat, 0, 0.33, 0.6, hatG); badge.rotation.x = Math.PI / 2 - 0.5;
    const cv = document.createElement("canvas"); cv.width = cv.height = 128; const x = cv.getContext("2d");
    x.fillStyle = "#14181d"; x.beginPath(); x.arc(64, 64, 62, 0, Math.PI * 2); x.fill();
    x.font = '800 84px "Bricolage Grotesque", system-ui, sans-serif'; x.textAlign = "center"; x.textBaseline = "middle"; x.fillStyle = "#f0b90b"; x.fillText("M", 64, 70);
    const bt = new THREE.CanvasTexture(cv); if (THREE.sRGBEncoding) bt.encoding = THREE.sRGBEncoding;
    const face = mesh(new THREE.CircleGeometry(0.14, 32), new THREE.MeshStandardMaterial({ map: bt, roughness: 0.4 }), 0, 0.348, 0.62, hatG); face.rotation.x = -0.5;
    // arms: left holds a wrench, right waves
    const armL = new THREE.Group(); armL.position.set(-0.62, 0.32, 0); armL.rotation.z = -0.35; g.add(armL);
    const al = capsule(0.13, 0.42, vest, armL); al.position.y = -0.3; mesh(new THREE.SphereGeometry(0.15, 18, 14), skin, 0, -0.62, 0, armL);
    const wrench = new THREE.Group(); wrench.position.set(0, -0.68, 0.12); wrench.rotation.set(0.3, 0, 0.9); armL.add(wrench);
    mesh(new THREE.BoxGeometry(0.09, 0.62, 0.05), steel, 0, -0.25, 0, wrench);
    const jaw = mesh(new THREE.TorusGeometry(0.11, 0.045, 10, 20, Math.PI * 1.5), steel, 0, -0.6, 0, wrench); jaw.rotation.z = Math.PI * 0.25;
    const armR = new THREE.Group(); armR.position.set(0.62, 0.32, 0); armR.rotation.z = 2.5; g.add(armR);
    const ar = capsule(0.13, 0.42, vest, armR); ar.position.y = -0.3; mesh(new THREE.SphereGeometry(0.15, 18, 14), skin, 0, -0.62, 0, armR);
    g.userData = { head, eyes, armR };
    return g;
  }
  function animateEngineer(m, t, still) {
    const u = m.userData; if (!u.head) return;
    if (still) return;
    u.armR.rotation.z = 2.5 + Math.sin(t * 6) * 0.35;
    const blink = (t % 3.6) < 0.12 ? 0.15 : 1; u.eyes.scale.y = blink;
    m.position.y = Math.abs(Math.sin(t * 2.2)) * 0.06;
  }
  /** Live mascot in a small canvas: waves, blinks, and turns his head toward the pointer. */
  function mascot(el) {
    if (!supported()) return null;
    const st = stage(el), m = buildEngineer(st.env);
    st.scene.add(m); m.rotation.y = -0.35;
    st.camera.position.set(0, 0.5, 6.4); st.camera.lookAt(0, 0.35, 0);
    const halo = new st.THREE.Mesh(new st.THREE.PlaneGeometry(4.4, 4.4), new st.THREE.MeshBasicMaterial({ map: glowTexture("rgba(240,185,11,0.28)"), transparent: true, depthWrite: false }));
    halo.position.set(0, 0.4, -1.4); st.scene.add(halo);
    let look = 0;
    root.addEventListener("pointermove", (e) => { look = ((e.clientX / root.innerWidth) - 0.5) * 0.9; }, { passive: true });
    const still = reduced();
    const stop = loop(st, (dt, t) => {
      animateEngineer(m, t, still);
      m.userData.head.rotation.y += (look - m.userData.head.rotation.y) * Math.min(1, dt * 4);
    });
    return { destroy() { stop(); st.renderer.dispose(); st.renderer.domElement.remove(); } };
  }

  /* ---------------- snapshot renderer: thumbnails + icons ---------------- */
  let snap = null;
  function snapper() {
    if (snap) return snap;
    const THREE = T(), SIZE = 192;
    const renderer = makeRenderer({ preserveDrawingBuffer: true });
    renderer.setPixelRatio(1); renderer.setSize(SIZE, SIZE, false);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    lights(scene);
    snap = { THREE, renderer, scene, camera, env: studioEnv(renderer), queue: Promise.resolve() };
    return snap;
  }
  /** Render an object to a PNG data URL; jobs run one at a time on the shared renderer. */
  function shoot(build, cam) {
    const s = snapper();
    const job = s.queue.then(async () => {
      const obj = await build(s);
      s.scene.add(obj);
      s.camera.position.set(...(cam || [0, 0, 4.1])); s.camera.lookAt(0, 0, 0);
      s.renderer.setClearColor(0x000000, 0); s.renderer.render(s.scene, s.camera);
      const url = s.renderer.domElement.toDataURL("image/png");
      s.scene.remove(obj);
      obj.traverse((o) => { if (o.geometry && o.geometry !== _bodyGeo && o.geometry !== _faceGeo) o.geometry.dispose(); });
      obj.userData.dispose && obj.userData.dispose();
      return url;
    });
    s.queue = job.catch(() => {});
    return job;
  }
  const thumbs = new Map(), thumbDone = new Map();
  function thumb(base) {
    if (!supported()) return Promise.resolve(null);
    if (thumbs.has(base)) return thumbs.get(base);
    const p = shoot(async (s) => {
      const c = makeCoin(base, s.env); await c.userData.ready;
      c.rotation.set(0.12, -0.42, 0); c.scale.setScalar(1.18);
      return c;
    }).then((u) => { thumbDone.set(base, u); return u; }).catch(() => null);
    thumbs.set(base, p);
    return p;
  }
  /** Synchronous: the finished thumbnail, or undefined while it renders. */
  thumb.ready = (base) => thumbDone.get(base);

  /* 3D UI icons, modelled from primitives */
  const icons = new Map();
  function icon(kind) {
    if (!supported()) return Promise.resolve(null);
    if (icons.has(kind)) return icons.get(kind);
    const cam = kind === "mark" ? [0, 0, 4.2] : kind === "engineer" ? [0, 0.3, 6.6] : kind === "engineerHead" ? [0, 0.15, 3.3] : [0, 1.7, 4.4];
    const p = shoot((s) => buildIcon(kind, s), cam).catch(() => null);
    icons.set(kind, p);
    return p;
  }
  function buildIcon(kind, s) {
    const THREE = T();
    if (kind === "engineer" || kind === "engineerHead") {
      const wrap = new THREE.Group(), m = buildEngineer(s.env); m.rotation.y = -0.3; wrap.add(m);
      m.position.y = kind === "engineer" ? -0.42 : -1.2; if (kind === "engineerHead") m.userData.armR.visible = false;
      return wrap;
    }
    const g = new THREE.Group();
    const gold = new THREE.MeshStandardMaterial({ color: GOLD, metalness: 1, roughness: 0.25, envMap: s.env, envMapIntensity: 1.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b3139, metalness: 0.7, roughness: 0.35, envMap: s.env, envMapIntensity: 1 });
    const glow = new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    const green = new THREE.MeshStandardMaterial({ color: 0x0ecb81, metalness: 0.3, roughness: 0.3, emissive: 0x0a5a3a });
    const add = (geo, mat, x, y, z, rx, ry, rz) => { const m = new THREE.Mesh(geo, mat); m.position.set(x || 0, y || 0, z || 0); m.rotation.set(rx || 0, ry || 0, rz || 0); g.add(m); return m; };
    if (kind === "radar") {
      add(new THREE.CylinderGeometry(1.25, 1.3, 0.22, 64), dark, 0, -0.2, 0);
      add(new THREE.TorusGeometry(1.0, 0.05, 12, 64), gold, 0, -0.07, 0, Math.PI / 2);
      add(new THREE.TorusGeometry(0.6, 0.05, 12, 64), gold, 0, -0.07, 0, Math.PI / 2);
      add(new THREE.CircleGeometry(1.0, 32, 0, 0.9), glow, 0, -0.06, 0, -Math.PI / 2, 0, 0.5);
      add(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 16), gold, 0, 0.35, 0);
      add(new THREE.SphereGeometry(0.16, 24, 16), gold, 0, 0.82, 0);
      add(new THREE.SphereGeometry(0.12, 24, 16), green, 0.62, -0.02, 0.32);
    } else if (kind === "markets") {
      add(new THREE.BoxGeometry(2.4, 0.16, 1.1), dark, 0, -0.75, 0);
      [[-0.75, 0.5], [0, 0.95], [0.75, 1.45]].forEach(([x, h]) => add(new THREE.BoxGeometry(0.5, h, 0.5), gold, x, -0.67 + h / 2, 0));
      const arrow = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.9, 12), green);
      shaft.rotation.z = -Math.PI / 2 + 0.55; arrow.add(shaft);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.42, 20), green);
      head.position.set(0.85, 0.55, 0); head.rotation.z = -Math.PI / 2 + 0.55; arrow.add(head);
      arrow.position.set(0, 0.35, 0.45); g.add(arrow);
    } else if (kind === "wallet") {
      const shape = new THREE.Shape(); const w = 2.2, h = 1.5, r = 0.25;
      shape.moveTo(-w / 2 + r, -h / 2); shape.lineTo(w / 2 - r, -h / 2); shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
      shape.lineTo(w / 2, h / 2 - r); shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2); shape.lineTo(-w / 2 + r, h / 2);
      shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r); shape.lineTo(-w / 2, -h / 2 + r); shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
      const body = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 4 }), dark);
      body.position.z = -0.25; g.add(body);
      add(new THREE.BoxGeometry(0.9, 0.55, 0.2), gold, 0.75, 0, 0.32);
      add(new THREE.SphereGeometry(0.09, 16, 12), dark, 0.95, 0, 0.45);
      geos(); const coin = new THREE.Mesh(_bodyGeo, gold); coin.scale.setScalar(0.5); coin.position.set(-0.45, 0.85, 0); coin.rotation.set(Math.PI / 2, 0, 0.4); g.add(coin);
      g.rotation.set(-0.25, -0.35, 0);
    } else if (kind === "trophy") {
      const V = THREE.Vector2;
      const cup = [new V(0, -0.1), new V(0.45, -0.05), new V(0.75, 0.35), new V(0.85, 0.95), new V(0.8, 1.0), new V(0.7, 0.98)];
      const cupMesh = add(new THREE.LatheGeometry(cup, 48), gold, 0, -0.25, 0); cupMesh.material = gold.clone(); cupMesh.material.side = THREE.DoubleSide;
      add(new THREE.TorusGeometry(0.33, 0.07, 12, 32, Math.PI * 1.1), gold, -0.83, 0.38, 0, 0, 0, Math.PI * 0.45);
      add(new THREE.TorusGeometry(0.33, 0.07, 12, 32, Math.PI * 1.1), gold, 0.83, 0.38, 0, 0, Math.PI, Math.PI * 0.45);
      add(new THREE.CylinderGeometry(0.12, 0.16, 0.55, 24), gold, 0, -0.55, 0);
      add(new THREE.BoxGeometry(1.1, 0.3, 0.8), dark, 0, -0.95, 0);
      add(new THREE.SphereGeometry(0.12, 16, 12), green, 0, -0.95, 0.42);
    } else if (kind === "stack") {
      geos();
      [[0, -0.75, 0, 0], [0.08, -0.5, 0.05, 0.3], [-0.05, -0.25, -0.03, 0.8], [0.04, 0.0, 0.02, 1.4]].forEach(([x0, y0, z0, r]) => {
        const c = new THREE.Mesh(_bodyGeo, gold); c.scale.set(0.95, 1.4, 0.95); c.position.set(x0, y0, z0); c.rotation.y = r; g.add(c);
      });
      const top = new THREE.Mesh(_bodyGeo, gold); top.scale.setScalar(0.8); top.position.set(0.15, 0.55, 0.1); top.rotation.set(Math.PI / 2 - 0.35, 0, 0.25); g.add(top);
      const up = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.42, 20), green); up.position.set(-0.85, 0.45, 0.3); g.add(up);
      add(new THREE.CylinderGeometry(0.08, 0.08, 0.5, 12), green, -0.85, 0.05, 0.3);
    } else if (kind === "aiwatch") {
      add(new THREE.TorusGeometry(0.95, 0.12, 16, 48), gold, 0, 0, 0);
      add(new THREE.SphereGeometry(0.38, 24, 24), green, 0, 0, 0.05);
      add(new THREE.SphereGeometry(0.16, 16, 16), dark, 0, 0, 0.42);
    } else if (kind === "gainers") {
      add(new THREE.BoxGeometry(2.2, 0.14, 1.0), dark, 0, -0.85, 0);
      [[-0.7, 0.55], [-0.05, 1.05], [0.65, 1.55]].forEach(([x, h], i) => {
        add(new THREE.BoxGeometry(0.48, h, 0.48), i === 2 ? green : gold, x, -0.78 + h / 2, 0);
      });
      const arrow = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.6, 12), green);
      shaft.rotation.z = -Math.PI / 2 + 0.85; arrow.add(shaft);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.48, 20), green);
      head.position.set(0.55, 0.72, 0); head.rotation.z = -Math.PI / 2 + 0.85; arrow.add(head);
      arrow.position.set(-0.15, 0.15, 0.5); g.add(arrow);
    } else if (kind === "mark") {
      geos();
      const c = new THREE.Mesh(_bodyGeo, gold); c.rotation.x = Math.PI / 2; g.add(c);
      const cv = document.createElement("canvas"); cv.width = cv.height = 256; const x = cv.getContext("2d");
      const grd = x.createRadialGradient(90, 80, 10, 128, 128, 140); grd.addColorStop(0, "#ffe27a"); grd.addColorStop(1, "#c98f00");
      x.fillStyle = grd; x.fillRect(0, 0, 256, 256);
      x.font = '800 150px "Bricolage Grotesque", system-ui, sans-serif'; x.textAlign = "center"; x.textBaseline = "middle";
      x.fillStyle = "rgba(0,0,0,.35)"; x.fillText("M", 132, 140); x.fillStyle = "#1a1300"; x.fillText("M", 128, 134);
      const tex = new THREE.CanvasTexture(cv); if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
      add(_faceGeo, new THREE.MeshStandardMaterial({ map: tex, metalness: 0.5, roughness: 0.3, envMap: s.env, envMapIntensity: 0.8 }), 0, 0, H * 0.72 + 0.002);
      g.rotation.set(0.1, -0.45, 0); g.scale.setScalar(1.3);
    }
    if (kind !== "mark") g.scale.setScalar(kind === "wallet" ? 1.05 : 1.15);
    return g;
  }

  root.Coin3D = { podium, single, thumb, icon, mascot, colorFor, shade, supported, setAssets, logoUrl };
})(window);
