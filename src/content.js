const api = globalThis.browser ?? globalThis.chrome;

const CARD_SEL = [
  "ytd-rich-item-renderer",
  "ytd-video-renderer",
  "ytd-compact-video-renderer",
  "ytd-grid-video-renderer",
  "ytd-playlist-video-renderer",
].join(",");

const SHORT_SEL = [
  "ytd-reel-item-renderer",
  "ytd-reel-shelf-renderer",
  "ytd-rich-shelf-renderer[is-shorts]",
  "ytm-shorts-lockup-view-model",
].join(",");

// tarjetas que no son un video largo: posts, playlists, mixes, canales y reels
const NO_VIDEO_SEL = [
  "ytd-post-renderer",
  "ytd-playlist-renderer",
  "ytd-playlist-thumbnail",
  "ytd-radio-renderer",
  "ytd-channel-renderer",
  "ytd-reel-item-renderer",
  "ytm-shorts-lockup-view-model",
].join(",");

// secciones del feed (shorts, posts, solo para miembros...) que no son videos
const SECCION_SEL = "ytd-rich-section-renderer, ytd-rich-shelf-renderer";

// etiquetas que delatan un directo, un estreno o un video solo para miembros
const NO_LARGO_RE =
  /\b(en directo|directo|live|proximamente|upcoming|estreno|premiere|miembros|members only)\b/;

// identifica esta carga de pagina: el tope de llamadas se cuenta por carga
const cargaId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

let cfg = {
  enabled: true,
  threshold: 0.45,
  hideShorts: true,
  hideThumbs: true,
  hideAvatars: true,
  showScore: true,
};

const enCurso = new Set();
let apagado = false;
let ultimaTarjeta = null; // la del ultimo menu que se ha abierto
let topeAlcanzado = false; // ya se han gastado las llamadas de esta carga

