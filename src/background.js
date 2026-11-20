const api = globalThis.browser ?? globalThis.chrome;

// jev no va por /chat/completions, tiene su propio endpoint de decisiones
const OR_URL = "https://openrouter.ai/api/alpha/decisions";
const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "typesafe/jev-1.14";
const STEER_MODEL = "openai/gpt-6-luna";
const PARALLEL = 2;
const MAX_LOG = 50;
const MAX_FEEDBACK = 200;
// sube esto cuando cambie lo que se manda a jev (título, canal, prompt):
// invalida la caché vieja para no reutilizar decisiones tomadas con datos malos
const CACHE_VERSION = 2;

const LEVELS = [
  "no tiene nada que ver con lo que le interesa, o es justo lo que ha dicho que no quiere",
  "roza alguno de sus temas pero no es lo que busca",
  "encaja con sus gustos y probablemente le rente",
  "es exactamente el tipo de video que quiere que le salga",
];

const DEFAULTS = {
  enabled: true,
  apiKey: "",
  model: MODEL,
  taste: "",
  threshold: 0.45,
  hideShorts: true,
  hideThumbs: true,
  hideAvatars: true,
  showScore: true,
  thumbQuality: "hqdefault",
  allow: [],
  deny: [],
  budgetPerHour: 400,
  maxPerLoad: 20,
  steerModel: STEER_MODEL,
};

// ---------- storage ----------

async function cfg() {
  const s = await api.storage.local.get("cfg");
  return { ...DEFAULTS, ...(s.cfg || {}) };
}

async function patchCfg(patch) {
  const prev = await cfg();
  const next = { ...prev, ...patch };
  await api.storage.local.set({ cfg: next });

  // si cambia el criterio, la cache vieja ya no vale
  if (
    prev.taste !== next.taste ||
    prev.thumbQuality !== next.thumbQuality ||
    prev.model !== next.model
  ) {
    await clearCache();
  }
  return next;
}

async function bump(delta) {
  const s = await api.storage.local.get("stats");
  const st = { hidden: 0, kept: 0, calls: 0, cost: 0, ...(s.stats || {}) };
  st.hidden += delta.hidden || 0;
  st.kept += delta.kept || 0;
  st.calls += delta.calls || 0;
  st.cost += delta.cost || 0;
  await api.storage.local.set({ stats: st });
  return st;
}

async function budgetOk(limit) {
  const now = Math.floor(Date.now() / 3600000);
  const s = await api.storage.local.get("budget");
  const b = s.budget && s.budget.h === now ? s.budget : { h: now, n: 0 };
  if (b.n >= limit) return false;
  b.n += 1;
  await api.storage.local.set({ budget: b });
  return true;
}

// ---------- tope por carga de pagina ----------

// el contador no puede vivir solo en memoria: el service worker se suspende y,
// al volver a arrancar, permitiria otra tanda de llamadas. storage.session
// aguanta la suspension; si el navegador no la tiene, se usa storage.local.
const store = api.storage.session || api.storage.local;

// ventana global de seguridad: aunque haya dos pestanas o el worker se reinicie,
// no se pueden disparar mas de maxPerLoad llamadas por minuto en total.
const VENTANA_MS = 60000;

// las lecturas y escrituras del contador se encadenan para que dos tarjetas no
// reserven el mismo hueco a la vez.
let cola = Promise.resolve();

function enSerie(fn) {
  const t = cola.then(fn, fn);
  cola = t.catch(() => {});
  return t;
}

function claveCarga(cargaId) {
  return `carga:${String(cargaId || "suelta")}`;
}

async function reservar(cargaId, tope) {
  return enSerie(async () => {
    const now = Date.now();
    const k = claveCarga(cargaId);
    const s = await store.get([k, "cargaGlobal"]);
    const c = s[k] || { n: 0, t: now };
    let g = s.cargaGlobal;
    if (!g || now - g.t > VENTANA_MS) g = { n: 0, t: now };

    if (c.n >= tope || g.n >= tope) return false;

    c.n += 1;
    c.t = now;
    g.n += 1;
    await store.set({ [k]: c, cargaGlobal: g });
    return true;
  });
}

