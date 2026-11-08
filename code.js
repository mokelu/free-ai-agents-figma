// Free AI and Agents — Figma plugin port (agent suite v2, native implementation)
// Pool: OpenAI-compatible api.usefree.space/v1, free tier keyed by X-Device-Id.
//
// Tiers implemented:
//   Tier 1  Chat WITH document context (selection/page/styles/palette injected)
//   Tier 2  One-click selection agents: WCAG contrast fix, type-scale snap,
//           AI palette remap, in-place copy rewrite
//   Tier 3  Page hygiene agent: scan -> report -> approve -> batch fix
//           (semantic renames, single-child group flattening, usage stats)
//
// All writes either happen only on explicit user action in the panel, or are
// previewed first (hygiene fixes are checkbox-approved). Reads need nothing.

const POOL = "https://api.usefree.space/v1";
const SITE = "https://api.usefree.space";
const CATALOG_URL = SITE + "/api/catalog.json";
const MODEL = "mercury-2.5";
let POOL_AUTO = ""; // server-declared default model (catalog.pool.auto) — never hardcoded locally
const MAX_HISTORY = 8;
const WORK_LIMIT = 300; // cap batch loops so huge files can't hang the plugin

let DEVICE_ID = null; // set from the UI's localStorage at boot; plugin-data is only a bonus cache

function deviceId() {
  if (DEVICE_ID) return DEVICE_ID;
  try {
    const stored = figma.root.getPluginData("deviceId"); // works only once the plugin has a real ID
    if (stored) return (DEVICE_ID = stored);
  } catch (e) { /* dev manifests without ID: fall through */ }
  // Ephemeral fallback; the UI replaces this at boot from localStorage.
  DEVICE_ID = "temp-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return DEVICE_ID;
}

function setDeviceId(id) {
  DEVICE_ID = id;
  try { figma.root.setPluginData("deviceId", id); } catch (e) { /* no plugin ID yet — localStorage keeps it */ }
}

function send(msg) {
  figma.ui.postMessage(msg);
}

function sys(text) {
  send({ type: "sys", text: text });
}

/* ---------- who is sending: every pool request carries the product identity ---------- */
const APP_META = {
  app: "free-ai-agents-figma", // family convention, matches free-ai-agents-obsidian
  product: "Free AI and Agents (Figma) — Remove BG + AI Chat",
  platform: "figma",
  version: "1.0.0"
};

/* ---------- analytics metadata: enrich the identity per call ---------- */
// extra is optional { intent, tool }; turn is the 1-based conversation turn index.
// Absent fields are left out so plain-chat requests and web-only calls don't pretend otherwise.
function clientMeta(extra, turn) {
  const c = Object.assign({}, APP_META);
  if (extra && extra.intent) c.intent = extra.intent;
  if (extra && extra.tool) c.tool = extra.tool;
  if (typeof turn === "number" && turn > 0) c.turn = turn;
  return c;
}

async function poolCall(model, messages, effort, meta) {
  const post = async function (body) {
    return await fetch(POOL + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": deviceId(),
        "X-App": APP_META.app,
        "X-Platform": APP_META.platform,
        "X-Version": APP_META.version,
      },
      body: JSON.stringify(body),
    });
  };
  const body = { model: model, messages: messages, client: clientMeta(meta) };
  if (effort) body.reasoning_effort = effort; // thinking level from the catalog (instant/low/medium/high)
  let res = await post(body);
  if (!res.ok && res.status >= 400 && res.status < 500 && effort) {
    // family behavior: some models reject the reasoning_effort parameter -> retry once without it
    try {
      const et = await res.clone().text();
      if (/reasoning|unsupported|unrecognized|unknown param/i.test(et)) {
        delete body.reasoning_effort;
        res = await post(body);
      }
    } catch (e) { /* keep the original response */ }
  }
  if (res.status === 429) throw new Error("Free monthly tokens used up. See usefree.space");
  if (!res.ok) throw new Error("Pool HTTP " + res.status);
  const data = await res.json();
  // live countdown: the OpenAI-style usage object tells us exactly what this turn cost
  const usage = data && data.usage ? data.usage : null;
  const spent = usage && typeof usage.total_tokens === "number" ? usage.total_tokens
    : (typeof usage?.prompt_tokens === "number" && typeof usage?.completion_tokens === "number"
        ? usage.prompt_tokens + usage.completion_tokens : null);
  if (spent && spent > 0) send({ type: "usage", tokens: spent });
  const usedModel = data && data.model && typeof data.model === "string" ? data.model : model;
  return { text: data.choices?.[0]?.message?.content || "(empty reply)", model: usedModel };
}