// ---------- leer la tarjeta ----------

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function idDe(card) {
  const a = card.querySelector(
    'a#thumbnail[href], a#video-title-link[href], a#video-title[href], a[href*="/watch?v="], a[href*="/shorts/"]'
  );
  const href = a && a.getAttribute("href");
  if (!href) return null;
  const m = href.match(/(?:\/watch\?v=|\/shorts\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}

function tituloDe(card) {
  const el =
    card.querySelector("#video-title") ||
    card.querySelector("a#video-title-link") ||
    card.querySelector("#video-title-link") ||
    // youtube nuevo: el feed ya no usa #video-title, el título vive en el h3
    card.querySelector("h3");
  if (!el) return "";
  // title o textContent antes que aria-label: el aria-label del lockup nuevo
  // lleva la duración pegada al final ("... 3 minutos y 26 segundos")
  return (el.getAttribute("title") || el.textContent || el.getAttribute("aria-label") || "")
    .replace(/\s+/g, " ")
    .trim();
}

function canalDe(card) {
  const el =
    card.querySelector("ytd-channel-name #text a") ||
    card.querySelector("ytd-channel-name a") ||
    card.querySelector("#channel-name #text") ||
    card.querySelector("#channel-name a") ||
    card.querySelector("ytd-channel-name") ||
    // youtube nuevo: el canal es un enlace /@canal dentro de los metadatos
    card.querySelector('a[href^="/@"]') ||
    card.querySelector('a[href^="/channel/"]') ||
    card.querySelector('a[href^="/c/"]') ||
    card.querySelector('a[href^="/user/"]');
  if (!el) return "";
  return (el.textContent || "").replace(/\s+/g, " ").trim();
}

function esShort(card) {
  if (card.matches(SHORT_SEL) || card.querySelector(SHORT_SEL)) return true;
  return !!card.querySelector('a[href*="/shorts/"]');
}

// las chapas de youtube ("EN DIRECTO", "SOLO PARA MIEMBROS", "ESTRENO") y la
// linea de metadatos son la forma barata de saber que no es un video normal
function textoEtiquetas(card) {
  const partes = [];
  card
    .querySelectorAll("ytd-badge-supported-renderer, .badge-shape-wiz__text, #metadata-line")
    .forEach((el) => partes.push(el.textContent || ""));
  return norm(partes.join(" "));
}

function esNoLargo(card) {
  if (esShort(card)) return true;
  if (card.querySelector('[overlay-style="LIVE"], [overlay-style="UPCOMING"]')) return true;
  if (card.querySelector(NO_VIDEO_SEL)) return true;
  return NO_LARGO_RE.test(textoEtiquetas(card));
}

function leer(card) {
  const id = idDe(card);
  if (!id) return null;
  return {
    id,
    title: tituloDe(card),
    channel: canalDe(card),
    kind: esShort(card) ? "short" : "video",
    largo: !esNoLargo(card),
  };
}

// ---------- pintar ----------

function quitarChapa(card) {
  card.querySelectorAll(".jev-badge").forEach((b) => b.remove());
}

// borra lo decidido y vuelve a pasar. al tirar de cache no gasta llamadas.
function refrescarTodo() {
  document.querySelectorAll("[data-jev-id]").forEach((el) => {
    el.removeAttribute("data-jev-id");
    el.removeAttribute("data-jev");
    el.removeAttribute("data-jev-wait");
    el.removeAttribute("data-jev-hidden");
    quitarChapa(el);
  });
  programar();
}

function marcar(card, state, info) {
  if (!card) return;
  card.setAttribute("data-jev", state);

  if (state === "hide") card.setAttribute("data-jev-hidden", "1");
  else card.removeAttribute("data-jev-hidden");

  quitarChapa(card);
  if (state !== "keep") return;
  if (!cfg.showScore) return;
  if (!info || typeof info.score !== "number") return;

  // fuera del <a>, si no la chapa seria parte del enlace y se puede clicar
  const titulo = card.querySelector("#video-title-link") || card.querySelector("#video-title");
  if (!titulo) return;
  const contenedor = titulo.parentElement;
  if (!contenedor) return;

  const b = document.createElement("span");
  b.className = "jev-badge";
  b.textContent = Math.round(info.score * 100) + "%";
  b.title =
    "jev: " +
    Math.round(info.score * 100) +
    "% de encaje" +
    (info.confidence ? " · confianza " + Math.round(info.confidence * 100) + "%" : "") +
    (info.cached ? " · cache" : "") +
    (typeof info.cost === "number" && info.cost ? " · $" + info.cost.toFixed(6) : "");
  contenedor.insertBefore(b, titulo.nextSibling);
}

// todo lo que no se haya filtrado se quita: solo quedan los videos que jev deja pasar
function ocultarResto() {
  document.querySelectorAll(CARD_SEL).forEach((card) => {
    const estado = card.getAttribute("data-jev");
    if (estado === "keep" || estado === "hide") return;
    // pendiente de respuesta: se decide solo
    if (card.getAttribute("data-jev-id") && estado === null) return;
    card.setAttribute("data-jev-hidden", "1");
  });
}

function anotarCarga(r) {
  if (!r) return;
  if (r.state === "skip") {
    topeAlcanzado = true;
    ocultarResto();
    return;
  }
  if (!r.carga) return;
  if (r.carga.n >= r.carga.tope) {
    topeAlcanzado = true;
    ocultarResto();
  }
}

// ---------- pedir la decision ----------

async function resolver(card, force) {
  if (!activo()) return;
  const v = leer(card);
  if (!v) return;

  if (card.getAttribute("data-jev-id") === v.id) {
    if (!force && card.getAttribute("data-jev") !== null) return; // ya decidido
    if (!force && card.getAttribute("data-jev-wait")) return; // falló, esperando reintento
  }

  card.setAttribute("data-jev-id", v.id);
  card.removeAttribute("data-jev");
  card.removeAttribute("data-jev-hidden");

  // shorts, directos, estrenos, miembros, playlists... fuera sin gastar jev
  if (!v.largo) {
    marcar(card, "hide");
    return;
  }

  if (enCurso.has(v.id)) return;
  enCurso.add(v.id);

  let r = null;
  try {
    r = await api.runtime.sendMessage({ type: "decide", video: v, cargaId, force: !!force });
  } catch {
    // worker dormido: reintento mas tarde sin martillear
  } finally {
    enCurso.delete(v.id);
  }

  if (!r) {
    card.setAttribute("data-jev-wait", "1");
    setTimeout(() => {
      if (!card.isConnected) return;
      card.removeAttribute("data-jev-wait");
      card.removeAttribute("data-jev-id");
      programar();
    }, 20000);
    return;
  }

  card.removeAttribute("data-jev-wait");
  anotarCarga(r);

  if (r.state === "error") {
    // falta key o saldo: no tiene sentido preguntar tarjeta por tarjeta
    if (/api key|401|402|credit/i.test(r.why || "")) {
      marcar(card, "off");
      return;
    }
    // fallo pasajero: se reintenta mas tarde
    card.setAttribute("data-jev-wait", "1");
    setTimeout(() => {
      if (!card.isConnected) return;
      card.removeAttribute("data-jev-wait");
      card.removeAttribute("data-jev-id");
      programar();
    }, 30000);
    return;
  }

  if (r.state === "hide") marcar(card, "hide", r);
  else if (r.state === "keep") marcar(card, "keep", r);
  else if (r.state === "off") marcar(card, "off");
  else if (r.state === "skip") marcar(card, "hide");
}

// ---------- solo miramos cuando entra en pantalla ----------

const vista = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      vista.unobserve(e.target);
      resolver(e.target).catch(() => {});
    }
  },
  { rootMargin: "800px 0px" }
);