async function devolver(cargaId) {
  return enSerie(async () => {
    const k = claveCarga(cargaId);
    const s = await store.get([k, "cargaGlobal"]);
    const c = s[k];
    if (c && c.n > 0) {
      c.n -= 1;
      await store.set({ [k]: c });
    }
    const g = s.cargaGlobal;
    if (g && g.n > 0) {
      g.n -= 1;
      await store.set({ cargaGlobal: g });
    }
  });
}

async function estadoCarga(cargaId, tope) {
  return enSerie(async () => {
    const k = claveCarga(cargaId);
    const s = await store.get(k);
    const c = s[k];
    return { n: c ? c.n : 0, tope: Math.max(1, Number(tope) || 20) };
  });
}

// ---------- helpers ----------

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function rev(s) {
  let h = 5381;
  const t = String(s || "");
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function tasteKey(c) {
  return rev(`${c.taste || ""}|v${CACHE_VERSION}`);
}

function instrucciones(taste) {
  return [
    "eres el filtro personal de una sola persona para su feed de youtube.",
    "te doy el titulo, el canal y la miniatura. la miniatura casi siempre lleva texto encima: leelo, muchas veces dice mas que el titulo.",
    "no valores si el video esta bien hecho ni si es popular. valora solo si encaja con esta persona.",
    "",
    "sus gustos, tal cual los escribio:",
    String(taste || "").trim() ||
      "no ha escrito nada; tira de lo basico: cosas utiles o interesantes antes que ruido.",
    "",
    "si el titulo o el texto de la miniatura promete algo que no esta en esa lista, bajalo aunque el tema se parezca.",
    "si dudas, tira a la baja: mejor que se te escape un video bueno que colarle basura.",
  ].join("\n");
}

function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

// la miniatura se pide desde aqui para no pelearse con cors ni con el page
async function miniatura(videoId, calidad) {
  const intentos = calidad === "hq720" ? ["hq720", "hqdefault"] : ["hqdefault"];
  for (const q of intentos) {
    try {
      const r = await fetch(`https://i.ytimg.com/vi/${videoId}/${q}.jpg`, { cache: "force-cache" });
      if (!r.ok) continue;
      const b = await r.arrayBuffer();
      if (b.byteLength < 1000) continue;
      return `data:image/jpeg;base64,${toB64(b)}`;
    } catch {
      // siguiente
    }
  }
  return null;
}

// ---------- la llamada a jev ----------

function preguntas(taste) {
  return {
    encaje: {
      type: "score",
      instructions: instrucciones(taste),
      criteria: LEVELS,
    },
    short: {
      type: "noul",
      instructions:
        "el video es un short vertical, o un clip de menos de un minuto pensado para scroll",
    },
  };
}

async function llamarJev(c, video, conImagen) {
  const state = [`titulo: ${video.title}`];
  if (video.channel) state.push(`canal: ${video.channel}`);

  if (conImagen) {
    const img = await miniatura(video.id, c.thumbQuality);
    if (img) state.push({ type: "image_url", image_url: { url: img } });
  }

  const body = {
    model: c.model || MODEL,
    state,
    questions: preguntas(c.taste),
  };

  const t0 = Date.now();
  const r = await fetch(OR_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "jev youtube",
    },
    body: JSON.stringify(body),
  });

  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || `http ${r.status}`;
    throw new Error(msg);
  }

  const a = data.answers || {};
  const enc = a.encaje || {};
  const top = LEVELS.length - 1;
  const score = typeof enc.score === "number" ? enc.score / top : null;

  return {
    score,
    confidence: typeof enc.confidence === "number" ? enc.confidence : 0,
    short: typeof a.short?.noul === "number" ? a.short.noul : 0,
    cost: (data.usage && data.usage.cost) || 0,
    tokens: (data.usage && data.usage.input_tokens) || 0,
    ms: Date.now() - t0,
  };
}