/* ---------- Remove BG: via the free pool, which relays to the bg service ---------- */
// Pool path avoids CORS hassles (the bg gate only whitelists a narrow header set,
// and the plugin iframe sends product headers too). Relay also caps image size.
const BG_URL = POOL + "/remove-bg";
async function handleRmbg(msg) {
  const data = (msg && msg.data) || "";
  if (!data || data.indexOf("data:image/") !== 0) {
    return sys("Attach an image first (use the + button), then press Remove BG.");
  }
  // no sys() here: the UI already shows the live "Processing…" spinner + timer,
  // and an early sys message would clear that row immediately.
  try {
    const res = await fetch(BG_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": deviceId(),
        "X-App": APP_META.app,
        "X-Platform": APP_META.platform,
        "X-Version": APP_META.version,
      },
      body: JSON.stringify({ image: data }),
    });
    if (!res.ok) {
      let detail = "Pool HTTP " + res.status;
      try {
        const j = await res.json();
        if (j.error && j.error.message) detail = j.error.message;
      } catch (e) { /* keep default */ }
      if (res.status === 429) detail = "Free monthly tokens used up. See usefree.space";
      return sys("Background removal failed: " + detail);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const img = figma.createImage(bytes);
    const sel = figma.currentPage.selection;
    const usable = sel.find(n =>
      n.type === "RECTANGLE" || n.type === "ELLIPSE" || n.type === "FRAME" ||
      (n.fills && Array.isArray(n.fills)));
    let node;
    if (usable) {
      node = usable;
      node.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: "FILL" }];
    } else {
      const rect = figma.createRectangle();
      rect.resize(512, 640);
      rect.x = Math.round(figma.viewport.center.x - 256);
      rect.y = Math.round(figma.viewport.center.y - 320);
      rect.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: "FILL" }];
      figma.currentPage.appendChild(rect);
      figma.currentPage.selection = [rect];
      node = rect;
    }
    sys("Background removed — image inserted as “" + node.name + "”.");
  } catch (e) {
    sys("Background removal error: " + (e.message || String(e)));
  } finally {
    send({ type: "rmbg-done" });
  }
}

/* ---------- web search (real browsing via the pool, family endpoints) ---------- */
async function webCall(kind, value) {
  const res = await fetch(POOL + (kind === "read" ? "/web/read" : "/web/search"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Device-Id": deviceId() },
    body: JSON.stringify(kind === "read"
      ? { url: value, client: clientMeta({ tool: "web.read" }) }
      : { query: value, client: clientMeta({ tool: "web.search" }) }),
  });
  let j = null;
  try { j = await res.json(); } catch (e) { /* not json */ }
  if (!res.ok || !j) {
    const em = j && j.error && j.error.message ? j.error.message : "The web service is unavailable right now. Try again in a bit.";
    throw new Error(em);
  }
  if (kind === "read") {
    return { kind: kind, title: j.title || "", url: j.url || value, content: String(j.content || "").slice(0, 12000) };
  }
  const arr = (Array.isArray(j.results) ? j.results : []).slice(0, 8).map(function (x) {
    return {
      title: String(x.title || ""),
      url: String(x.url || ""),
      snippet: String(x.description || x.content || "").slice(0, 400)
    };
  });
  return { kind: kind, results: arr, left: typeof j.tokens_left === "number" ? j.tokens_left : null };
}

async function webSearchTurn(text) {
  const q = String(text || "").trim().slice(0, 300);
  let r;
  try {
    r = await webCall("search", q);
  } catch (e) {
    sys("Web search failed - " + (e.message || "unavailable") + ". Answering from my own knowledge instead.");
    return null;
  }
  const lines = r.results.map(function (x) {
    return "- [" + (x.title || x.url) + "](" + x.url + ")" + (x.snippet ? " - " + x.snippet : "");
  });
  send({ type: "tool", title: "Search the web", text: "Searched: **" + q.slice(0, 120) + "**\n\n" + (lines.join("\n") || "No results came back.") });
  return lines.join("\n"); // context fed to the model
}

let LAST_MODEL = ""; // actual model id that answered the latest pool call (shown under AI replies)
async function poolChat(messages, modelOverride, effort, meta) {
  const model = (modelOverride && modelOverride !== "auto") ? modelOverride : (POOL_AUTO || MODEL); // "auto" = whatever the server declares
  try {
    const out = await poolCall(model, messages, effort || "", meta);
    LAST_MODEL = out.model;
    return out.text;
  } catch (e) {
    if (model !== MODEL) {
      // unknown/unavailable model id -> fall back to the default instead of failing the turn
      send({ type: "sys", text: model + " wasn't available at the pool - answered with " + MODEL + " instead." });
      const out = await poolCall(MODEL, messages, effort || "", meta);
      LAST_MODEL = out.model;
      return out.text;
    }
    throw e;
  }
}