function pintarReels() {
  const on = cfg.enabled && cfg.hideShorts;
  if (on) {
    document.querySelectorAll(SHORT_SEL).forEach((el) => el.setAttribute("data-jev-reel", "1"));
  } else {
    document.querySelectorAll("[data-jev-reel]").forEach((el) => el.removeAttribute("data-jev-reel"));
  }
}

// secciones que no son videos largos: shorts, posts, mixes, solo para miembros
function esSeccionNoVideo(seccion) {
  if (seccion.querySelector(SHORT_SEL)) return true;
  if (seccion.querySelector("ytd-post-renderer")) return true;
  if (seccion.querySelector("ytd-playlist-renderer, ytd-radio-renderer")) return true;
  const titulo = seccion.querySelector(
    "ytd-rich-shelf-renderer #title, #rich-shelf-header #title, h2"
  );
  return /(miembros|members|publicaciones|posts)/.test(norm(titulo && titulo.textContent));
}

function ocultarNoVideos() {
  document.querySelectorAll(SECCION_SEL).forEach((seccion) => {
    if (esSeccionNoVideo(seccion)) seccion.setAttribute("data-jev-hidden", "1");
  });

  document.querySelectorAll(NO_VIDEO_SEL).forEach((el) => {
    const card = el.closest(CARD_SEL) || el;
    if (!idDe(card)) card.setAttribute("data-jev-hidden", "1");
  });
}

// esto es SOLO para el feed de inicio. buscar o cualquier otra pagina se queda quieta.
function enInicio() {
  const p = location.pathname;
  return p === "/" || p === "";
}

function activo() {
  return cfg.enabled && enInicio();
}

// borra las marcas del feed, pero deja las miniaturas y los avatares como esten
function limpiarFeed() {
  document
    .querySelectorAll("[data-jev-id], [data-jev], [data-jev-hidden], [data-jev-wait], [data-jev-reel]")
    .forEach((el) => {
      el.removeAttribute("data-jev-id");
      el.removeAttribute("data-jev");
      el.removeAttribute("data-jev-hidden");
      el.removeAttribute("data-jev-wait");
      el.removeAttribute("data-jev-reel");
    });
  document.querySelectorAll(".jev-badge").forEach((b) => b.remove());
}

