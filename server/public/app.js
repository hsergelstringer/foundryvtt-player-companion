/**
 * Player web app for Player Companion. No framework: state lives in `state`, and
 * render() rebuilds the page from it. All text goes in through textContent.
 *
 * Changes are optimistic: a tap updates the sheet at once and the request is
 * queued. The server's answer replaces the sheet once the queue is empty, and
 * a failed request reloads the sheet so nothing stays wrong.
 */

const TOKEN_KEY = "player-companion.token";
const ACTOR_KEY = "player-companion.actor";
const TAB_KEY = "player-companion.tab";

const state = {
  token: null,
  me: null,
  actor: null,
  actorId: null,
  tab: "stats",
  error: null,
  foundry: true,
  open: new Set(), // expanded item rows
  spellFilter: "all",
  adder: null // the compendium search panel, see adderView()
};

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* private mode */ } }
};

/* -------------------------------------------- */
/*  DOM helpers                                 */
/* -------------------------------------------- */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** An image that removes itself if it fails to load (e.g. a Foundry path the browser can't reach). */
const img = (src, cls) => (src ? el("img", { src, alt: "", class: cls, onerror: e => e.target.remove() }) : null);

/** A portrait over the name's initials, so a missing or broken image still looks deliberate. */
function avatar(src, name, cls) {
  const initials = String(name ?? "?").split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
  return el("span", { class: `avatar ${cls ?? ""}`, "aria-hidden": "true" }, initials, img(src));
}

/* Rich descriptions: the module sends a small set of safe tags (see module/scripts/text.js).
   They are rebuilt here from that same list, never inserted as HTML. */
const RICH_TAGS = new Set(["p", "br", "hr", "ul", "ol", "li", "strong", "b", "em", "i", "u", "s", "sup", "sub", "code", "blockquote",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "h1", "h2", "h3", "h4", "h5", "h6", "dl", "dt", "dd"]);
const RICH_SPANS = new Set(["roll", "ref", "ref broken"]);

function copyRich(from, to) {
  for (const node of from.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) to.append(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.tagName.toLowerCase();
    let target = to;
    if (RICH_TAGS.has(tag)) target = to.appendChild(el(tag));
    else if (tag === "span" && RICH_SPANS.has(node.className)) target = to.appendChild(el("span", { class: node.className }));
    else if (tag === "a" && /^https?:\/\//i.test(node.getAttribute("href") ?? "")) {
      target = to.appendChild(el("a", { href: node.getAttribute("href"), target: "_blank", rel: "noopener noreferrer" }));
    }
    copyRich(node, target);
  }
}

/**
 * Descriptions of the character's items, fetched when a row is first opened.
 * Key → data, "loading", or "failed" (retried when the row is opened again).
 */
const descriptions = new Map();

function richDescription({ html, text }) {
  if (html) {
    const box = el("div", { class: "description rich" });
    copyRich(new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body, box);
    return box;
  }
  return el("p", { class: `description ${text ? "" : "muted"}` }, text || "No description.");
}

/**
 * An item's description. Compendium results carry theirs; the character's own
 * items are fetched on first open and cached until the item changes.
 */
function description(item, loading = false) {
  const waiting = el("p", { class: "description muted" }, "Loading…");
  if (loading) return waiting;
  if ("descriptionHtml" in item) return richDescription({ html: item.descriptionHtml, text: item.description });
  if (!item.hasDescription) return el("p", { class: "description muted" }, "No description.");

  const key = `${state.actorId}:${item.id}:${item.updated ?? ""}`;
  const cached = descriptions.get(key);
  // Remember failures: retrying on every render would loop while Foundry is offline.
  if (cached === "failed") return el("p", { class: "description muted" }, "Couldn't load the description. Close and reopen to try again.");
  if (cached && cached !== "loading") return richDescription(cached);
  if (!cached) {
    descriptions.set(key, "loading");
    api("POST", `actors/${state.actorId}/itemDescription`, { itemId: item.id })
      .then(data => descriptions.set(key, data))
      .catch(err => { descriptions.set(key, "failed"); handleError(err); })
      .finally(render);
  }
  return waiting;
}

const signed = n => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);
const minus = n => (n < 0 ? `−${Math.abs(n)}` : String(n));

/* Icons: fixed strings of our own, so innerHTML is safe here. */
const ICONS = {
  stats: '<path d="M12 2.5 20.5 7.5v9L12 21.5 3.5 16.5v-9Z"/><path d="M12 2.5v19M3.5 7.5l17 9M20.5 7.5l-17 9"/>',
  spells: '<path d="M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7Z"/><path d="M19 15.5c.25 1.6 1 2.3 2.5 2.5-1.5.25-2.25 1-2.5 2.5-.25-1.5-1-2.25-2.5-2.5 1.5-.2 2.25-.9 2.5-2.5Z"/>',
  gear: '<path d="M8 8V6a4 4 0 0 1 8 0v2"/><path d="M5 8h14l-1 12.5H6Z"/><path d="M9.5 13h5"/>',
  features: '<circle cx="12" cy="9" r="5.5"/><path d="m8.5 13.5-1.5 8 5-2.5 5 2.5-1.5-8"/>',
  trackers: '<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="m12 13 4-5"/><circle cx="12" cy="13" r="1.2"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  shield: '<path d="M12 3 19.5 6v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6Z"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>'
};