// ---------- cola ----------

let enVuelo = 0;
const esperando = [];

function hueco() {
  if (enVuelo < PARALLEL) {
    enVuelo += 1;
    return Promise.resolve();
  }
  return new Promise((res) => esperando.push(res));
}

function suelta() {
  const next = esperando.shift();
  if (next) next();
  else enVuelo -= 1;
}

// ---------- decision ----------

async function decide(video, force, cargaId) {
  if (!video || !video.id) return { state: "error", why: "video raro" };

  // sin título no hay nada que puntuar: mandar "?" a jev es tirar dinero y
  // envenenar la caché. se oculta y se registra para poder verlo.
  if (!String(video.title || "").trim()) {
    return { state: "hide", why: "sin título", score: null };
  }

  const c = await cfg();
  if (!c.enabled) return { state: "off" };

  const ch = norm(video.channel);
  if (ch && c.allow.some((x) => norm(x) === ch)) {
    return { state: "keep", why: "canal permitido", score: null };
  }
  if (ch && c.deny.some((x) => norm(x) === ch)) {
    return { state: "hide", why: "canal vetado", score: null };
  }

  if (video.kind === "short" && c.hideShorts) {
    return { state: "hide", why: "short", score: null };
  }

  const ovKey = `ov:${video.id}`;
  const ov = (await api.storage.local.get(ovKey))[ovKey];
  if (!force && ov === "show") return { state: "keep", why: "a mano", score: null };
  if (!force && ov === "hide") return { state: "hide", why: "a mano", score: null };

  const cacheKey = `v:${video.id}`;
  const hit = (await api.storage.local.get(cacheKey))[cacheKey];
  const sameTaste = hit && hit.r === tasteKey(c) && hit.q === (c.thumbQuality || "hqdefault");
  if (!force && sameTaste) {
    return {
      state: hit.h ? "hide" : "keep",
      why: "cache",
      score: hit.s,
      confidence: hit.c,
      cached: true,
    };
  }

  if (!c.apiKey) return { state: "error", why: "falta la api key" };

  // el tope se reserva antes de gastar; si luego falla el presupuesto, se devuelve
  const tope = Math.max(1, Number(c.maxPerLoad) || 20);
  if (!force && !(await reservar(cargaId, tope))) {
    return { state: "skip", why: "tope por recarga", score: null };
  }
  if (!(await budgetOk(c.budgetPerHour))) {
    if (!force) await devolver(cargaId);
    return { state: "skip", why: "presupuesto agotado", score: null };
  }

  await hueco();
  try {
    const res = await llamarJev(c, video, true);
    const hide =
      (res.score !== null && res.score < c.threshold) ||
      (c.hideShorts && res.short > 0.65);

    await api.storage.local.set({
      [cacheKey]: { h: hide ? 1 : 0, s: res.score, c: res.confidence, r: tasteKey(c), q: c.thumbQuality, t: Date.now() },
    });

    await bump({ hidden: hide ? 1 : 0, kept: hide ? 0 : 1, calls: 1, cost: res.cost });

    return {
      state: hide ? "hide" : "keep",
      why: "jev",
      score: res.score,
      confidence: res.confidence,
      short: res.short,
      cost: res.cost,
      ms: res.ms,
    };
  } catch (e) {
    return { state: "error", why: String(e.message || e) };
  } finally {
    suelta();
  }
}

async function override(id, action) {
  const key = `ov:${id}`;
  if (action === "reset") {
    await api.storage.local.remove([key, `v:${id}`]);
    return { ok: true };
  }
  if (action === "reclassify") {
    await api.storage.local.remove(key);
    return { ok: true, force: true };
  }
  await api.storage.local.set({ [key]: action });
  return { ok: true };
}