function limpiar() {
  limpiarFeed();

  const h = document.documentElement;
  delete h.dataset.jevEnabled;
  delete h.dataset.jevShorts;
  delete h.dataset.jevThumbs;
  delete h.dataset.jevAvatars;
  delete h.dataset.jevWatch;
}

function barrer() {
  if (apagado) return;

  if (!activo()) {
    // al salir del inicio se limpia el feed, pero miniaturas y avatares siguen fuera
    if (document.documentElement.dataset.jevEnabled) aplicarEstilos();
    return;
  }

  aplicarEstilos();
  pintarReels();
  ocultarNoVideos();
  if (topeAlcanzado) ocultarResto();

  for (const card of document.querySelectorAll(CARD_SEL)) {
    if (card.closest("ytd-comment-thread-renderer")) continue;
    const id = idDe(card);
    if (!id || card.getAttribute("data-jev-id") === id) continue;
    card.setAttribute("data-jev-id", id);
    vista.observe(card);
  }
}

let pendiente = null;
function programar() {
  if (pendiente) return;
  pendiente = setTimeout(() => {
    pendiente = null;
    barrer();
  }, 250);
}

// ---------- nuestras opciones en el menu de tres puntos ----------

function ponerItem(cont, texto, sub, onClick) {
  const el = document.createElement("div");
  el.className = "jev-menu-item";
  el.setAttribute("role", "menuitem");
  el.tabIndex = 0;
  const label = document.createElement("span");
  label.textContent = texto;
  el.appendChild(label);
  if (sub) {
    const s = document.createElement("span");
    s.className = "jev-menu-sub";
    s.textContent = sub;
    el.appendChild(s);
  }
  const lanzar = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    cerrarMenu();
    onClick();
  };
  el.addEventListener("click", lanzar);
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") lanzar(ev);
  });
  cont.appendChild(el);
  return el;
}

function cerrarMenu() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

async function añadirAlMenu(popup) {
  const card = ultimaTarjeta || popup.closest(CARD_SEL);
  if (!card || !card.isConnected) return;

  const v = leer(card);
  if (!v) return;

  // youtube reutiliza el popup entre tarjetas: si ya lo pintamos para otro video, se rehace
  if (popup.getAttribute("data-jev-for") === v.id) return;
  popup.setAttribute("data-jev-for", v.id);
  popup.querySelectorAll(".jev-menu-item, .jev-menu-sep").forEach((el) => el.remove());

  const cont = popup.querySelector("#items") || popup;
  const sep = document.createElement("div");
  sep.className = "jev-menu-sep";
  cont.appendChild(sep);

  if (v.channel) {
    ponerItem(cont, "nunca quitar este canal", v.channel, async () => {
      const c = await api.runtime.sendMessage({ type: "config" });
      const same = (x) => x.toLowerCase() === v.channel.toLowerCase();
      await api.runtime.sendMessage({
        type: "patch",
        patch: {
          allow: [...(c.allow || []).filter((x) => !same(x)), v.channel],
          deny: (c.deny || []).filter((x) => !same(x)),
        },
      });
      marcar(card, "keep");
      refrescarTodo();
    });

    ponerItem(cont, "quitar este canal para siempre", "se añade a vetados en ajustes", async () => {
      const c = await api.runtime.sendMessage({ type: "config" });
      const same = (x) => x.toLowerCase() === v.channel.toLowerCase();
      await api.runtime.sendMessage({
        type: "patch",
        patch: {
          deny: [...(c.deny || []).filter((x) => !same(x)), v.channel],
          allow: (c.allow || []).filter((x) => !same(x)),
        },
      });
      marcar(card, "hide");
      refrescarTodo();
    });
  }

  ponerItem(cont, "mostrar este vídeo", "se salta a jev", async () => {
    await api.runtime.sendMessage({ type: "override", id: v.id, action: "show" });
    marcar(card, "keep");
  });

  ponerItem(cont, "ocultar este vídeo", "", async () => {
    await api.runtime.sendMessage({ type: "override", id: v.id, action: "hide" });
    marcar(card, "hide");
  });

  ponerItem(cont, "volver a preguntar a jev", "", async () => {
    await api.runtime.sendMessage({ type: "override", id: v.id, action: "reclassify" });
    refrescarTodo();
    resolver(card, true).catch(() => {});
  });
}