function icon(name, cls = "") {
  const span = el("span", { class: `icon ${cls}`, "aria-hidden": "true" });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

function toast(message, kind = "info") {
  const node = el("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : null }, message);
  document.getElementById("toasts").append(node);
  setTimeout(() => node.classList.add("hide"), 3500);
  setTimeout(() => node.remove(), 4000);
}

function banner(message) {
  const node = document.getElementById("banner");
  node.hidden = !message;
  node.textContent = message ?? "";
}

/* -------------------------------------------- */
/*  Bottom sheets                               */
/*  They live outside #app, so re-rendering the */
/*  page doesn't close them.                    */
/* -------------------------------------------- */

let closeSheet = null;

/** Open a bottom sheet. `build(close)` returns its content; resolves with what close() is given. */
function openSheet(title, build) {
  closeSheet?.(null);
  const root = document.getElementById("overlay");
  return new Promise(resolve => {
    const onKey = e => { if (e.key === "Escape") close(null); };
    const close = value => {
      if (closeSheet !== close) return;
      closeSheet = null;
      root.replaceChildren();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    closeSheet = close;
    document.addEventListener("keydown", onKey);
    root.replaceChildren(
      el("div", { class: "scrim", onclick: () => close(null) }),
      el("section", { class: "sheet-panel", role: "dialog", "aria-modal": "true", "aria-label": title },
        el("header", { class: "sheet-panel-head" },
          el("h2", {}, title),
          el("button", { class: "icon-button", onclick: () => close(null), "aria-label": "Close" }, icon("close"))),
        build(close)));
    (root.querySelector("[autofocus]") ?? root.querySelector(".sheet-panel button"))?.focus();
  });
}

function confirmSheet(title, message, { confirm = "Confirm", danger = false } = {}) {
  return openSheet(title, close => el("div", { class: "sheet-body" },
    message ? el("p", { class: "muted" }, message) : null,
    el("div", { class: "button-row" },
      el("button", { onclick: () => close(false) }, "Cancel"),
      el("button", { class: danger ? "danger" : "primary", onclick: () => close(true) }, confirm))));
}

/* -------------------------------------------- */
/*  API                                         */
/* -------------------------------------------- */

async function api(method, path, body) {
  const res = await fetch(`api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${state.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { status: res.status });
  return data;
}

let queue = Promise.resolve();
let pending = 0;
let failed = false;

/**
 * Change something on the current character. `optimistic` updates the local
 * sheet straight away; the server's version replaces it once the queue empties.
 */
function act(action, body = {}, optimistic = null) {
  const actorId = state.actorId;
  if (optimistic) {
    optimistic(state.actor);
    render();
  }
  pending++;
  document.body.classList.add("syncing");
  queue = queue.then(async () => {
    try {
      const data = await api("POST", `actors/${actorId}/${action}`, body);
      if (data.notice) toast(data.notice);
      if (pending === 1 && actorId === state.actorId) state.actor = data.actor ?? data;
    }
    catch (err) {
      failed = true;
      handleError(err);
    }
    finally {
      pending--;
      if (!pending) {
        document.body.classList.remove("syncing");
        if (failed) {
          failed = false;
          await refresh();
        }
        else render();
      }
    }
  });
  return queue;
}

function handleError(err) {
  if (err.status === 401) {
    signOut("That token is no longer valid. Create a new one in Foundry.");
    return;
  }
  if (err.status === 503) setFoundry(false);
  toast(err.message, "error");
}

/* -------------------------------------------- */
/*  Live updates                                */
/* -------------------------------------------- */

let events = null;
let eventsRetry = 1000;

function connectEvents() {
  events?.close();
  const url = new URL("api/events", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  events = socket;
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", token: state.token })));
  socket.addEventListener("message", async event => {
    const msg = JSON.parse(event.data);
    if (msg.type === "ready") {
      eventsRetry = 1000;
      setFoundry(true);
      if (!state.me) loadMe().catch(handleError);
    }
    else if (msg.type === "foundry") {
      setFoundry(msg.connected);
      if (msg.connected) refresh();
    }
    else if (msg.type === "error" && msg.status === 503) setFoundry(false);
    // Our own changes come back as events too; the queue already has the answer.
    else if (pending) return;
    else if (msg.type === "actorChanged" && msg.actorId === state.actorId) refresh();
    else if (msg.type === "trackersChanged" || msg.type === "requestsChanged") refresh();
  });
  socket.addEventListener("close", event => {
    if (events !== socket) return;
    events = null;
    if (event.code === 4001 && state.token) return signOut("That token is no longer valid. Create a new one in Foundry.");
    if (!state.token) return;
    setTimeout(() => state.token && connectEvents(), eventsRetry);
    eventsRetry = Math.min(eventsRetry * 2, 30_000);
  });
}

function setFoundry(connected) {
  state.foundry = connected;
  banner(connected ? null : "Foundry is offline. Changes will work again once the GM is logged in.");
}

async function refresh() {
  if (!state.actorId) return;
  try {
    state.actor = await api("GET", `actors/${state.actorId}`);
    render();
  }
  catch (err) {
    if (err.status === 404) {
      selectActor(null);
      await loadMe();
    }
    else handleError(err);
  }
}

/* -------------------------------------------- */
/*  Session                                     */
/* -------------------------------------------- */

async function signIn(token) {
  state.token = token.trim();
  state.error = null;
  try {
    await loadMe();
    storage.set(TOKEN_KEY, state.token);
    connectEvents();
  }
  catch (err) {
    if (err.status === 503 || err.status === 504) {
      // Foundry is offline: keep the token and wait for it on the event stream.
      storage.set(TOKEN_KEY, state.token);
      setFoundry(false);
      connectEvents();
      render();
      return;
    }
    state.token = null;
    state.error = err.status === 401 ? "That token was not recognised." : err.message;
    render();
  }
}

function signOut(message) {
  closeSheet?.(null);
  state.token = state.me = state.actor = state.actorId = null;
  state.error = message ?? null;
  storage.set(TOKEN_KEY, null);
  storage.set(ACTOR_KEY, null);
  const socket = events;
  events = null;
  socket?.close();
  render();
}

async function loadMe() {
  state.me = await api("GET", "me");
  const remembered = storage.get(ACTOR_KEY);
  const chars = state.me.characters;
  const pick = chars.find(c => c.id === state.actorId) ?? chars.find(c => c.id === remembered) ?? (chars.length === 1 ? chars[0] : null);
  if (pick) await selectActor(pick.id);
  else render();
}

async function selectActor(id) {
  state.actorId = id;
  state.actor = null;
  state.adder = null;
  state.open.clear();
  descriptions.clear();
  storage.set(ACTOR_KEY, id);
  if (id) await refresh();
  else render();
}

/* -------------------------------------------- */
/*  Page                                        */
/* -------------------------------------------- */

function render() {
  const root = document.getElementById("app");
  const scrollY = window.scrollY;
  // Keep the cursor in a text box (like the item search) across re-renders.
  const focused = document.activeElement?.dataset?.focusKey;
  const selection = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;

  let view;
  if (state.token && !state.me && !state.foundry) view = el("p", { class: "loading" }, "Waiting for Foundry…");
  else if (!state.token || !state.me) view = loginView();
  else if (!state.actorId) view = pickerView();
  else if (!state.actor) view = el("p", { class: "loading" }, "Loading character…");
  else view = sheetView(state.actor);
  root.replaceChildren(view);
  document.body.classList.toggle("has-nav", !!(state.actor && state.actorId));
  watchVitals();

  if (focused) {
    const input = root.querySelector(`[data-focus-key="${focused}"]`);
    input?.focus({ preventScroll: true });
    try { input?.setSelectionRange(...selection); } catch { /* not a text input */ }
  }
  window.scrollTo(0, scrollY);
}

function loginView() {
  const input = el("input", { type: "password", name: "token", placeholder: "pc_…", autocomplete: "off", required: true, "aria-label": "Access token" });
  return el("section", { class: "login" },
    el("div", { class: "login-mark" }, icon("stats")),
    el("h1", {}, "Character Sheet"),
    el("p", { class: "muted" }, "Open the sign-in link from Foundry, or paste your access token. Make one in Game Settings → Player Companion → New token."),
    state.error && el("p", { class: "error" }, state.error),
    el("form", {
      onsubmit: event => {
        event.preventDefault();
        if (input.value.trim()) signIn(input.value);
      }
    },
      input,
      el("button", { type: "submit", class: "primary" }, "Sign in")));
}

function pickerView() {
  const { me } = state;
  return el("section", { class: "picker" },
    el("header", { class: "picker-head" },
      el("div", {},
        el("p", { class: "eyebrow" }, me.world.title),
        el("h1", {}, "Choose a character")),
      el("button", { class: "ghost", onclick: () => signOut() }, "Sign out")),
    me.characters.length
      ? el("ul", { class: "character-list" }, me.characters.map(c =>
        el("li", {},
          el("button", { class: "character-choice", onclick: () => selectActor(c.id) },
            avatar(c.img, c.name, "small"),
            el("span", {}, el("strong", {}, c.name), el("small", { class: "muted" }, c.level ? `Level ${c.level}` : c.type))))))
      : el("p", { class: "muted" }, `Signed in as ${me.user.name}, but you don't own any characters yet. Ask the GM to give your user ownership of one.`));
}

const TABS = [
  { key: "stats", label: "Stats", icon: "stats" },
  { key: "spells", label: "Spells", icon: "spells" },
  { key: "inventory", label: "Gear", icon: "gear" },
  { key: "features", label: "Features", icon: "features" },
  { key: "trackers", label: "Trackers", icon: "trackers" }
];

function availableTabs(a) {
  return TABS.filter(t => {
    if (t.key === "spells") return a.items.spells.length || a.spellSlots.length || a.spellcasting.ability || a.spellcasting.classes?.length;
    if (t.key === "trackers") return hasTrackers(a);
    return true;
  });
}

function setTab(key) {
  state.tab = key;
  state.adder = null;
  storage.set(TAB_KEY, key);
  render();
  window.scrollTo(0, 0);
}

function sheetView(a) {
  const tabs = availableTabs(a);
  if (!tabs.some(t => t.key === state.tab)) state.tab = "stats";
  const classes = a.classes.map(c => `${c.name}${c.subclass ? ` (${c.subclass})` : ""} ${c.levels}`).join(" / ");

  return el("div", { class: "sheet" },
    el("header", { class: "sheet-head" },
      avatar(a.img, a.name, "portrait"),
      el("div", { class: "identity" },
        el("h1", {}, a.name),
        el("p", { class: "muted" }, [classes || (a.level ? `Level ${a.level}` : ""), a.species].filter(Boolean).join(" · "))),
      el("button", { class: "icon-button", onclick: openMenu, "aria-label": "Menu" }, icon("more"))),
    vitalsView(a),
    el("section", { class: "tab-body" }, {
      stats: () => statsView(a),
      spells: () => spellsView(a),
      inventory: () => inventoryView(a),
      features: () => featuresView(a),
      trackers: () => trackersView(a)
    }[state.tab]()),
    el("nav", { class: "tabbar", "aria-label": "Sections" }, tabs.map(t =>
      el("button", {
        class: state.tab === t.key ? "active" : "",
        "aria-current": state.tab === t.key ? "page" : null,
        onclick: () => setTab(t.key)
      }, icon(t.icon), el("span", {}, t.label)))));
}

function openMenu() {
  const others = state.me.characters.length > 1;
  openSheet(state.actor.name, close => el("div", { class: "sheet-body menu" },
    el("p", { class: "muted" }, `Signed in as ${state.me.user.name} in ${state.me.world.title}.`),
    others ? el("button", { onclick: () => { close(); selectActor(null).then(loadMe); } }, "Switch character") : null,
    el("button", { class: "danger-text", onclick: () => { close(); signOut(); } }, "Sign out")));
}

/* -------------------------------------------- */
/*  Controls                                    */
/* -------------------------------------------- */

function stepper(value, onChange, { min = 0, max = Infinity, label = "" } = {}) {
  return el("span", { class: "stepper", role: "group", "aria-label": label || null },
    el("button", { disabled: value <= min, onclick: () => onChange(value - 1), "aria-label": `Decrease ${label}`.trim() }, "−"),
    el("span", { class: "value" }, String(value)),
    el("button", { disabled: value >= max, onclick: () => onChange(value + 1), "aria-label": `Increase ${label}`.trim() }, "+"));
}

function pips(value, max, onSet, kind = "") {
  return el("span", { class: `pips ${kind}` }, Array.from({ length: max }, (_, i) =>
    el("button", {
      class: i < value ? "pip on" : "pip",
      "aria-label": `${i + 1} of ${max}`,
      "aria-pressed": String(i < value),
      // Tapping the last filled pip empties it; any other pip fills up to it.
      onclick: () => onSet(i + 1 === value ? i : i + 1)
    })));
}

/** Pips for small counts, a stepper for big ones. */
function counter(value, max, onSet, label) {
  return max <= 8 ? pips(value, max, onSet) : el("span", { class: "counter" },
    stepper(value, onSet, { max, label }), el("small", { class: "muted" }, `/ ${max}`));
}

function stat(label, value, sub = null) {
  return el("div", { class: "stat" },
    el("span", { class: "label" }, label),
    el("span", { class: "num" }, String(value)),
    sub ? el("span", { class: "sub" }, sub) : null);
}

/* -------------------------------------------- */
/*  Vitals                                      */
/* -------------------------------------------- */

function vitalsView(a) {
  const max = a.hp.max + a.hp.tempmax;
  const pct = max ? Math.max(0, Math.min(100, (a.hp.value / max) * 100)) : 0;
  const bar = el("div", { class: "hp-bar-fill" });
  bar.style.width = `${pct}%`;
  if (pct <= 25) bar.classList.add("low");
  else if (pct <= 50) bar.classList.add("mid");

  const casters = a.spellcasting.classes ?? [];
  const dcs = casters.length ? [...new Set(casters.map(c => c.dc))] : (a.spellcasting.dc ? [a.spellcasting.dc] : []);
  const units = a.speed.units ?? "ft";
  const otherSpeeds = (a.speed.all ?? []).filter(s => s.key !== "walk");

  return el("section", { class: "vitals card" },
    miniBar(a, max),
    el("div", { class: "hp-row" },
      el("button", { class: "hp-value", onclick: () => hpSheet(a), "aria-label": `Hit points ${a.hp.value} of ${max}. Change` },
        el("span", { class: "label" }, "Hit points"),
        el("span", { class: "hp-numbers" },
          el("span", { class: "big" }, String(a.hp.value)),
          el("span", { class: "of" }, `/ ${max}`),
          a.hp.temp ? el("span", { class: "temp" }, `+${a.hp.temp} temp`) : null)),
      el("div", { class: "hp-buttons" },
        el("button", { class: "danger", onclick: () => hpSheet(a, "damage") }, "Damage"),
        el("button", { class: "heal", onclick: () => hpSheet(a, "heal") }, "Heal"))),
    el("div", { class: "hp-bar" }, bar),
    el("div", { class: "stats" },
      stat("AC", a.ac),
      stat("Init", signed(a.initiative)),
      stat("Speed", `${a.speed.walk} ${units}`, [
        ...otherSpeeds.map(s => `${s.label.toLowerCase()} ${s.value}${s.key === "fly" && a.speed.hover ? " hover" : ""}`),
        a.speed.special
      ].filter(Boolean).join(", ") || null),
      stat("Prof", signed(a.proficiency)),
      dcs.length ? stat("DC", dcs.join("/"), dcs.length > 1 ? "per class" : null) : null),
    el("div", { class: "status-row" },
      el("button", {
        class: `pill ${a.inspiration ? "on" : ""}`, "aria-pressed": String(a.inspiration),
        onclick: () => act("inspiration", { value: !a.inspiration }, s => { s.inspiration = !a.inspiration; })
      }, icon("star"), "Inspiration"),
      el("button", { class: `pill ${a.exhaustion ? "warn" : ""}`, onclick: () => exhaustionSheet(a) }, `Exhaustion ${a.exhaustion}`),
      a.conditions.map(c => el("span", { class: "chip condition" }, c))),
    defensesLine(a),
    a.hp.value === 0 ? deathSavesView(a) : null);
}

/** Senses, damage defenses and condition immunities: what matters while taking hits at the table. */
function defensesLine(a) {
  const t = a.traits;
  if (!t) return null;
  const parts = [
    t.senses.length ? t.senses.join(", ") : null,
    t.resistances.length ? `Resists ${t.resistances.join(", ")}` : null,
    t.immunities.length || t.conditionImmunities.length ? `Immune to ${[...t.immunities, ...t.conditionImmunities].join(", ")}` : null,
    t.vulnerabilities.length ? `Vulnerable to ${t.vulnerabilities.join(", ")}` : null
  ].filter(Boolean);
  return parts.length ? el("p", { class: "defenses muted" }, parts.join(" · ")) : null;
}

/**
 * A slim bar pinned to the top once the vitals card scrolls away, so hit
 * points are always one tap from the table. Shown by watchVitals().
 */
function miniBar(a, max) {
  return el("div", { class: `mini-bar ${vitalsHidden ? "show" : ""}`, "aria-hidden": String(!vitalsHidden) },
    el("button", { class: "mini-hp", onclick: () => hpSheet(a), tabindex: vitalsHidden ? null : "-1" },
      el("strong", {}, String(a.hp.value)), el("span", { class: "muted" }, ` / ${max}`),
      a.hp.temp ? el("span", { class: "temp" }, ` +${a.hp.temp}`) : null,
      el("span", { class: "mini-name muted" }, a.name)),
    el("button", { class: "danger small", onclick: () => hpSheet(a, "damage"), tabindex: vitalsHidden ? null : "-1" }, "Damage"),
    el("button", { class: "heal small", onclick: () => hpSheet(a, "heal"), tabindex: vitalsHidden ? null : "-1" }, "Heal"));
}

let vitalsHidden = false;
let vitalsObserver = null;

function watchVitals() {
  vitalsObserver?.disconnect();
  const card = document.querySelector(".vitals .hp-row");
  if (!card || !("IntersectionObserver" in window)) return;
  vitalsObserver = new IntersectionObserver(([entry]) => {
    vitalsHidden = !entry.isIntersecting && entry.boundingClientRect.top < 0;
    const bar = document.querySelector(".mini-bar");
    bar?.classList.toggle("show", vitalsHidden);
    bar?.setAttribute("aria-hidden", String(!vitalsHidden));
    bar?.querySelectorAll("button").forEach(b => (vitalsHidden ? b.removeAttribute("tabindex") : b.setAttribute("tabindex", "-1")));
  });
  vitalsObserver.observe(card);
}

function hpSheet(a, mode = "damage") {
  const amount = el("input", {
    type: "text", inputmode: "numeric", pattern: "[0-9]*", autocomplete: "off", placeholder: "0",
    class: "hp-input", autofocus: true, "aria-label": "Amount"
  });
  const read = () => {
    const n = Number(amount.value);
    if (!amount.value || !Number.isInteger(n) || n < 0) {
      toast("Enter a whole number", "error");
      amount.focus();
      return null;
    }
    return n;
  };
  const add = n => { amount.value = String((Number(amount.value) || 0) + n); amount.focus(); };
  const run = (close, field) => {
    const n = read();
    if (n === null) return;
    close();
    act("hp", { [field]: n });
  };
  const max = a.hp.max + a.hp.tempmax;
  openSheet("Hit points", close => el("form", {
    class: "sheet-body hp-sheet",
    // Enter applies whichever button opened the sheet.
    onsubmit: e => { e.preventDefault(); run(close, mode); }
  },
    el("p", { class: "hp-now" },
      el("strong", {}, String(a.hp.value)), el("span", { class: "muted" }, ` / ${max}`),
      a.hp.temp ? el("span", { class: "temp" }, ` +${a.hp.temp} temp`) : null),
    amount,
    el("div", { class: "quick" }, [1, 5, 10].map(n => el("button", { type: "button", onclick: () => add(n) }, `+${n}`))),
    el("div", { class: "button-row" },
      el("button", { type: "button", class: `danger ${mode === "damage" ? "default" : ""}`, onclick: () => run(close, "damage") }, "Damage"),
      el("button", { type: "button", class: `heal ${mode === "heal" ? "default" : ""}`, onclick: () => run(close, "heal") }, "Heal")),
    el("div", { class: "button-row" },
      el("button", { type: "button", class: "ghost", onclick: () => run(close, "value") }, "Set HP to this"),
      el("button", { type: "button", class: "ghost", onclick: () => run(close, "temp") }, "Set temp HP")),
    el("p", { class: "muted hint" }, "Damage uses temporary hit points first.")));
}

function exhaustionSheet(a) {
  const levels = a.exhaustionMax ?? 6;
  openSheet("Exhaustion", close => el("div", { class: "sheet-body" },
    el("div", { class: "level-picker" }, Array.from({ length: levels + 1 }, (_, n) =>
      el("button", {
        class: n === a.exhaustion ? "primary" : "",
        "aria-pressed": String(n === a.exhaustion),
        onclick: () => { close(); act("exhaustion", { value: n }, s => { s.exhaustion = n; }); }
      }, String(n))))));
}

function deathSavesView(a) {
  const set = (field, v) => act("deathSaves", { [field]: v }, s => { s.death[field] = v; });
  return el("div", { class: "death" },
    el("strong", {}, "Death saves"),
    el("span", { class: "death-row" }, el("span", { class: "muted" }, "Successes"), pips(a.death.success, 3, v => set("success", v), "good")),
    el("span", { class: "death-row" }, el("span", { class: "muted" }, "Failures"), pips(a.death.failure, 3, v => set("failure", v), "bad")));
}

/* -------------------------------------------- */
/*  Stats                                       */
/* -------------------------------------------- */

function statsView(a) {
  const marks = { 0.5: "half", 1: "prof", 2: "expert" };
  const titles = { 0: "Not proficient", 0.5: "Half proficiency", 1: "Proficient", 2: "Expertise" };
  return [
    el("div", { class: "abilities" }, a.abilities.map(ab =>
      el("div", { class: "ability card", "aria-label": ab.label },
        el("span", { class: "abbr" }, ab.abbreviation.toUpperCase()),
        el("span", { class: "mod" }, signed(ab.mod)),
        el("span", { class: "score" }, String(ab.value)),
        el("span", { class: `save ${ab.proficient ? "prof" : ""}`, title: ab.proficient ? "Proficient" : null },
          "Save ", el("strong", {}, signed(ab.save)))))),
    traitsView(a),
    el("section", { class: "group" },
      el("h2", {}, "Skills"),
      el("ul", { class: "skills card" }, a.skills.map(s =>
        el("li", { class: "skill" },
          el("span", { class: `prof-dot ${marks[s.proficiency] ?? ""}`, title: titles[s.proficiency] ?? "" }),
          el("span", { class: "name" }, s.label, el("small", { class: "muted" }, ` ${s.ability.toUpperCase()}`)),
          el("span", { class: "passive", title: `Passive ${s.label}` }, String(s.passive)),
          el("span", { class: "total" }, signed(s.total)))))),
    el("p", { class: "muted hint legend" },
      el("span", { class: "prof-dot prof" }), " proficient  ",
      el("span", { class: "prof-dot expert" }), " expertise  ",
      el("span", { class: "prof-dot half" }), " half · small number is passive")
  ];
}

function traitsView(a) {
  const t = a.traits;
  if (!t) return null;
  const rows = [
    ["Senses", t.senses],
    ["Resistances", t.resistances],
    ["Immunities", t.immunities],
    ["Vulnerabilities", t.vulnerabilities],
    ["Damage changes", t.damageModifications],
    ["Condition immunities", t.conditionImmunities],
    ["Languages", [...t.languages, ...t.communication]],
    ["Armor", t.proficiencies.armor],
    ["Weapons", t.proficiencies.weapons],
    ["Tools", t.proficiencies.tools],
    ["Size", t.size ? [t.size] : []]
  ].filter(([, list]) => list.length);
  if (!rows.length) return null;
  return el("section", { class: "group" },
    el("h2", {}, "Traits"),
    el("dl", { class: "traits card" }, rows.map(([label, list]) =>
      el("div", {}, el("dt", {}, label), el("dd", {}, list.join(", "))))));
}

/* -------------------------------------------- */
/*  Items                                       */
/* -------------------------------------------- */

function toggleOpen(id) {
  state.open.has(id) ? state.open.delete(id) : state.open.add(id);
  for (const [key, value] of descriptions) {
    if (value === "failed" && key.startsWith(`${state.actorId}:${id}:`)) descriptions.delete(key);
  }
  render();
}

/**
 * A row: picture, name and a one-line summary, quick toggles on the right, and
 * a usage strip underneath that is always visible. Tapping the name opens the
 * details, activities, description and the remaining controls.
 */
function itemRow(item, { meta = [], quick = [], usage = [], controls = [], lead = null } = {}) {
  const open = state.open.has(item.id);
  const summary = [item.summary, ...meta].filter(Boolean).join(" · ");
  const quickItems = [quick].flat().filter(Boolean);
  const usageItems = [...usageStrip(item), ...usage].filter(Boolean);
  const controlItems = [attunementControl(item), ...controls].filter(Boolean);
  return el("li", { class: `item ${open ? "open" : ""}` },
    el("div", { class: "item-main" },
      lead,
      el("button", { class: "item-name", onclick: () => toggleOpen(item.id), "aria-expanded": String(open) },
        img(item.img),
        el("span", { class: "item-title" }, item.name, summary ? el("small", { class: "muted" }, summary) : null)),
      quickItems.length ? el("div", { class: "item-quick" }, quickItems) : null),
    usageItems.length ? el("div", { class: "item-usage" }, usageItems) : null,
    open ? el("div", { class: "item-detail" },
      detailsList(item),
      activitiesList(item),
      description(item),
      controlItems.length ? el("div", { class: "item-controls" }, controlItems) : null,
      removeButton(item)) : null);
}

function control(label, widget) {
  return el("div", { class: "control" }, el("span", { class: "muted" }, label), widget);
}

/** One line of the usage strip: what is being counted, how it comes back, and the counter. */
function usageLine(label, recovery, widget) {
  return el("div", { class: "usage-line" },
    el("span", { class: "usage-label" }, label, recovery ? el("small", { class: "muted" }, ` · ${recovery}`) : null),
    widget);
}

/** Item uses and activity uses, as counters that work without opening the row. */
function usageStrip(item) {
  const lines = [];
  if (item.uses) {
    lines.push(usageLine("Uses", item.uses.recovery, counter(item.uses.value, item.uses.max,
      v => act("itemUses", { itemId: item.id, value: v }, () => { item.uses.value = v; }), `${item.name} uses`)));
  }
  for (const activity of item.activityUses ?? []) {
    lines.push(usageLine(activity.name === item.name ? "Uses" : activity.name, activity.recovery, counter(activity.value, activity.max,
      v => act("activityUses", { itemId: item.id, activityId: activity.id, value: v }, () => { activity.value = v; }), `${activity.name} uses`)));
  }
  return lines;
}

function detailsList(item) {
  if (!item.details?.length) return null;
  return el("dl", { class: "details" }, item.details.map(d =>
    el("div", {}, el("dt", {}, d.label), el("dd", {}, d.value))));
}

function activitiesList(item) {
  if (!item.activities?.length) return null;
  return el("ul", { class: "activities" }, item.activities.map(a =>
    el("li", {}, el("strong", {}, a.name), a.summary ? el("span", { class: "muted" }, a.summary) : null)));
}

function attunementControl(item) {
  if (!item.attunement) return null;
  return control(item.attunement === "required" ? "Attuned (required)" : "Attuned", el("button", {
    class: `switch ${item.attuned ? "on" : ""}`, role: "switch", "aria-checked": String(!!item.attuned), "aria-label": `Attuned to ${item.name}`,
    onclick: () => act("itemAttuned", { itemId: item.id, value: !item.attuned }, () => { item.attuned = !item.attuned; })
  }, el("span")));
}

function quantityStepper(item) {
  return stepper(item.quantity, v => act("itemQuantity", { itemId: item.id, value: v }, () => { item.quantity = v; }), { max: 99999, label: `${item.name} quantity` });
}

/* -------------------------------------------- */
/*  Adding and removing items                   */
/* -------------------------------------------- */

const changesMode = () => state.actor?.itemChanges?.mode ?? "off";

function removeButton(item) {
  if (!item.removable || changesMode() === "off") return null;
  const approve = changesMode() === "approve";
  const waiting = state.actor.itemChanges.requests.some(r => r.kind === "remove" && r.itemId === item.id && r.status === "pending");
  if (waiting) return el("p", { class: "muted item-actions" }, "Waiting for the GM to approve removing this.");
  return el("div", { class: "item-actions" },
    el("button", {
      class: "ghost danger-text small",
      onclick: async () => {
        const ok = await confirmSheet(approve ? `Ask to remove ${item.name}?` : `Remove ${item.name}?`,
          approve ? "The GM approves removals before they happen." : "It's deleted from the character in Foundry.",
          { confirm: approve ? "Ask the GM" : "Remove", danger: true });
        if (ok) act("removeItem", { itemId: item.id });
      }
    }, approve ? "Ask GM to remove" : "Remove"));
}

/** Pending and denied requests for one tab ("spell" or "item"). */
function requestsView(a, kind) {
  const list = (a.itemChanges?.requests ?? []).filter(r => (r.type === "spell") === (kind === "spell"));
  if (!list.length) return null;
  return el("section", { class: "group" },
    el("h2", {}, "Requests"),
    el("ul", { class: "items" }, list.map(r =>
      el("li", { class: `item request ${r.status}` },
        el("div", { class: "item-main" },
          el("span", { class: "item-name static" },
            img(r.img),
            el("span", { class: "item-title" },
              `${r.kind === "add" ? "Add" : "Remove"} ${r.name}${r.quantity > 1 ? ` ×${r.quantity}` : ""}`,
              el("small", { class: r.status === "pending" ? "muted" : "error" },
                r.status === "pending" ? "Waiting for the GM" : r.reason ? `Couldn't be done: ${r.reason}` : "The GM said no"))),
          el("div", { class: "item-quick" },
            el("button", { class: "ghost small", onclick: () => act("cancelItemRequest", { requestId: r.id }) },
              r.status === "pending" ? "Withdraw" : "Dismiss")))))));
}

function addButton(kind) {
  if (changesMode() === "off") return null;
  return el("button", { class: "add-button", onclick: () => openAdder(kind) },
    icon("plus"), kind === "spell" ? "Add spell" : "Add item");
}

const ITEM_TYPE_FILTERS = [["", "All types"], ["weapon", "Weapons"], ["equipment", "Equipment"], ["consumable", "Consumables"],
  ["tool", "Tools"], ["loot", "Loot"], ["container", "Containers"]];

function openAdder(kind) {
  state.adder = { kind, query: "", pack: "", type: "", level: "", results: null, total: 0, packs: [], loading: false, open: null, details: {}, seq: 0 };
  render();
  searchItems();
}

let searchTimer = null;
function queueSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchItems, 250);
}

async function searchItems() {
  const adder = state.adder;
  if (!adder) return;
  const seq = ++adder.seq;
  adder.loading = true;
  render();
  try {
    const data = await api("POST", `actors/${state.actorId}/searchItems`, {
      kind: adder.kind, query: adder.query, pack: adder.pack, type: adder.type, level: adder.level
    });
    if (state.adder !== adder || seq !== adder.seq) return; // a newer search is on its way
    Object.assign(adder, { results: data.results, total: data.total, packs: data.packs });
  }
  catch (err) {
    handleError(err);
  }
  finally {
    if (state.adder === adder && seq === adder.seq) {
      adder.loading = false;
      render();
    }
  }
}

async function toggleResult(uuid) {
  const adder = state.adder;
  adder.open = adder.open === uuid ? null : uuid;
  render();
  if (!adder.open || adder.details[uuid]) return;
  try {
    adder.details[uuid] = await api("POST", `actors/${state.actorId}/itemDetails`, { uuid });
  }
  catch (err) {
    handleError(err);
  }
  render();
}

function adderView() {
  const adder = state.adder;
  const isSpell = adder.kind === "spell";
  const approve = changesMode() === "approve";
  const setFilter = (key, value) => { adder[key] = value; searchItems(); };

  const filters = el("div", { class: "adder-filters" },
    el("label", { class: "search-box" },
      icon("search"),
      el("input", {
        type: "search", placeholder: isSpell ? "Search spells" : "Search items", value: adder.query,
        dataset: { focusKey: "adder-query" }, autocomplete: "off", enterkeyhint: "search", "aria-label": "Search",
        oninput: e => { adder.query = e.target.value; queueSearch(); }
      })),
    isSpell
      ? el("select", { "aria-label": "Spell level", onchange: e => setFilter("level", e.target.value) },
        [["", "All levels"], ["0", "Cantrips"], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(l => [String(l), `Level ${l}`])]
          .map(([v, l]) => el("option", { value: v, selected: adder.level === v }, l)))
      : el("select", { "aria-label": "Item type", onchange: e => setFilter("type", e.target.value) },
        ITEM_TYPE_FILTERS.map(([v, l]) => el("option", { value: v, selected: adder.type === v }, l))),
    adder.packs.length > 1
      ? el("select", { "aria-label": "Compendium", onchange: e => setFilter("pack", e.target.value) },
        el("option", { value: "" }, "All compendiums"),
        adder.packs.map(p => el("option", { value: p.id, selected: adder.pack === p.id }, p.label)))
      : null);

  let body;
  if (!adder.results) body = el("p", { class: "muted" }, "Searching…");
  else if (!adder.results.length) {
    body = el("p", { class: "muted" }, adder.packs.length
      ? "Nothing matches."
      : `There are no ${isSpell ? "spells" : "items"} in the compendiums you can see. The GM controls which compendiums players can open.`);
  }
  else {
    body = [
      el("ul", { class: "items results" }, adder.results.map(r => {
        const open = adder.open === r.uuid;
        const details = adder.details[r.uuid];
        const meta = isSpell
          ? [r.level ? `Level ${r.level}` : "Cantrip", r.school, r.pack]
          : [r.typeLabel, r.rarity, r.price, r.pack];
        return el("li", { class: `item ${open ? "open" : ""}` },
          el("div", { class: "item-main" },
            el("button", { class: "item-name", onclick: () => toggleResult(r.uuid), "aria-expanded": String(open) },
              img(r.img),
              el("span", { class: "item-title" }, r.name, el("small", { class: "muted" }, meta.filter(Boolean).join(" · ")))),
            el("div", { class: "item-quick" },
              el("button", { class: "primary small", onclick: () => act("addItem", { uuid: r.uuid }) }, approve ? "Ask GM" : "Add"))),
          open ? el("div", { class: "item-detail" },
            description(details ?? {}, !details)) : null);
      })),
      adder.total > adder.results.length
        ? el("p", { class: "muted hint" }, `Showing ${adder.results.length} of ${adder.total}. Type more of the name to narrow it down.`)
        : null
    ];
  }

  return el("section", { class: `adder card ${adder.loading ? "loading" : ""}` },
    el("header", { class: "adder-head" },
      el("h2", {}, isSpell ? "Add a spell" : "Add an item"),
      el("button", { class: "icon-button", onclick: () => { state.adder = null; render(); }, "aria-label": "Close search" }, icon("close"))),
    approve ? el("p", { class: "muted hint" }, "The GM approves each addition before it reaches your sheet.") : null,
    filters,
    body);
}

/* -------------------------------------------- */
/*  Spells                                      */
/* -------------------------------------------- */

const MODE_LABELS = { always: "Always", pact: "Pact", atwill: "At will", innate: "Innate", ritual: "Ritual" };

function spellRow(spell) {
  const prep = spell.preparation ?? {};
  const lead = prep.toggleable
    ? el("button", {
      class: `prep-toggle ${prep.prepared ? "on" : ""}`, "aria-pressed": String(prep.prepared),
      "aria-label": prep.prepared ? `Unprepare ${spell.name}` : `Prepare ${spell.name}`, title: prep.prepared ? "Prepared" : "Not prepared",
      onclick: () => act("spellPrepared", { itemId: spell.id, value: !prep.prepared }, () => { prep.prepared = !prep.prepared; })
    }, icon("check"))
    : null;
  return itemRow(spell, {
    lead,
    meta: spell.summary ? [] : [spell.school],
    quick: [
      spell.ritual ? el("span", { class: "chip", title: "Ritual" }, "R") : null,
      spell.level > 0 && MODE_LABELS[prep.mode] ? el("span", { class: "chip" }, MODE_LABELS[prep.mode]) : null
    ]
  });
}

function spellsView(a) {
  const shown = a.items.spells.filter(s => state.spellFilter === "all" || s.level === 0 || s.preparation?.prepared);
  const byLevel = new Map();
  for (const spell of shown) {
    if (!byLevel.has(spell.level)) byLevel.set(spell.level, []);
    byLevel.get(spell.level).push(spell);
  }
  const slotFor = level => a.spellSlots.find(s => s.key === `spell${level}`);
  const levels = new Set([...byLevel.keys(), ...a.spellSlots.filter(s => s.key !== "pact").map(s => s.level)]);
  const pact = a.spellSlots.find(s => s.key === "pact");
  const setSlot = slot => v => act("spellSlot", { slot: slot.key, value: v }, () => { slot.value = v; });
  const casters = a.spellcasting.classes?.length
    ? a.spellcasting.classes
    : a.spellcasting.dc ? [{ name: "Spellcasting", abilityLabel: a.spellcasting.ability?.toUpperCase() ?? "", dc: a.spellcasting.dc, attack: a.spellcasting.attack }] : [];
  const anyToggleable = a.items.spells.some(s => s.preparation?.toggleable);
  const searching = state.adder?.kind === "spell";

  return [
    casters.length ? el("div", { class: "casters" }, casters.map(c =>
      el("div", { class: "caster card" },
        el("span", { class: "caster-name" }, c.name, c.abilityLabel ? el("small", { class: "muted" }, c.abilityLabel) : null),
        el("span", { class: "caster-numbers" },
          el("span", {}, el("small", { class: "muted" }, "Save DC"), String(c.dc)),
          el("span", {}, el("small", { class: "muted" }, "Attack"), signed(c.attack)))))) : null,
    anyToggleable || !searching ? el("div", { class: "toolbar" },
      anyToggleable ? el("div", { class: "segmented", role: "group", "aria-label": "Show" },
        [["all", "All"], ["prepared", "Prepared"]].map(([key, label]) =>
          el("button", {
            class: state.spellFilter === key ? "active" : "", "aria-pressed": String(state.spellFilter === key),
            onclick: () => { state.spellFilter = key; render(); }
          }, label))) : el("span"),
      searching ? null : addButton("spell")) : null,
    searching ? adderView() : null,
    requestsView(a, "spell"),
    pact ? el("section", { class: "group" },
      el("header", { class: "level-head" },
        el("h2", {}, "Pact slots", el("small", { class: "muted" }, ` level ${pact.level}`)),
        pips(pact.value, pact.max, setSlot(pact)))) : null,
    [...levels].sort((x, y) => x - y).map(level => {
      const slot = slotFor(level);
      const list = byLevel.get(level) ?? [];
      return el("section", { class: "group" },
        el("header", { class: "level-head" },
          el("h2", {}, level === 0 ? "Cantrips" : `Level ${level}`),
          slot ? pips(slot.value, slot.max, setSlot(slot)) : null),
        list.length ? el("ul", { class: "items" }, list.map(spellRow))
          : el("p", { class: "muted empty" }, state.spellFilter === "prepared" ? "Nothing prepared at this level." : "No spells at this level."));
    })
  ];
}

/* -------------------------------------------- */
/*  Inventory                                   */
/* -------------------------------------------- */

function currencyView(a) {
  const coins = ["pp", "gp", "ep", "sp", "cp"];
  return el("div", { class: "currency card" }, coins.map(coin =>
    el("label", { class: `coin ${coin}` },
      el("span", {}, coin.toUpperCase()),
      el("input", {
        type: "number", inputmode: "numeric", min: 0, value: a.currency[coin],
        onchange: e => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n >= 0) act("currency", { [coin]: n }, s => { s.currency[coin] = n; });
          else e.target.value = a.currency[coin];
        }
      }))));
}

