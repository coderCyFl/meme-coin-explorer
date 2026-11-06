/* three.js procedural coin for Coin Mood + trade sheet.
 * Loads THREE via ESM CDN; falls back to 2D logo if CDN fails.
 * No GLTF assets — CylinderGeometry + logo textures. */
(() => {
  "use strict";
  const CDN = "https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js";
  const CDN_FALLBACK = "https://unpkg.com/three@0.160.1/build/three.module.js";

  let threePromise = null;
  let THREE = null;

  function reduceMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function loadThree() {
    if (THREE) return Promise.resolve(THREE);
    if (threePromise) return threePromise;
    threePromise = import(CDN)
      .catch(() => import(CDN_FALLBACK))
      .then((mod) => {
        THREE = mod;
        return THREE;
      })
      .catch((err) => {
        threePromise = null;
        console.warn("[coin3d] three.js CDN failed", err);
        return null;
      });
    return threePromise;
  }

  function logoCandidates(base) {
    if (window.MCE && window.MCE.live && typeof window.MCE.live.logoUrl === "function") {
      // Prefer live.js candidate list when available
      try {
        const raw = String(base || "").toUpperCase();
        if (!raw) return [];
        // Replicate live.js order via probing logoUrl + common CDNs
      } catch (_) {}
    }
    const raw = String(base || "").toUpperCase();
    if (!raw) return [];
    const alias = { XBT: "BTC", WETH: "ETH", WBNB: "BNB", WSOL: "SOL" };
    const lower = (alias[raw] || raw).toLowerCase();
    return [
      "https://bin.bnbstatic.com/static/assets/logos/" + encodeURIComponent(raw) + ".png",
      "https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/" + encodeURIComponent(lower) + ".png",
      "https://assets.coincap.io/assets/icons/" + encodeURIComponent(lower) + "@2x.png",
    ];
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("img fail"));
      img.src = url;
    });
  }

  async function firstLogo(base) {
    const urls = logoCandidates(base);
    for (const u of urls) {
      try {
        return await loadImage(u);
      } catch (_) {}
    }
    return null;
  }

  function makeFaceCanvas(img, base, size) {
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d");
    // dark gold face
    const g = ctx.createRadialGradient(size * 0.35, size * 0.3, size * 0.05, size * 0.5, size * 0.5, size * 0.55);
    g.addColorStop(0, "#2a2414");
    g.addColorStop(0.7, "#12100a");
    g.addColorStop(1, "#0a0906");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
    // gold ring
    ctx.strokeStyle = "#c9a227";
    ctx.lineWidth = Math.max(3, size * 0.035);
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - ctx.lineWidth, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "#f0b90b88";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - ctx.lineWidth - size * 0.04, 0, Math.PI * 2);
    ctx.stroke();

    const inset = size * 0.18;
    const box = size - inset * 2;
    if (img) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, box / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, inset, inset, box, box);
      ctx.restore();
    } else {
      ctx.fillStyle = "#f0b90b";
      ctx.font = "700 " + Math.floor(size * 0.28) + "px system-ui,sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(base || "?").slice(0, 2).toUpperCase(), size / 2, size / 2 + 2);
    }
    return c;
  }

  function cssFallback(host, base, px) {
    host.textContent = "";
    host.classList.add("coin3d-host", "coin3d-fallback");
    const live = window.MCE && window.MCE.live;
    if (live && live.coinLogoEl) {
      host.append(live.coinLogoEl(base, "coin-logo mood-logo", Math.round(px * 0.72)));
    } else {
      const s = document.createElement("span");
      s.className = "coin-logo letter mood-logo";
      s.textContent = String(base || "?").slice(0, 2).toUpperCase();
      host.append(s);
    }
  }

  function createInstance(host, px) {
    const T = THREE;
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(32, 1, 0.1, 20);
    camera.position.z = 3.35;

    const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(px, px, false);
    renderer.setClearColor(0x000000, 0);
    const canvas = renderer.domElement;
    canvas.className = "coin3d-canvas";
    canvas.setAttribute("aria-hidden", "true");
    host.textContent = "";
    host.classList.add("coin3d-host");
    host.classList.remove("coin3d-fallback");
    host.append(canvas);

    const ambient = new T.AmbientLight(0xffffff, 0.85);
    const key = new T.DirectionalLight(0xffe6a0, 0.95);
    key.position.set(2.2, 2.5, 3.5);
    const fill = new T.DirectionalLight(0x88aacc, 0.35);
    fill.position.set(-2, -1, 2);
    scene.add(ambient, key, fill);

    const edgeMat = new T.MeshStandardMaterial({
      color: 0xc9a227,
      metalness: 0.85,
      roughness: 0.28,
    });
    const frontMat = new T.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.35,
      roughness: 0.45,
    });
    const backMat = frontMat.clone();

    // materials order for CylinderGeometry: [side, top, bottom]
    const geo = new T.CylinderGeometry(1, 1, 0.16, 64);
    const mesh = new T.Mesh(geo, [edgeMat, frontMat, backMat]);
    mesh.rotation.x = Math.PI / 2; // face camera
    scene.add(mesh);

    const state = {
      host,
      px,
      base: "",
      scene,
      camera,
      renderer,
      mesh,
      geo,
      edgeMat,
      frontMat,
      backMat,
      texFront: null,
      texBack: null,
      raf: 0,
      alive: true,
      spinning: !reduceMotion(),
      angle: -0.35,
      loadGen: 0,
      visObs: null,
    };

    function renderFrame() {
      if (!state.alive) return;
      // After rotateX(PI/2) the coin faces the camera; spin on world Y to show both faces.
      mesh.rotation.y = state.angle;
      renderer.render(scene, camera);
    }

    function tick() {
      if (!state.alive) return;
      if (state.spinning && !document.hidden) {
        state.angle += 0.012;
        renderFrame();
      }
      state.raf = requestAnimationFrame(tick);
    }

    function setSize(n) {
      state.px = n;
      renderer.setSize(n, n, false);
      host.style.width = n + "px";
      host.style.height = n + "px";
      renderFrame();
    }

    async function setBase(base) {
      const b = String(base || "").toUpperCase();
      if (!b) return;
      if (b === state.base && (state.texFront || state.frontMat.map)) return;
      state.base = b;
      const gen = ++state.loadGen;
      const img = await firstLogo(b);
      if (!state.alive || gen !== state.loadGen) return;
      const face = makeFaceCanvas(img, b, 256);
      const tex = new T.CanvasTexture(face);
      if (T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;
      tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy?.() || 1);
      // dispose old
      if (state.texFront) state.texFront.dispose();
      if (state.texBack) state.texBack.dispose();
      state.texFront = tex;
      state.texBack = tex.clone();
      // Flip back face so logo reads correctly when spun
      state.texBack.center.set(0.5, 0.5);
      state.texBack.rotation = Math.PI;
      frontMat.map = state.texFront;
      backMat.map = state.texBack;
      frontMat.needsUpdate = true;
      backMat.needsUpdate = true;
      renderFrame();
    }

    function dispose() {
      state.alive = false;
      if (state.raf) cancelAnimationFrame(state.raf);
      state.raf = 0;
      if (state.visObs) {
        try { state.visObs.disconnect(); } catch (_) {}
        state.visObs = null;
      }
      try {
        if (state.texFront) state.texFront.dispose();
        if (state.texBack) state.texBack.dispose();
        geo.dispose();
        edgeMat.dispose();
        frontMat.dispose();
        backMat.dispose();
        renderer.dispose();
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      } catch (_) {}
      host._mceCoin3d = null;
    }

    // Pause when offscreen / tab hidden
    if (typeof IntersectionObserver !== "undefined") {
      state.visObs = new IntersectionObserver((entries) => {
        const on = entries.some((e) => e.isIntersecting);
        state.spinning = on && !reduceMotion();
        if (!state.spinning) renderFrame();
      }, { threshold: 0.05 });
      state.visObs.observe(host);
    }
    document.addEventListener("visibilitychange", () => {
      if (!state.alive) return;
      if (document.hidden) renderFrame();
    });

    host.style.width = px + "px";
    host.style.height = px + "px";
    renderFrame();
    if (state.spinning) tick();
    else {
      // static nice angle
      state.angle = -0.4;
      renderFrame();
    }

    const api = { setBase, setSize, dispose, get base() { return state.base; } };
    host._mceCoin3d = api;
    return api;
  }

  /**
   * Mount or update a three.js coin inside host.
   * Returns a Promise of the controller (or null if fallback used).
   */
  async function mount(host, { base, size = 88 } = {}) {
    if (!host) return null;
    const px = Math.max(40, Math.round(size));
    if (host._mceCoin3d) {
      host._mceCoin3d.setSize(px);
      await host._mceCoin3d.setBase(base);
      return host._mceCoin3d;
    }
    // Serialize concurrent mounts on the same host (mood re-paints while CDN loads)
    if (host._mceCoin3dPending) {
      await host._mceCoin3dPending;
      if (host._mceCoin3d) {
        host._mceCoin3d.setSize(px);
        await host._mceCoin3d.setBase(base);
        return host._mceCoin3d;
      }
    }
    const pending = (async () => {
      const T = await loadThree();
      if (!T || !window.WebGLRenderingContext) {
        cssFallback(host, base, px);
        return null;
      }
      if (host._mceCoin3d) return host._mceCoin3d;
      try {
        return createInstance(host, px);
      } catch (err) {
        console.warn("[coin3d] WebGL init failed", err);
        cssFallback(host, base, px);
        return null;
      }
    })();
    host._mceCoin3dPending = pending;
    let api;
    try {
      api = await pending;
    } finally {
      if (host._mceCoin3dPending === pending) host._mceCoin3dPending = null;
    }
    if (api) await api.setBase(base);
    return api;
  }

  function dispose(host) {
    if (!host) return;
    if (host._mceCoin3d) {
      try { host._mceCoin3d.dispose(); } catch (_) {}
    }
    host._mceCoin3d = null;
    host.textContent = "";
  }

  /** Sync mount helper: returns a host element ready for append; three attaches async. */
  function buildHost(base, size = 88) {
    const host = document.createElement("div");
    host.className = "coin3d-host";
    host.setAttribute("aria-hidden", "true");
    host.style.width = size + "px";
    host.style.height = size + "px";
    // optimistic 2D while three loads
    cssFallback(host, base, size);
    mount(host, { base, size }).catch(() => {});
    return host;
  }

  window.MCE = Object.assign(window.MCE || {}, {
    coin3d: { loadThree, mount, dispose, buildHost },
  });
})();
