const api = globalThis.browser ?? globalThis.chrome;

const $ = (id) => document.getElementById(id);

let cfg = {
  allow: [],
  deny: [],
  thumbQuality: "hqdefault",
  budgetPerHour: 400,
  maxPerLoad: 20,
  steerModel: "openai/gpt-6-luna",
};

let decisiones = [];

function estado(msg, kind) {
  const el = $("status");
  el.textContent = msg || "";
  el.className = "status" + (kind ? " " + kind : "");
  if (msg) setTimeout(() => { if (el.textContent === msg) estado(""); }, 2500);
}

function lista(contId, arr, onQuitar) {
  const cont = $(contId);
  cont.textContent = "";
  if (!arr.length) {
    const p = document.createElement("div");
    p.className = "hint";
    p.textContent = "ninguno todavía";
    cont.appendChild(p);
    return;
  }
  arr.forEach((nombre, i) => {
    const row = document.createElement("div");
    row.className = "item";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = nombre;
    inp.addEventListener("input", () => {
      arr[i] = inp.value;
    });
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "×";
    x.title = "quitar";
    x.addEventListener("click", () => onQuitar(i));
    row.appendChild(inp);
    row.appendChild(x);
    cont.appendChild(row);
  });
}

function pintar() {
  lista("allow-list", cfg.allow, (i) => {
    cfg.allow.splice(i, 1);
    pintar();
  });
  lista("deny-list", cfg.deny, (i) => {
    cfg.deny.splice(i, 1);
    pintar();
  });
  $("thumbQuality").value = cfg.thumbQuality || "hqdefault";
  $("budget").value = String(cfg.budgetPerHour ?? 400);
  $("maxPerLoad").value = String(cfg.maxPerLoad ?? 20);
  $("steerModel").value = cfg.steerModel || "openai/gpt-6-luna";
}

function añadir(which, inputId) {
  const inp = $(inputId);
  const v = inp.value.trim();
  if (!v) return;
  const arr = cfg[which];
  if (!arr.some((x) => x.toLowerCase() === v.toLowerCase())) arr.push(v);
  inp.value = "";
  pintar();
}

$("allow-add").addEventListener("click", () => añadir("allow", "allow-new"));
$("deny-add").addEventListener("click", () => añadir("deny", "deny-new"));
$("allow-new").addEventListener("keydown", (e) => { if (e.key === "Enter") añadir("allow", "allow-new"); });
$("deny-new").addEventListener("keydown", (e) => { if (e.key === "Enter") añadir("deny", "deny-new"); });

$("save").addEventListener("click", async () => {
  const b = parseInt(String($("budget").value).replace(/\D/g, ""), 10);
  const m = parseInt(String($("maxPerLoad").value).replace(/\D/g, ""), 10);
  const patch = {
    allow: cfg.allow.map((s) => s.trim()).filter(Boolean),
    deny: cfg.deny.map((s) => s.trim()).filter(Boolean),
    thumbQuality: $("thumbQuality").value,
    budgetPerHour: Number.isFinite(b) && b > 0 ? b : 400,
    maxPerLoad: Number.isFinite(m) && m > 0 ? m : 20,
    steerModel: $("steerModel").value.trim() || "openai/gpt-6-luna",
  };
  const r = await api.runtime.sendMessage({ type: "patch", patch });
  if (r && r.error) return estado(r.error, "err");
  cfg = { ...cfg, ...r };
  pintar();
  estado("guardado", "ok");
});

$("clear").addEventListener("click", async () => {
  const r = await api.runtime.sendMessage({ type: "clear" });
  if (r && r.error) return estado(r.error, "err");
  estado(`caché borrada (${r.removed})`, "ok");
});

$("reset-stats").addEventListener("click", async () => {
  const r = await api.runtime.sendMessage({ type: "resetStats" });
  if (r && r.error) return estado(r.error, "err");
  estado("estadísticas a cero", "ok");
});

// ---------- decisiones ----------

function pintarDecisiones(counts) {
  const cont = $("decisions");
  cont.textContent = "";

  if (!decisiones.length) {
    const p = document.createElement("div");
    p.className = "hint";
    p.textContent = "todavía no hay decisiones";
    cont.appendChild(p);
    return;
  }

  if (counts) {
    const p = document.createElement("div");
    p.className = "hint";
    p.style.margin = "0 0 4px";
    p.textContent = `${counts.good} marcadas bien · ${counts.bad} marcadas mal`;
    cont.appendChild(p);
  }

  for (const d of decisiones) {
    const row = document.createElement("div");
    row.className = "dec" + (d.fb ? " " + d.fb : "");

    const main = document.createElement("div");
    main.className = "dec-main";
    const titulo = document.createElement("div");
    titulo.className = "dec-title";
    titulo.textContent = d.title || d.id;
    titulo.title = d.title || d.id;

    const meta = document.createElement("div");
    meta.className = "dec-meta";
    const trozos = [d.channel || "canal ?", d.state === "hide" ? "ocultó" : "dejó pasar"];
    if (typeof d.score === "number") trozos.push(Math.round(d.score * 100) + "%");
    if (d.why) trozos.push(d.why);
    meta.textContent = trozos.join(" · ");

    main.appendChild(titulo);
    main.appendChild(meta);

    const fbs = document.createElement("div");
    fbs.className = "dec-fb";
    for (const [val, icono, texto] of [
      ["good", "👍", "acertó"],
      ["bad", "👎", "falló"],
    ]) {
      const b = document.createElement("button");
      b.className = "fb " + val + (d.fb === val ? " on" : "");
      b.textContent = icono;
      b.title = texto;
      b.addEventListener("click", () => marcar(d.id, val));
      fbs.appendChild(b);
    }

    row.appendChild(main);
    row.appendChild(fbs);
    cont.appendChild(row);
  }
}

async function cargarDecisiones() {
  const r = await api.runtime.sendMessage({ type: "decisions" });
  if (!r || r.error) return;
  decisiones = r.decisions || [];
  pintarDecisiones(r.counts);
}

async function marcar(id, fb) {
  const d = decisiones.find((x) => x.id === id);
  const val = d && d.fb === fb ? null : fb;
  const r = await api.runtime.sendMessage({ type: "feedback", id, fb: val });
  if (r && r.error) return estado(r.error, "err");
  await cargarDecisiones();
}

$("steer").addEventListener("click", async () => {
  const btn = $("steer");
  const out = $("steer-out");
  const st = $("steer-status");
  const aviso = (msg, kind) => {
    st.textContent = msg;
    st.className = "hint" + (kind ? " " + kind : "");
  };

  btn.disabled = true;
  out.hidden = true;
  aviso("pensando…");

  const r = await api.runtime.sendMessage({ type: "steerTaste" });
  btn.disabled = false;

  if (!r || r.error) {
    aviso("error: " + ((r && r.error) || "sin respuesta"), "err");
    return;
  }

  out.textContent = r.taste;
  out.hidden = false;
  const antes = $("steer-before");
  antes.textContent = r.before || "";
  antes.hidden = !r.before;
  $("steer-before-hint").hidden = !r.before;
  aviso(
    `gustos actualizados con ${r.used} falladas · ${r.model} · $${(r.cost || 0).toFixed(6)}`
  );
  await cargarDecisiones();
});

async function init() {
  const c = await api.runtime.sendMessage({ type: "config" });
  if (c && !c.error) cfg = { ...cfg, ...c };
  pintar();
  cargarDecisiones();
}

window.addEventListener("focus", cargarDecisiones);

init();