function inventoryRow(item) {
  // Consumables are used up by quantity, so their count sits in the always-visible strip.
  const countable = item.type === "consumable" && item.quantity !== undefined;
  return itemRow(item, {
    quick: [
      !countable && item.quantity !== undefined && item.quantity !== 1 ? el("span", { class: "qty" }, `×${item.quantity}`) : null,
      item.equipped !== undefined ? el("button", {
        class: `equip-toggle ${item.equipped ? "on" : ""}`, "aria-pressed": String(item.equipped),
        "aria-label": item.equipped ? `Unequip ${item.name}` : `Equip ${item.name}`, title: item.equipped ? "Equipped" : "Not equipped",
        onclick: () => act("itemEquipped", { itemId: item.id, value: !item.equipped }, () => { item.equipped = !item.equipped; })
      }, icon("shield")) : null
    ],
    usage: [countable ? usageLine("Quantity", null, quantityStepper(item)) : null],
    controls: [!countable && item.quantity !== undefined ? control("Quantity", quantityStepper(item)) : null]
  });
}

function inventoryView(a) {
  const groups = [["weapons", "Weapons"], ["equipment", "Equipment"], ["consumables", "Consumables"], ["tools", "Tools"], ["loot", "Loot & containers"]];
  const any = groups.some(([key]) => a.items[key].length);
  return [
    currencyView(a),
    state.adder?.kind === "item" ? adderView() : addButton("item"),
    requestsView(a, "item"),
    groups.filter(([key]) => a.items[key].length).map(([key, title]) => el("section", { class: "group" },
      el("h2", {}, title),
      el("ul", { class: "items" }, a.items[key].map(inventoryRow)))),
    any
      ? el("p", { class: "muted hint legend" }, icon("shield", "inline"), " toggles equipped. Tap an item for its details.")
      : el("p", { class: "muted empty" }, "No items yet.")
  ];
}