async function testCall() {
  const c = await cfg();
  if (!c.apiKey) return { ok: false, error: "falta la api key" };
  const t0 = Date.now();
  try {
    const r = await fetch(OR_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: c.model || MODEL,
        state: "titulo: como se hace pan de masa madre en casa\ncanal: cocina de barrio",
        questions: preguntas(c.taste),
      }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      return { ok: false, error: (data && data.error && data.error.message) || `http ${r.status}` };
    }
    const enc = data.answers?.encaje || {};
    return {
      ok: true,
      model: data.model,
      provider: data.provider,
      score: typeof enc.score === "number" ? enc.score / (LEVELS.length - 1) : null,
      cost: data.usage?.cost ?? 0,
      tokens: data.usage?.input_tokens ?? 0,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function clearCache() {
  const all = await api.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("v:") || k.startsWith("ov:"));
  if (keys.length) await api.storage.local.remove(keys);
  return { ok: true, removed: keys.length };
}

// ---------- historial de decisiones ----------

// el historial se escribe desde varias tarjetas a la vez: una cola propia evita
// que dos lecturas-modificaciones-escrituras se pisen y se pierdan entradas.
let colaLog = Promise.resolve();

function enSerieLog(fn) {
  const t = colaLog.then(fn, fn);
  colaLog = t.catch(() => {});
  return t;
}

async function logDecision(video, res) {
  if (!video || !video.id) return;
  if (res.state !== "keep" && res.state !== "hide") return;
  return enSerieLog(async () => {
    const s = await api.storage.local.get(["decisions", "feedback"]);
    const fb = s.feedback || {};
    const list = Array.isArray(s.decisions) ? s.decisions : [];
    const prev = list.find((x) => x.id === video.id);
    const entry = {
      id: video.id,
      title: video.title || "",
      channel: video.channel || "",
      state: res.state,
      why: res.why || "",
      score: typeof res.score === "number" ? res.score : null,
      ts: Date.now(),
      fb: fb[video.id] || (prev && prev.fb) || null,
    };
    // mismo vídeo repetido en varias recargas: se mueve arriba en vez de duplicarse
    const rest = list.filter((x) => x.id !== video.id);
    rest.unshift(entry);
    await api.storage.local.set({ decisions: rest.slice(0, MAX_LOG) });
  });
}

async function setFeedback(id, fb) {
  if (!id) return { error: "falta el id del vídeo" };
  const val = fb === "good" || fb === "bad" ? fb : null;
  return enSerieLog(async () => {
    const s = await api.storage.local.get(["decisions", "feedback"]);
    const map = s.feedback || {};
    const list = Array.isArray(s.decisions) ? s.decisions : [];
    const d = list.find((x) => x.id === id) || {};

    if (val) {
      map[id] = {
        id,
        fb: val,
        title: d.title || "",
        channel: d.channel || "",
        state: d.state || "",
        why: d.why || "",
        score: typeof d.score === "number" ? d.score : null,
        ts: Date.now(),
      };
      // el mapa de feedback no rota con el historial, pero tampoco crece sin fin
      const ids = Object.keys(map);
      if (ids.length > MAX_FEEDBACK) {
        ids
          .sort((a, b) => (map[a].ts || 0) - (map[b].ts || 0))
          .slice(0, ids.length - MAX_FEEDBACK)
          .forEach((k) => delete map[k]);
      }
    } else {
      delete map[id];
    }

    const next = list.map((x) => (x.id === id ? { ...x, fb: val } : x));
    await api.storage.local.set({ feedback: map, decisions: next });
    return { ok: true, fb: val };
  });
}

async function listDecisions() {
  const s = await api.storage.local.get(["decisions", "feedback"]);
  const map = s.feedback || {};
  const list = (Array.isArray(s.decisions) ? s.decisions : []).map((x) => ({
    ...x,
    fb: map[x.id] ? map[x.id].fb : x.fb || null,
  }));
  const counts = { good: 0, bad: 0 };
  for (const v of Object.values(map)) {
    if (v.fb === "good") counts.good += 1;
    else if (v.fb === "bad") counts.bad += 1;
  }
  return { decisions: list, counts };
}

// ---------- steer taste ----------

const STEER_SYSTEM = [
  "eres el editor del perfil de gustos de una persona para su feed de youtube.",
  "recibes su texto de gustos actual y dos grupos de decisiones que ha marcado como falladas.",
  "la direccion de cada grupo manda y es opuesta: unos son videos que el filtro oculto y el queria ver (le interesan); otros son videos que el filtro dejo pasar y el no queria (le sobran).",
  "",
  "reglas de salida:",
  "- devuelve SOLO el texto de gustos nuevo: en español, en prosa, sin markdown, comillas ni titulos.",
  "- no pierdas contexto: todo lo que dice el texto actual tiene que seguir estando en la salida. no resumas, no reordenes y no lo diluyas en generalidades.",
  "- puedes retocar o ampliar una frase concreta cuando una decision fallada la complemente o la matice. lo que no puedes es borrar ideas, ni cambiar el texto por una version mas vaga o mas corta.",
  "- si una decision fallada choca con una frase concreta, ajusta esa frase; si solo añade matiz, ampliala.",
  "- añade lo que se deduzca de los dos grupos, integrado en la prosa donde corresponda.",
  "- generaliza: agrupa los casos y di que patron comparten (tipo de contenido, formato, tono, profundidad, intencion). nunca listes temas concretos, generos sueltos ni ejemplos sacados de los titulos.",
  "- no inventes gustos que no se deduzcan del texto actual o de las decisiones.",
  "- no menciones los grupos, ni titulos, canales, encajes ni que has reescrito nada.",
].join("\n");

function lineaFeedback(x) {
  const partes = [x.title || "(sin título)"];
  if (x.channel) partes.push(x.channel);
  if (typeof x.score === "number") partes.push(`encaje ${Math.round(x.score * 100)}%`);
  return "- " + partes.join(" · ");
}

function bloqueFeedback(titulo, lista) {
  if (!lista.length) return `${titulo}\n(ninguno)`;
  return `${titulo}\n${lista.map(lineaFeedback).join("\n")}`;
}

async function steerTaste(note) {
  const c = await cfg();
  if (!c.apiKey) return { error: "falta la api key" };

  const s = await api.storage.local.get("feedback");
  const map = s.feedback || {};

  // solo las falladas. las acertadas no aportan nada al texto: es ruido.
  const falladas = Object.values(map)
    .filter((x) => x.fb === "bad")
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 80);

  if (!falladas.length) return { error: "no hay ninguna decisión marcada como fallada" };

  // el sentido depende de lo que hizo el filtro, no de que la decisión sea fallo:
  // ocultó + fallo = lo quería ver; dejó pasar + fallo = no lo quería
  const quería = falladas.filter((x) => x.state === "hide");
  const sobraba = falladas.filter((x) => x.state !== "hide");
  const previo = String(c.taste || "").trim();

  const user = [
    "texto de gustos actual (ninguna idea de aquí puede desaparecer de la salida):",
    '"""',
    previo || "(vacío)",
    '"""',
    "",
    bloqueFeedback(
      "el filtro los ocultó y él marcó fallo, o sea que QUERÍA verlos; este tipo de vídeo le interesa:",
      quería
    ),
    "",
    bloqueFeedback(
      "el filtro los dejó pasar y él marcó fallo, o sea que NO los quería; este tipo de vídeo le sobra:",
      sobraba
    ),
    note ? `\nmatiz que quiere añadir a mano: ${String(note).trim()}` : "",
    "",
    "parte del texto actual y trabaja sobre él: amplía o retoca las frases que haga falta, pero no dejes fuera nada de lo que ya decía.",
  ].join("\n");

  const t0 = Date.now();
  let cost = 0;
  let data = null;

  async function pedir(messages) {
    const r = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "jev youtube",
      },
      body: JSON.stringify({
        model: c.steerModel || STEER_MODEL,
        temperature: 0.4,
        messages,
      }),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = (d && d.error && d.error.message) || `http ${r.status}`;
      throw new Error(msg);
    }
    cost += (d && d.usage && d.usage.cost) || 0;
    data = d;
    return limpiar(d?.choices?.[0]?.message?.content);
  }

  // algunos modelos envuelven la respuesta en comillas o en un bloque de código
  function limpiar(raw) {
    let t = String(raw || "").trim();
    t = t.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
    if (
      (t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("«") && t.endsWith("»"))
    ) {
      t = t.slice(1, -1).trim();
    }
    return t;
  }

  let texto;
  try {
    const messages = [
      { role: "system", content: STEER_SYSTEM },
      { role: "user", content: user },
    ];
    texto = await pedir(messages);

    // red de seguridad: si se ha dejado contexto por el camino, se le devuelve el
    // suyo y se le pide que lo recupere. sin esto, un modelo vago te borra los
    // gustos y no hay forma de recuperarlos.
    if (previo && texto.length < previo.length * 0.75) {
      const segundo = await pedir([
        ...messages,
        { role: "assistant", content: texto },
        {
          role: "user",
          content:
            "te has dejado contexto del texto actual. repite el texto de gustos conservando todo lo que ya decía y manteniendo los matices nuevos.",
        },
      ]);
      if (segundo.length > texto.length) texto = segundo;
    }
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }

  if (!texto) return { error: "el modelo devolvió vacío" };

  await patchCfg({ taste: texto });

  await bump({ cost });

  return {
    ok: true,
    taste: texto,
    before: c.taste || "",
    used: falladas.length,
    model: data?.model || c.steerModel || STEER_MODEL,
    cost,
    ms: Date.now() - t0,
  };
}


