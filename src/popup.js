const api = globalThis.browser ?? globalThis.chrome;

const $ = (id) => document.getElementById(id);

let tasteGuardado = "";

function pintar(c) {
  $("key").value = c.apiKey || "";
  $("taste").value = c.taste || "";
  tasteGuardado = c.taste || "";
  $("threshold").value = String(c.threshold ?? 0.45);
  $("enabled").checked = !!c.enabled;
  $("hideShorts").checked = !!c.hideShorts;
  $("hideThumbs").checked = !!c.hideThumbs;
  $("hideAvatars").checked = !!c.hideAvatars;
  $("showScore").checked = !!c.showScore;
}

function datos() {
  const t = parseFloat(String($("threshold").value).replace(",", "."));
  return {
    apiKey: $("key").value.trim(),
    taste: $("taste").value,
    threshold: Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0.45,
    enabled: $("enabled").checked,
    hideShorts: $("hideShorts").checked,
    hideThumbs: $("hideThumbs").checked,
    hideAvatars: $("hideAvatars").checked,
    showScore: $("showScore").checked,
  };
}

function estado(msg, kind) {
  const el = $("status");
  el.textContent = msg || "";
  el.className = "status" + (kind ? " " + kind : "");
}

async function cargarStats() {
  const s = await api.runtime.sendMessage({ type: "stats" });
  if (!s || s.error) return;
  const cost = (s.cost || 0).toFixed(4);
  $("stats").textContent = `${s.hidden} ocultos · ${s.kept} pasan · ${s.calls} llamadas · $${cost}`;
}

async function init() {
  const c = await api.runtime.sendMessage({ type: "config" });
  if (c && !c.error) pintar(c);
  cargarStats();
}

$("save").addEventListener("click", async () => {
  const patch = datos();
  if (!patch.apiKey) {
    estado("falta la api key", "err");
    return;
  }
  const r = await api.runtime.sendMessage({ type: "patch", patch });
  if (r && r.error) {
    estado(r.error, "err");
    return;
  }
  pintar(r);
  estado("guardado", "ok");
  setTimeout(() => estado(""), 1800);
});

// la key se guarda sola al salir del campo: no depende de acordarse de "guardar"
$("key").addEventListener("change", async () => {
  const apiKey = $("key").value.trim();
  if (!apiKey) return;
  const r = await api.runtime.sendMessage({ type: "patch", patch: { apiKey } });
  if (r && r.error) estado(r.error, "err");
  else estado("key guardada", "ok");
});

// el taste se guarda solo: al salir del campo y, si cierras el popup de golpe,
// con un pequeño retraso mientras escribes.
let guardarTaste = null;

async function guardarTasteAhora() {
  clearTimeout(guardarTaste);
  guardarTaste = null;
  const taste = $("taste").value;
  if (taste === tasteGuardado) return;
  const r = await api.runtime.sendMessage({ type: "patch", patch: { taste } });
  if (r && r.error) return estado(r.error, "err");
  tasteGuardado = taste;
  estado("gustos guardados", "ok");
}

$("taste").addEventListener("input", () => {
  clearTimeout(guardarTaste);
  guardarTaste = setTimeout(guardarTasteAhora, 1200);
});

$("taste").addEventListener("change", guardarTasteAhora);

$("test").addEventListener("click", async () => {
  estado("preguntando a jev…");
  const r = await api.runtime.sendMessage({ type: "test" });
  if (!r || !r.ok) {
    estado("error: " + ((r && r.error) || "sin respuesta"), "err");
    return;
  }
  const pct = r.score === null ? "?" : Math.round(r.score * 100) + "%";
  estado(
    `ok · ${r.model} · encaje ${pct} · ${r.tokens} tok · $${(r.cost || 0).toFixed(6)} · ${r.ms}ms`,
    "ok"
  );
});

$("opts").addEventListener("click", () => {
  api.runtime.openOptionsPage();
});

init();