/* -------------------------------------------- */
/*  Features                                    */
/* -------------------------------------------- */

async function rest(type) {
  const long = type === "long";
  const ok = await confirmSheet(long ? "Take a long rest?" : "Take a short rest?",
    long
      ? "Restores hit points, spell slots, hit dice and daily uses in Foundry."
      : "Restores short-rest uses. Spend hit dice with the counters on this tab.",
    { confirm: long ? "Long rest" : "Short rest" });
  if (ok) act("rest", { type });
}

function featuresView(a) {
  return [
    el("section", { class: "rest card" },
      el("div", { class: "button-row" },
        el("button", { onclick: () => rest("short") }, "Short rest"),
        el("button", { onclick: () => rest("long") }, "Long rest")),
      a.classes.map(cls => el("div", { class: "control" },
        el("span", {}, "Hit dice ", el("small", { class: "muted" }, `${cls.name} ${cls.hitDice.denomination}`)),
        counter(cls.hitDice.value, cls.hitDice.max,
          v => act("hitDice", { classId: cls.id, value: v }, () => { cls.hitDice.value = v; }), "hit dice")))),
    el("section", { class: "group" },
      el("h2", {}, "Features"),
      a.items.features.length
        ? el("ul", { class: "items" }, a.items.features.map(item => itemRow(item)))
        : el("p", { class: "muted empty" }, "No features."))
  ];
}