// ---------- mensajes ----------

async function handle(msg) {
  switch (msg && msg.type) {
    case "decide": {
      const r = await decide(msg.video, !!msg.force, msg.cargaId);
      await logDecision(msg.video, r).catch(() => {});
      const c = await cfg();
      r.carga = await estadoCarga(msg.cargaId, c.maxPerLoad);
      return r;
    }
    case "override":
      return override(msg.id, msg.action);
    case "decisions":
      return listDecisions();
    case "feedback":
      return setFeedback(msg.id, msg.fb);
    case "steerTaste":
      return steerTaste(msg.note);
    case "config":
      return cfg();
    case "patch":
      return patchCfg(msg.patch || {});
    case "test":
      return testCall();
    case "clear":
      return clearCache();
    case "stats": {
      const s = await api.storage.local.get("stats");
      return s.stats || { hidden: 0, kept: 0, calls: 0, cost: 0 };
    }
    case "resetStats": {
      await api.storage.local.set({ stats: { hidden: 0, kept: 0, calls: 0, cost: 0 } });
      return { ok: true };
    }
    default:
      return { error: "no se que hacer con " + (msg && msg.type) };
  }
}

api.runtime.onMessage.addListener((msg, _sender, reply) => {
  handle(msg).then(
    (r) => reply(r),
    (e) => reply({ error: String((e && e.message) || e) })
  );
  return true;
});

api.runtime.onInstalled.addListener(async () => {
  // solo rellena lo que falte, sin pisar lo que ya haya guardado el usuario
  const s = await api.storage.local.get("cfg");
  const guardado = s.cfg || {};
  const faltan = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (guardado[k] === undefined) faltan[k] = v;
  }
  if (Object.keys(faltan).length) {
    await api.storage.local.set({ cfg: { ...faltan, ...guardado } });
  }
});