/* ---------- catalog (live model list) + quota (family endpoints) ---------- */
let CATALOG_AT = 0;
async function fetchCatalog(force) {
  const age = Date.now() - CATALOG_AT;
  if (!force && CATALOG_AT && age < 6e5) return;
  CATALOG_AT = Date.now();
  try {
    const res = await fetch(CATALOG_URL);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    const pool = j && j.pool ? j.pool : {};
    POOL_AUTO = typeof pool.auto === "string" && pool.auto ? pool.auto
      : (Array.isArray(pool.models) && pool.models[0] ? pool.models[0].id : "");
    const models = (Array.isArray(pool.models) ? pool.models : []).map(function (m) {
      const mm = m || {};
      const eff = Array.isArray(mm.effort) ? mm.effort.filter(function (x) { return typeof x === "string"; }) : [];
      return {
        id: mm.id,
        name: typeof mm.name === "string" ? mm.name : mm.id,
        effort: eff,
        effortDefault: typeof mm.effortDefault === "string" ? mm.effortDefault : "",
        discontinued: !!mm.discontinued,
        isNew: !!mm["new"]
      };
    }).filter(function (m) { return !!m.id; });
    send({ type: "catalog", models: models, auto: POOL_AUTO });
  } catch (e) {
    send({ type: "catalog", models: [] });
  }
}