function menus() {
  // el menu funciona en cualquier pagina: vetar un canal vale para el feed
  if (!cfg.enabled) return;
  document
    .querySelectorAll("ytd-menu-popup-renderer, tp-yt-iron-dropdown")
    .forEach((popup) => {
      if (!popup.getClientRects().length || popup.hidden) return;
      añadirAlMenu(popup).catch(() => {});
    });
}

// no barremos el documento en cada mutacion: solo miramos menus durante un rato
// despues de que el usuario pulse los tres puntos. es lo que mantiene esto barato.
let ventanaMenu = null;
function mirarMenusUnRato(ms = 1500) {
  if (ventanaMenu) clearTimeout(ventanaMenu);
  menus();
  ventanaMenu = setTimeout(() => {
    ventanaMenu = null;
  }, ms);
}

// ---------- arranque ----------

function aplicarEstilos() {
  const h = document.documentElement;

  if (!cfg.enabled) {
    limpiar();
    return;
  }

  // miniaturas, avatares y shorts se ocultan en todo youtube, no solo en el inicio
  h.dataset.jevThumbs = cfg.hideThumbs ? "on" : "off";
  h.dataset.jevAvatars = cfg.hideAvatars ? "on" : "off";
  h.dataset.jevShorts = cfg.hideShorts ? "on" : "off";

  // al ver un video, fuera la columna de recomendados
  h.dataset.jevWatch = location.pathname.startsWith("/watch") ? "on" : "off";

  if (activo()) {
    h.dataset.jevEnabled = "on";
  } else {
    delete h.dataset.jevEnabled;
    limpiarFeed();
  }
}

async function init() {
  try {
    const c = await api.runtime.sendMessage({ type: "config" });
    if (c && !c.error) cfg = { ...cfg, ...c };
  } catch {
    // nos quedamos con los defaults
  }
  aplicarEstilos();
  barrer();

  // solo nos interesa cuando youtube añade/quita tarjetas, no cada pixel que cambia
  new MutationObserver(() => {
    programar();
    if (ventanaMenu) menus();
  }).observe(document.documentElement, { childList: true, subtree: true });

  // apuntamos la tarjeta del menu que se abre, el dropdown a veces vive fuera del card
  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target && e.target.closest && e.target.closest("ytd-menu-renderer, #button-shape, yt-icon-button");
      if (!btn) return;
      const card = btn.closest(CARD_SEL);
      if (card) ultimaTarjeta = card;
      setTimeout(() => mirarMenusUnRato(), 120);
    },
    true
  );

  api.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || !ch.cfg) return;
    const antes = cfg;
    cfg = { ...cfg, ...ch.cfg.newValue };
    aplicarEstilos();

    // si cambian los gustos, el corte o la key, lo ya decidido deja de valer
    const cambiaCriterio =
      antes.taste !== cfg.taste ||
      antes.threshold !== cfg.threshold ||
      antes.apiKey !== cfg.apiKey ||
      antes.thumbQuality !== cfg.thumbQuality ||
      antes.enabled !== cfg.enabled;

    if (cambiaCriterio) {
      document.querySelectorAll("[data-jev-id]").forEach((el) => {
        el.removeAttribute("data-jev-id");
        el.removeAttribute("data-jev");
        el.removeAttribute("data-jev-wait");
        el.removeAttribute("data-jev-hidden");
        quitarChapa(el);
      });
    }
    programar();
  });

  document.addEventListener("yt-navigate-finish", () => {
    ultimaTarjeta = null;
    aplicarEstilos();
    barrer();
    setTimeout(menus, 300);
  });

  window.addEventListener("beforeunload", () => {
    apagado = true;
    vista.disconnect();
  });
}

init();