/* -------------------------------------------- */
/*  Trackers                                    */
/* -------------------------------------------- */

function hasTrackers(a) {
  const t = a.trackers;
  return !!t && (t.character.length > 0 || t.party.length > 0 || t.canCreate);
}

function setTracker(tracker, value) {
  act("setTracker", { trackerId: tracker.id, scope: tracker.scope, value }, () => { tracker.value = value; });
}

function trackerControl(t) {
  const locked = !t.canEdit;
  if (t.type === "text") {
    return el("input", {
      type: "text", value: t.value, maxlength: 500, disabled: locked, class: "tracker-text", "aria-label": t.name,
      onchange: e => setTracker(t, e.target.value)
    });
  }
  if (t.type === "pips") {
    if (locked) return el("span", { class: "pips locked" }, Array.from({ length: t.max }, (_, i) => el("span", { class: i < t.value ? "pip on" : "pip" })));
    return pips(t.value, t.max, v => setTracker(t, v));
  }
  const number = el("span", { class: "tracker-number" }, minus(t.value), t.max !== null ? el("small", { class: "muted" }, ` / ${minus(t.max)}`) : null);
  let clock = null;
  if (t.type === "clock") {
    clock = el("span", { class: "clock", "aria-hidden": "true" });
    clock.style.setProperty("--fill", `${Math.round((t.value / t.max) * 360)}deg`);
  }
  if (locked) return el("span", { class: "tracker-value" }, clock, number);
  return el("span", { class: "tracker-value" },
    el("button", { disabled: t.min !== null && t.value <= t.min, onclick: () => setTracker(t, t.value - 1), "aria-label": `Decrease ${t.name}` }, "−"),
    clock, number,
    el("button", { disabled: t.max !== null && t.value >= t.max, onclick: () => setTracker(t, t.value + 1), "aria-label": `Increase ${t.name}` }, "+"));
}