async function fetchQuota() {
  try {
    const res = await fetch(POOL + "/quota/status?app=" + encodeURIComponent(APP_META.app) + "&platform=" + APP_META.platform + "&v=" + encodeURIComponent(APP_META.version), { headers: { "X-Device-Id": deviceId() } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    if (typeof j.device_tokens_left !== "number") throw new Error("no count");
    send({
      type: "quota",
      left: j.device_tokens_left,
      limit: typeof j.device_limit === "number" ? j.device_limit : null,
      reset: typeof j.device_reset_in_days === "number" ? j.device_reset_in_days : null,
    });
  } catch (e) {
    send({ type: "quota", left: null });
  }
}

/* ---------------------------------------------------------------- color */

function toRGB255(c) {
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
}
function rgbToHex(rgb) {
  return "#" + rgb.map(function (v) { return ("0" + v.toString(16)).slice(-2); }).join("").toUpperCase();
}
function hexToRgb01(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  };
}
function relLum(rgb255) {
  function f(v) {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return 0.2126 * f(rgb255[0]) + 0.7152 * f(rgb255[1]) + 0.0722 * f(rgb255[2]);
}
function contrastRatio(a, b) {
  const l1 = relLum(a), l2 = relLum(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
function setLuminance(rgb255, t) {
  // scale channels toward white (t>0) or black (t<0), preserving hue roughly
  const out = rgb255.map(function (v) {
    return t > 0 ? v + (255 - v) * t : v * (1 + t);
  });
  return out;
}
function rgbToHsl(rgb255) {
  const r = rgb255[0] / 255, g = rgb255[1] / 255, b = rgb255[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  function hue(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

function solidHex(paint) {
  if (!paint || paint.type !== "SOLID" || !paint.visible) return null;
  return rgbToHex(toRGB255(paint.color));
}
function nodeBackground(node) {
  let n = node;
  while (n) {
    if ("fills" in n && Array.isArray(n.fills)) {
      for (const p of n.fills) {
        if (p && p.type === "SOLID" && p.visible) return toRGB255(p.color);
      }
    }
    n = n.parent;
  }
  return null;
}

/* ------------------------------------------------------------ context */

const DEFAULT_NAME = /^(Frame|Rectangle|Ellipse|Vector|Group|Line|Polygon|Union|Slice|Boolean|Star|Component|Section|Table|Cell|Image)\s*\d*$/i;

function nodeLabel(n) {
  let label = n.type.toLowerCase();
  if (n.name && !DEFAULT_NAME.test(n.name)) label += " '" + n.name + "'";
  if (n.type === "TEXT" && n.characters) label += ": " + n.characters.slice(0, 40).replace(/\n/g, " ");
  const w = "width" in n ? Math.round(n.width) : null;
  const h = "height" in n ? Math.round(n.height) : null;
  if (w && h) label += " (" + w + "x" + h + ")";
  return label;
}

function pageOverview() {
  const page = figma.currentPage;
  const types = {};
  for (const child of page.children) {
    types[child.type] = (types[child.type] || 0) + 1;
  }
  const parts = Object.keys(types).map(function (t) { return types[t] + "x " + t; });
  const textStyles = figma.getLocalTextStyles().length;
  const fillStyles = figma.getLocalPaintStyles().length;
  const variables = typeof figma.variables !== "undefined" ? figma.variables.getLocalVariables().length : 0;
  return "PAGE '" + page.name + "': " + page.children.length + " top-level children (" +
    parts.join(", ") + "). Local styles: " + fillStyles + " paint, " + textStyles +
    " text; variables: " + variables + ".";
}

function selectionOverview() {
  const sel = figma.currentPage.selection;
  if (!sel.length) return "SELECTION: none (nothing selected).";
  const head = sel.slice(0, 10).map(nodeLabel);
  return "SELECTION: " + sel.length + " node(s). First: " + head.join(" | ") +
    (sel.length > 10 ? " ... (+" + (sel.length - 10) + " more)" : "");
}

function paletteOverview() {
  const seen = {};
  const nodes = figma.currentPage.findAll(function (n) { return "fills" in n; });
  for (const n of nodes.slice(0, WORK_LIMIT)) {
    try {
      const fills = n.fills;
      if (Array.isArray(fills)) {
        for (const p of fills) {
          const hex = solidHex(p);
          if (hex) seen[hex] = (seen[hex] || 0) + 1;
        }
      }
    } catch (e) { /* instance-protected */ }
  }
  const top = Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a]; }).slice(0, 8);
  return "COMMON FILLS on page: " + (top.length ? top.join(" ") : "none");
}

function contextBlock() {
  return [pageOverview(), selectionOverview(), paletteOverview()].join("\n");
}

/* ------------------------------------------------- tier 1: chat with eyes */

const history = [];
const rawTurns = [];

const SYSTEM =
  "You are Remove BG + AI Chat inside Figma. You can see a live summary of the user's " +
  "document and selection. Help the user design: critique, colors, layout, typography, " +
  "copywriting, structure. Be practical and concise. Use exact hex codes for colors.";

const CRITIQUE_PROMPT =
  "Act as a strict-but-constructive design reviewer. Given the document summary below, " +
  "critique the selected elements (or page if no selection): hierarchy, spacing rhythm, " +
  "alignment, contrast, consistency. Give max 5 concrete fixes, each one short.";

function buildPayload(text, mode, actNote) {
  let payload = (mode === "critique" ? "Review this:\n" : "") + text + "\n\n[DOCUMENT CONTEXT]\n" + contextBlock();
  if (actNote) payload += "\n\n[SYSTEM] Actions already executed on this request, report to the user plainly:\n" + actNote;
  return payload;
}

async function runTurn(payload, mode, web, model, actNote, webNote, effort, meta) {
  let sysPrompt = mode === "critique" ? SYSTEM + "\n" + CRITIQUE_PROMPT : SYSTEM;
  if (web) {
    sysPrompt += webNote
      ? "\nReal web search results for the user's request are included in [WEB SEARCH RESULTS]. Use them and cite sources inline as [title](url). Don't invent links."
      : "\nThe user enabled web search for this request, but the web service is unavailable. Say so plainly instead of inventing results.";
  }
  // full conversation context (older turns) + the current turn
  const msgs = [{ role: "system", content: sysPrompt }].concat(history.slice(0, -1));
  msgs.push({ role: "user", content: payload });
  const reply = await poolChat(msgs, model, effort, meta);
  history.push({ role: "assistant", content: reply });
  send({ type: "reply", text: reply, model: LAST_MODEL });
  fetchQuota(); // fire-and-forget: keep the header pill current after each turn
}

async function chat(text, mode, web, model, actNote, effort, meta) {
  let webNote = "";
  if (web) webNote = await webSearchTurn(text) || "";
  const base = buildPayload(text, mode, actNote);
  const payload = webNote ? base + "\n\n[WEB SEARCH RESULTS]\n" + webNote : base;
  history.push({ role: "user", content: payload });
  rawTurns.push({ text: text, mode: mode, web: !!web, model: model || "auto", actNote: actNote || "", effort: effort || "", webNote: webNote, meta: meta && (meta.intent || meta.tool) ? meta : null });
  await runTurn(payload, mode, web, model, actNote, webNote, effort, meta ? Object.assign({ turn: rawTurns.length }, meta) : null);
}

async function regen(modelOverride) {
  while (history.length && history[history.length - 1].role === "assistant") history.pop();
  const turn = rawTurns.pop();
  history.pop(); // drop the previous enriched user payload
  if (!turn) { sys("Nothing to regenerate yet."); return; }
  const payload = buildPayload(turn.text, turn.mode, turn.actNote) // rebuilt with FRESH document context
    + (turn.webNote ? "\n\n[WEB SEARCH RESULTS]\n" + turn.webNote : "");
  history.push({ role: "user", content: payload });
  rawTurns.push(turn);
  await runTurn(payload, turn.mode, turn.web, modelOverride && modelOverride !== "auto" ? modelOverride : turn.model, turn.actNote, turn.webNote, turn.effort,
    turn.meta ? Object.assign({ turn: rawTurns.length }, turn.meta) : null);
}

/* -------------------------------------------- tier 2: selection agents */

// Agent: fix text contrast on selection (WCAG AA >= 4.5:1)
function fixContrast() {
  const sel = figma.currentPage.selection;
  const texts = [];
  function walk(n) {
    if (texts.length >= WORK_LIMIT) return;
    if (n.type === "TEXT") texts.push(n);
    if ("children" in n) for (const c of n.children) walk(c);
  }
  for (const n of sel) walk(n);
  if (!texts.length) return "Fix contrast: no text nodes in selection.";

  let fixed = 0, passed = 0, skipped = 0;
  for (const n of texts) {
    try {
      const fills = n.fills;
      if (!Array.isArray(fills) || !fills.length) { skipped++; continue; }
      const textHex = solidHex(fills[0]);
      if (!textHex) { skipped++; continue; } // gradients/complex fills left alone
      const bg = nodeBackground(n);
      if (!bg) { skipped++; continue; }
      const cr = contrastRatio(toRGB255(hexToRgb01(textHex)), bg);
      if (cr >= 4.5) { passed++; continue; }

      const darkening = relLum(bg) > 0.35; // dark text on light bg -> darken more
      let rgb = toRGB255(hexToRgb01(textHex)), best = null;
      for (let i = 1; i <= 10; i++) {
        const t = darkening ? -i / 10 : i / 10;
        const cand = rgbToHsl(setLuminance(rgb, t));
        const rl = rgbToHex(hslToRgb(cand[0], cand[1], cand[2]));
        if (contrastRatio(toRGB255(hexToRgb01(rl)), bg) >= 4.5) {
          best = rl;
          break;
        }
      }
      if (!best) best = darkening ? "#000000" : "#FFFFFF";
      n.fills = [{ type: "SOLID", color: hexToRgb01(best) }];
      fixed++;
    } catch (e) { skipped++; }
  }
  return "Fix contrast: " + fixed + " repaired, " + passed + " already AA-compliant, " +
    skipped + " skipped (gradient/no background/protected).";
}

// Agent: snap font sizes to a clean scale
const SCALE = [11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80];
async function snapTypeScale() {
  const sel = figma.currentPage.selection;
  const texts = [];
  function walk(n) {
    if (texts.length >= WORK_LIMIT) return;
    if (n.type === "TEXT") texts.push(n);
    if ("children" in n) for (const c of n.children) walk(c);
  }
  for (const n of sel) walk(n);
  if (!texts.length) return "Snap type scale: no text nodes in selection.";

  const loaded = {};
  let snapped = 0, skipped = 0;
  for (const n of texts) {
    try {
      if (n.fontSize === figma.mixed || n.fontName === figma.mixed) { skipped++; continue; }
      const key = n.fontName.family + "/" + n.fontName.style;
      if (!loaded[key]) { await figma.loadFontAsync(n.fontName); loaded[key] = true; }
      const near = nearestScaleStep(n.fontSize);
      if (near !== n.fontSize) {
        n.fontSize = near;
        snapped++;
      }
    } catch (e) { skipped++; }
  }
  return "Snap type scale: " + snapped + " node(s) snapped, " + skipped + " skipped. Scale: " + SCALE.join("/");
}

function nearestScaleStep(size) {
  let best = SCALE[0], bestDiff = Math.abs(size - SCALE[0]);
  for (const s of SCALE) {
    const d = Math.abs(size - s);
    if (d < bestDiff) { bestDiff = d; best = s; }
  }
  return best;
}

// Agent: remap selection fills to an AI palette from the user's prompt
async function remapPalette(promptText) {
  const sel = figma.currentPage.selection;
  if (!sel.length) return "Remap palette: select the frames/nodes to recolor first.";
  const spec = (promptText && promptText.trim()) || "a modern, tasteful brand palette";

  const raw = await poolChat([
    { role: "system", content:
      "You generate UI color palettes. Reply ONLY with JSON like " +
      '{"palette": ["#RRGGBB", "#RRGGBB", "#RRGGBB", "#RRGGBB"]} — 4 to 8 colors: ' +
      "background(s), surface(s), primary accent, text. Palette brief: " + spec },
    { role: "user", content: "Generate the palette." },
  ]);
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/```(json)?/g, "").trim();
  }
  let palette;
  try { palette = JSON.parse(cleaned).palette; } catch (e) { throw new Error("Model did not return a palette: " + cleaned.slice(0, 120)); }
  if (!Array.isArray(palette) || palette.length < 2) throw new Error("Palette too small.");

  const palRGB = palette.filter(function (h) { return /^#[0-9a-fA-F]{6}$/.test(h); })
    .map(function (h) { return toRGB255(hexToRgb01(h.toUpperCase())); });
  if (palRGB.length < 2) throw new Error("Palette hexes invalid.");

  function nearest(c) {
    let best = palRGB[0], bestD = 1e9;
    for (const p of palRGB) {
      const d = Math.pow(p[0] - c[0], 2) + Math.pow(p[1] - c[1], 2) + Math.pow(p[2] - c[2], 2);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  function walk(n) {
    if (nLockSkip(n)) return;
    if ("fills" in n && Array.isArray(n.fills) && n.fills.length) {
      let changed = false;
      const newFills = n.fills.map(function (p) {
        if (p.type !== "SOLID" || !p.visible) return p;
        const old = toRGB255(p.color);
        const nn = nearest(old);
        if (old[0] === nn[0] && old[1] === nn[1] && old[2] === nn[2]) return p;
        changed = true;
        return { type: "SOLID", color: { r: nn[0] / 255, g: nn[1] / 255, b: nn[2] / 255 } };
      });
      if (changed) n.fills = newFills;
    }
    if ("children" in n) for (const c of n.children) walk(c);
  }
  for (const n of sel) walk(n);
  return "Remapped palette (" + palRGB.map(rgbToHex).join(" ") + ") onto selection.";
}

function nLockSkip(n) {
  try { return n.locked; } catch (e) { return true; }
}

// Agent: rewrite text in place from the user's instruction
async function rewriteText(promptText) {
  const sel = figma.currentPage.selection;
  const texts = [];
  function walk(n) {
    if (texts.length >= 12) return; // cap cost: one pool call per run
    if (n.type === "TEXT" && n.characters && n.characters.trim()) texts.push(n);
    if ("children" in n) for (const c of n.children) walk(c);
  }
  for (const n of sel) walk(n);
  if (!texts.length) return "Rewrite copy: select frames that contain text nodes.";

  const listing = texts.map(function (n, i) { return i + ": " + n.characters.replace(/\n/g, "\\n"); }).join("\n");
  const raw = await poolChat([
    { role: "system", content:
      'You rewrite UI copy. Reply ONLY with a JSON array of REWRITTEN strings, ' +
      "same count and order as the input list. Instruction: " + ((promptText && promptText.trim()) || "make it clear, compelling product copy") },
    { role: "user", content: "Text list:\n" + listing },
  ]);
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) cleaned = cleaned.replace(/```(json)?/g, "").trim();
  let arr;
  try { arr = JSON.parse(cleaned); } catch (e) { throw new Error("Model did not return a JSON array."); }
  if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error("Model returned " + (Array.isArray(arr) ? arr.length : "?") + " strings, need " + texts.length);

  const loaded = {};
  let done = 0;
  for (let i = 0; i < texts.length; i++) {
    const n = texts[i];
    try {
      if (n.fontName === figma.mixed) continue;
      const key = n.fontName.family + "/" + n.fontName.style;
      if (!loaded[key]) { await figma.loadFontAsync(n.fontName); loaded[key] = true; }
      n.characters = String(arr[i]);
      done++;
    } catch (e) { /* protected or mixed-font */ }
  }
  return "Rewrote " + done + " text node(s) per your instruction.";
}

/* -------------------------------------------- tier 3: page hygiene agent */

function scanPage() {
  const page = figma.currentPage;
  const all = page.findAll(function () { return true; });

  let unnamed = 0, singleGroups = 0, textNodes = 0;
  const fillCounts = {};
  const typeCounts = {};
  for (const n of all) {
    typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;
    if (DEFAULT_NAME.test(n.name)) unnamed++;
    if (n.type === "TEXT") textNodes++;
    if (n.type === "GROUP" && n.children && n.children.length === 1) singleGroups++;
    try {
      if ("fills" in n && Array.isArray(n.fills)) {
        for (const p of n.fills) {
          const hex = solidHex(p);
          if (hex) fillCounts[hex] = (fillCounts[hex] || 0) + 1;
        }
      }
    } catch (e) { /* protected */ }
  }

  const paletteHexes = [];
  const strayHexes = [];
  const keys = Object.keys(fillCounts).sort(function (a, b) { return fillCounts[b] - fillCounts[a]; });
  for (const k of keys) (fillCounts[k] >= 3 ? paletteHexes : strayHexes).push(k);

  const stats = all.length + " layers | " + typeCounts["TEXT"] + " text, " + (typeCounts["FRAME"] || 0) +
    " frames, " + (typeCounts["GROUP"] || 0) + " groups, " + (typeCounts["COMPONENT"] || 0) +
    " components. " + textNodes + " text nodes; " + keys.length + " distinct fill colors (" +
    paletteHexes.length + " reused 3+ times).";
  return {
    stats: stats,
    unnamed: unnamed,
    singleGroups: singleGroups,
    palette: paletteHexes.slice(0, 10),
    stray: strayHexes.slice(0, 10),
  };
}

function fixHygiene(doRename, doFlatten) {
  const page = figma.currentPage;
  let renamed = 0, flattened = 0, skipped = 0;

  if (doRename) {
    const targets = page.findAll(function (n) {
      return !n.locked && n.type !== "SLICE" && n.type !== "PAGE" && DEFAULT_NAME.test(n.name);
    }).slice(0, WORK_LIMIT);
    for (const n of targets) {
      let name = null;
      if (n.type === "TEXT" && n.characters) name = "text " + n.characters.trim().slice(0, 24).replace(/\s+/g, "-").toLowerCase();
      else if (n.type === "FRAME" || n.type === "SECTION") name = "section-" + (n.name.match(/\d+/) || [""])[0];
      else if (n.type === "RECTANGLE") name = "rect";
      else if (n.type === "ELLIPSE") name = "circle";
      else if (n.type === "VECTOR") name = "vector";
      else if (n.type === "LINE") name = "line";
      else if (n.type === "IMAGE") name = "img";
      if (!name) name = n.type.toLowerCase();
      // make unique-ish with positional suffix
      const idx = renamed + 1;
      try {
        n.name = name + "-" + idx;
        renamed++;
      } catch (e) { skipped++; }
    }
  }

  if (doFlatten) {
    let guard = 0;
    while (guard++ < 50) {
      const singles = page.findAll(function (n) {
        return n.type === "GROUP" && !n.locked && n.children &&
          n.children.length === 1 && !n.children[0].locked;
      });
      if (!singles.length) break;
      for (const g of singles.slice(0, 100)) {
        try {
          const parent = g.parent;
          const child = g.children[0];
          if (!parent || !child) continue;
          const at = parent.children.indexOf(g);
          parent.insertChild(at < 0 ? parent.children.length : at, child);
          g.remove();
          flattened++;
        } catch (e) { skipped++; }
      }
    }
  }

  return "Hygiene fixes applied: " + renamed + " layer(s) renamed, " + flattened +
    " wrapper group(s) flattened, " + skipped + " skipped (locked/protected).";
}

/* ---------------------------------------------------------- dispatcher */

const MIN_UI = { width: 208, height: 48 };   // collapsed title strip
const FULL_UI = { width: 320, height: 620 }; // expanded panel

figma.showUI(__html__, FULL_UI); // slim float — Figma has no docking API for design-mode plugins
send({ type: "sys", text: "Remove BG + AI Chat loaded." });

figma.ui.onmessage = async function (msg) {
  try {
    if (msg.type === "boot") {
      // UI owns IDs/sessions; durable storage = clientStorage (localStorage is sealed in the iframe).
      // clientStorage is keyed by plugin identity, which a dev manifest can lack -> second channel:
      // shared plugin data on the document (root), which works even without a plugin ID.
      let did = msg.deviceId || null;
      try {
        const stored = await figma.clientStorage.getAsync("faa-device");
        if (stored) did = stored;
      } catch (e) { /* clientStorage unavailable */ }
      if (!did) {
        try { did = figma.root.getSharedPluginData("faa", "device") || did; } catch (e) { /* no ID */ }
      }
      if (did) {
        setDeviceId(did);
        try { await figma.clientStorage.setAsync("faa-device", did); } catch (e) {}
        try { figma.root.setSharedPluginData("faa", "device", did); } catch (e) { /* no ID */ }
      }
      let list = [];
      try {
        const raw = await figma.clientStorage.getAsync("faa-sessions");
        if (raw) list = JSON.parse(raw) || [];
      } catch (e) { /* clientStorage unavailable */ }
      if (!list.length) {
        try { list = JSON.parse(figma.root.getSharedPluginData("faa", "sessions") || "[]") || []; } catch (e) { /* no ID */ }
      }
      send({ type: "sess-set", list: list });
      fetchCatalog(); // live model list from the pool's catalog — never hardcoded
      fetchQuota();
      if (msg.minimized) {
        figma.ui.resize(MIN_UI.width, MIN_UI.height);
        send({ type: "ui-state", minimized: true });
      }
      return;
    }
    if (msg.type === "sess-set") {
      // prune before persisting so the payload stays small for shared plugin data
      const kept = (msg.list || []).slice(-20).map(function (s) {
        return { id: s.id, title: s.title, ts: s.ts, turns: (s.turns || []).slice(-60).map(function (t) {
          return { who: t.who, text: String(t.text || "").slice(0, 800) };
        }) };
      });
      const raw = JSON.stringify(kept);
      try { await figma.clientStorage.setAsync("faa-sessions", raw); } catch (e) { /* storage unavailable */ }
      try { figma.root.setSharedPluginData("faa", "sessions", raw); } catch (e) { /* no ID */ }
      return;
    }
    if (msg.type === "device-id") {
      setDeviceId(msg.value);
      try { await figma.clientStorage.setAsync("faa-device", msg.value); } catch (e) {}
      try { figma.root.setSharedPluginData("faa", "device", msg.value); } catch (e) { /* no ID */ }
      return;
    }
    if (msg.type === "ui-min") {
      figma.ui.resize(msg.value ? MIN_UI.width : FULL_UI.width, msg.value ? MIN_UI.height : FULL_UI.height);
      send({ type: "ui-state", minimized: !!msg.value });
      return;
    }
    if (msg.type === "chat") {
      // Chat is the agent front door: common design asks run their real action first,
      // then the model comments on the result. No jargon menus needed.
      const t = (msg.text || "").toLowerCase();
      const effort = typeof msg.effort === "string" ? msg.effort : "";
      let actNote = "";
      let actTitle = "";
      // analytics labels: which intent claimed this message (runs even on retry, so retries keep their tool)
      let hit = null;
      if (/contrast|wcag|readab/.test(t)) hit = "contrast";
      else if (/type ?scale|font sizes|snap (type|fonts|sizes)/.test(t)) hit = "scale";
      else if (/rewrit|reword|rephrase|copywriting|better copy/.test(t)) hit = "rewrite";
      else if (/recolor|re-?color|palette|color scheme/.test(t)) hit = "palette";
      else if (/scan|audit|hygiene|clean ?up|rename|untitled|fix (my )?(layers|file)/.test(t)) hit = "scan";
      let intent = null, tool = null;
      if (hit === "contrast") { intent = "fixContrast"; tool = "figma.fixContrast"; }
      else if (hit === "scale") { intent = "snapTypeScale"; tool = "figma.snapTypeScale"; }
      else if (hit === "rewrite") { intent = "rewriteText"; tool = "figma.rewriteText"; }
      else if (hit === "palette") { intent = "remapPalette"; tool = "figma.remapPalette"; }
      else if (hit === "scan") { intent = "pageScan"; tool = /rename|clean|fix|flatten/.test(t) ? "figma.fixHygiene" : "figma.scanPage"; }
      if (!msg.retry) {
        if (hit === "contrast") {
          actNote = fixContrast();
          actTitle = "Fix contrast";
        } else if (hit === "scale") {
          actNote = await snapTypeScale();
          actTitle = "Snap type scale";
        } else if (hit === "rewrite") {
          actNote = await rewriteText(msg.text);
          actTitle = "Rewrite copy";
        } else if (hit === "palette") {
          actNote = await remapPalette(msg.text);
          actTitle = "Remap palette";
        } else if (hit === "scan") {
          const r = scanPage();
          actNote = "Scan: " + r.stats;
          if (/rename|clean|fix|flatten/.test(t)) actNote += "\n" + fixHygiene(true, true);
          actTitle = "Page scan";
          send({ type: "hygiene", stats: r.stats, unnamed: r.unnamed,
                 singleGroups: r.singleGroups, palette: r.palette, stray: r.stray });
        }
        if (actTitle && actNote) send({ type: "tool", title: actTitle, text: actNote });
      }
      await chat(msg.text, msg.mode, msg.web, msg.model, actNote, effort, intent ? { intent: intent, tool: tool } : null);
    } else if (msg.type === "regen") {
      await regen(msg.model);
    } else if (msg.type === "clear") {
      history.length = 0;
      rawTurns.length = 0;
      sys("Conversation cleared.");
    } else if (msg.type === "catalog-req") {
      fetchCatalog(true);
    } else if (msg.type === "image") {
      sys("Image attached (" + msg.kb + " KB). Press the Remove BG button to cut out the background.");
    } else if (msg.type === "rmbg") {
      await handleRmbg(msg);
    } else if (msg.type === "action") {
      let result, title = "";
      if (msg.name === "contrast") { result = fixContrast(); title = "Fix contrast"; }
      else if (msg.name === "scale") { result = await snapTypeScale(); title = "Snap type scale"; }
      else if (msg.name === "palette") { result = await remapPalette(msg.text); title = "Remap palette"; }
      else if (msg.name === "rewrite") { result = await rewriteText(msg.text); title = "Rewrite copy"; }
      else result = "Unknown action.";
      send({ type: "tool", title: title, text: result });
    } else if (msg.type === "scan") {
      const report = scanPage();
      send({ type: "hygiene", stats: report.stats, unnamed: report.unnamed,
             singleGroups: report.singleGroups, palette: report.palette, stray: report.stray });
    } else if (msg.type === "fixes") {
      sys(fixHygiene(msg.rename, msg.flatten));
    }
  } catch (e) {
    sys("Error: " + (e.message || String(e)));
  }
};