function trackerCard(t) {
  return el("li", { class: "tracker card" },
    el("div", { class: "tracker-head" },
      el("strong", {}, t.name),
      !t.canEdit ? el("span", { class: "chip", title: "Only the GM can change this" }, "GM") : null,
      t.canDelete ? el("button", {
        class: "icon-button tracker-delete", "aria-label": `Delete ${t.name}`,
        onclick: async () => {
          if (await confirmSheet(`Delete ${t.name}?`, null, { confirm: "Delete", danger: true })) act("deleteTracker", { trackerId: t.id });
        }
      }, icon("close")) : null),
    trackerControl(t),
    t.band ? el("p", { class: "tracker-band" }, el("strong", {}, `${t.band.label}. `), t.band.effect) : null,
    t.description ? el("p", { class: "muted tracker-description" }, t.description) : null);
}

function newTrackerForm() {
  const name = el("input", { type: "text", placeholder: "Name", maxlength: 60, required: true, "aria-label": "Name" });
  const type = el("select", { "aria-label": "Type" },
    [["counter", "Counter"], ["pips", "Pips"], ["clock", "Clock"], ["text", "Text"]].map(([v, l]) => el("option", { value: v }, l)));
  // inputmode "numeric" hides the minus key on phones, so these use the full keyboard.
  const min = el("input", { type: "number", step: 1, placeholder: "No min", value: "0", "aria-label": "Minimum" });
  const max = el("input", { type: "number", step: 1, placeholder: "No max", "aria-label": "Maximum" });
  return el("details", { class: "card new-tracker" },
    el("summary", {}, icon("plus"), "New tracker"),
    el("form", {
      onsubmit: event => {
        event.preventDefault();
        if (!name.value.trim()) return;
        const body = { name: name.value.trim(), type: type.value };
        if (max.value !== "") body.max = Number(max.value);
        if (type.value === "counter" && min.value !== "") body.min = Number(min.value);
        act("createTracker", body);
      }
    },
      name, type,
      el("label", { class: "field" }, el("span", { class: "muted" }, "Min"), min),
      el("label", { class: "field" }, el("span", { class: "muted" }, "Max"), max),
      el("button", { type: "submit", class: "primary" }, "Add tracker"),
      el("p", { class: "muted hint" }, "Counters can go negative; clear Min or Max for no limit. Pips and clocks ignore Min and use Max as their size.")));
}

function trackersView(a) {
  const { character, party, canCreate } = a.trackers;
  return [
    el("section", { class: "group" },
      el("h2", {}, "Character"),
      character.length ? el("ul", { class: "trackers" }, character.map(trackerCard)) : el("p", { class: "muted empty" }, "No character trackers."),
      canCreate ? newTrackerForm() : null),
    party.length ? el("section", { class: "group" },
      el("h2", {}, "Party"),
      el("ul", { class: "trackers" }, party.map(trackerCard))) : null
  ];
}

/* -------------------------------------------- */
/*  Start                                       */
/* -------------------------------------------- */

async function start() {
  const saved = storage.get(TAB_KEY);
  state.tab = TABS.some(t => t.key === saved) ? saved : "stats";
  // A sign-in link carries the token in the fragment, which is never sent to the server.
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const linked = fragment.get("token");
  if (linked) history.replaceState(null, "", window.location.pathname + window.location.search);
  const token = linked ?? storage.get(TOKEN_KEY);
  if (token) await signIn(token);
  else render();
}

start();
