/**
 * Player web app for Player Companion. No framework: state lives in `state`, and
 * render() rebuilds the page from it. All text goes in through textContent.
 */

const TOKEN_KEY = "player-companion.token";
const ACTOR_KEY = "player-companion.actor";
const TAB_KEY = "player-companion.tab";

const state = {
  token: null,
  me: null,
  actor: null,
  actorId: null,
  tab: "abilities",
  busy: false,
  error: null,
  foundry: true,
  open: new Set(), // expanded item descriptions
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

const signed = n => (n >= 0 ? `+${n}` : `${n}`);

function toast(message, kind = "info") {
  const node = el("div", { class: `toast ${kind}` }, message);
  document.getElementById("toasts").append(node);
  setTimeout(() => node.classList.add("hide"), 4000);
  setTimeout(() => node.remove(), 4600);
}

function banner(message) {
  const node = document.getElementById("banner");
  node.hidden = !message;
  node.textContent = message ?? "";
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

/** Run a change against the current character and show the updated sheet. */
async function act(action, body = {}) {
  if (state.busy) return;
  state.busy = true;
  document.body.classList.add("busy");
  try {
    const data = await api("POST", `actors/${state.actorId}/${action}`, body);
    if (data.notice) {
      state.actor = data.actor;
      toast(data.notice);
    }
    else state.actor = data;
  }
  catch (err) {
    handleError(err);
  }
  finally {
    state.busy = false;
    document.body.classList.remove("busy");
    render();
  }
}

function handleError(err) {
  if (err.status === 401) {
    signOut("That token is no longer valid. Create a new one in Foundry.");
    return;
  }
  if (err.status === 503) state.foundry = false;
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
    else if (msg.type === "actorChanged" && msg.actorId === state.actorId && !state.busy) refresh();
    else if ((msg.type === "trackersChanged" || msg.type === "requestsChanged") && !state.busy) refresh();
    else if (msg.type === "error" && msg.status === 503) setFoundry(false);
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
  storage.set(ACTOR_KEY, id);
  if (id) await refresh();
  else render();
}

/* -------------------------------------------- */
/*  Views                                       */
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
  if (focused) {
    const input = root.querySelector(`[data-focus-key="${focused}"]`);
    input?.focus({ preventScroll: true });
    try { input?.setSelectionRange(...selection); } catch { /* not a text input */ }
  }
  window.scrollTo(0, scrollY);
  root.querySelector(".tabs .active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function loginView() {
  const input = el("input", { type: "password", name: "token", placeholder: "pc_…", autocomplete: "off", required: true });
  return el("section", { class: "card login" },
    el("h1", {}, "Character Sheet"),
    el("p", {}, "Paste the access token from Foundry (Game Settings → Player Companion → New token), or open the sign-in link it gave you."),
    state.error && el("p", { class: "error" }, state.error),
    el("form", {
      onsubmit: event => {
        event.preventDefault();
        if (input.value.trim()) signIn(input.value);
      }
    },
      input,
      el("button", { type: "submit", class: "primary" }, "Sign in"))
  );
}

function pickerView() {
  const { me } = state;
  return el("section", { class: "picker" },
    el("header", { class: "picker-head" },
      el("h1", {}, me.world.title),
      el("button", { class: "ghost", onclick: () => signOut() }, "Sign out")),
    el("p", {}, `Signed in as ${me.user.name}. Choose a character:`),
    me.characters.length
      ? el("ul", { class: "character-list" }, me.characters.map(c =>
        el("li", {},
          el("button", { class: "character-choice", onclick: () => selectActor(c.id) },
            img(c.img),
            el("span", {}, el("strong", {}, c.name), el("small", {}, c.level ? `Level ${c.level}` : c.type))))))
      : el("p", { class: "muted" }, "You don't own any characters yet. Ask the GM to give your user ownership of one.")
  );
}

function sheetView(a) {
  const classes = a.classes.map(c => `${c.name}${c.subclass ? ` (${c.subclass})` : ""} ${c.levels}`).join(" / ");
  const tabs = [
    ["abilities", "Abilities"],
    ["skills", "Skills"],
    a.items.spells.length || a.spellSlots.length || a.spellcasting.ability ? ["spells", "Spells"] : null,
    ["inventory", "Inventory"],
    ["features", "Features"],
    hasTrackers(a) ? ["trackers", "Trackers"] : null
  ].filter(Boolean);
  if (!tabs.some(([key]) => key === state.tab)) state.tab = "abilities";

  return el("div", { class: "sheet" },
    el("header", { class: "sheet-head" },
      img(a.img, "portrait"),
      el("div", { class: "identity" },
        el("h1", {}, a.name),
        el("p", { class: "muted" }, [classes || (a.level ? `Level ${a.level}` : ""), a.species].filter(Boolean).join(" · "))),
      el("button", { class: "ghost", onclick: () => selectActor(null).then(loadMe), "aria-label": "Switch character" }, "⇄")),
    vitalsView(a),
    el("nav", { class: "tabs" }, tabs.map(([key, label]) =>
      el("button", {
        class: state.tab === key ? "active" : "",
        onclick: () => { state.tab = key; state.adder = null; storage.set(TAB_KEY, key); render(); }
      }, label))),
    el("section", { class: "tab-body" }, {
      abilities: () => abilitiesView(a),
      skills: () => skillsView(a),
      spells: () => spellsView(a),
      inventory: () => inventoryView(a),
      features: () => featuresView(a),
      trackers: () => trackersView(a)
    }[state.tab]()),
    el("footer", { class: "sheet-foot" },
      el("button", { class: "ghost", onclick: () => signOut() }, `Sign out ${state.me.user.name}`))
  );
}

function stepper(value, onChange, { min = 0, max = Infinity, label } = {}) {
  return el("span", { class: "stepper", "aria-label": label },
    el("button", { disabled: value <= min, onclick: () => onChange(value - 1), "aria-label": "Decrease" }, "−"),
    el("span", { class: "value" }, String(value)),
    el("button", { disabled: value >= max, onclick: () => onChange(value + 1), "aria-label": "Increase" }, "+"));
}

function vitalsView(a) {
  const amount = el("input", { type: "number", inputmode: "numeric", min: 0, placeholder: "Amount", class: "amount" });
  const readAmount = () => {
    const n = Number(amount.value);
    if (!Number.isInteger(n) || n <= 0) { toast("Enter an amount first"); return null; }
    return n;
  };
  const pct = a.hp.max ? Math.max(0, Math.min(100, (a.hp.value / a.hp.max) * 100)) : 0;
  const bar = el("div", { class: "hp-bar-fill" });
  bar.style.width = `${pct}%`;
  if (pct <= 25) bar.classList.add("low");

  const setExact = (field, current, label) => {
    const answer = window.prompt(label, String(current));
    if (answer === null) return;
    const n = Number(answer);
    if (!Number.isInteger(n) || n < 0) return toast("Enter a whole number", "error");
    act("hp", { [field]: n });
  };

  return el("section", { class: "vitals card" },
    el("div", { class: "hp" },
      el("button", { class: "hp-value", onclick: () => setExact("value", a.hp.value, "Current hit points") },
        el("span", { class: "big" }, String(a.hp.value)),
        el("span", { class: "muted" }, ` / ${a.hp.max + a.hp.tempmax}`),
        a.hp.temp ? el("span", { class: "temp" }, ` +${a.hp.temp} temp`) : null),
      el("div", { class: "hp-bar" }, bar),
      el("div", { class: "hp-actions" },
        amount,
        el("button", { class: "danger", onclick: () => { const n = readAmount(); if (n) act("hp", { damage: n }); } }, "Damage"),
        el("button", { class: "heal", onclick: () => { const n = readAmount(); if (n) act("hp", { heal: n }); } }, "Heal"),
        el("button", { class: "ghost", onclick: () => setExact("temp", a.hp.temp, "Temporary hit points") }, "Temp"))),
    el("div", { class: "stats" },
      stat("AC", a.ac),
      stat("Init", signed(a.initiative)),
      stat("Speed", `${a.speed.walk}${a.speed.units === "ft" ? " ft" : ` ${a.speed.units}`}`),
      stat("Prof", signed(a.proficiency)),
      a.spellcasting.dc ? stat("DC", a.spellcasting.dc) : null),
    el("div", { class: "toggles" },
      el("label", { class: "check" },
        el("input", { type: "checkbox", checked: a.inspiration, onchange: e => act("inspiration", { value: e.target.checked }) }),
        "Heroic Inspiration"),
      el("span", { class: "exhaustion" }, "Exhaustion ",
        stepper(a.exhaustion, v => act("exhaustion", { value: v }), { max: 10, label: "Exhaustion" }))),
    a.conditions.length ? el("p", { class: "conditions" }, a.conditions.map(c => el("span", { class: "chip" }, c))) : null,
    a.hp.value === 0 ? deathSavesView(a) : null
  );
}

function stat(label, value) {
  return el("div", { class: "stat" }, el("span", { class: "label" }, label), el("span", { class: "num" }, String(value)));
}

function pips(value, max, onSet, kind = "") {
  return el("span", { class: `pips ${kind}` }, Array.from({ length: max }, (_, i) =>
    el("button", {
      class: i < value ? "pip on" : "pip",
      "aria-label": `${i + 1} of ${max}`,
      // Tapping the last filled pip empties it; any other pip fills up to it.
      onclick: () => onSet(i + 1 === value ? i : i + 1)
    })));
}

function deathSavesView(a) {
  return el("div", { class: "death" },
    el("strong", {}, "Death saves"),
    el("span", {}, "Successes ", pips(a.death.success, 3, v => act("deathSaves", { success: v }), "good")),
    el("span", {}, "Failures ", pips(a.death.failure, 3, v => act("deathSaves", { failure: v }), "bad")));
}

function abilitiesView(a) {
  return el("div", { class: "abilities" }, a.abilities.map(ab =>
    el("div", { class: "ability card", "aria-label": ab.label },
      el("span", { class: "abbr" }, ab.abbreviation.toUpperCase()),
      el("span", { class: "mod" }, signed(ab.mod)),
      el("span", { class: "score muted" }, String(ab.value)),
      el("span", { class: `save ${ab.proficient ? "prof" : ""}`, title: ab.proficient ? "Proficient" : null }, `Save ${signed(ab.save)}`))));
}

function skillsView(a) {
  const marks = { 0: "○", 0.5: "◐", 1: "●", 2: "◉" };
  return el("ul", { class: "skills" }, a.skills.map(s =>
    el("li", { class: "skill" },
      el("span", { class: `prof-mark p${String(s.proficiency).replace(".", "")}` }, marks[s.proficiency] ?? "○"),
      el("span", { class: "name" }, s.label, el("small", { class: "muted" }, ` ${s.ability.toUpperCase()}`)),
      el("span", { class: "passive muted", title: "Passive" }, `(${s.passive})`),
      el("span", { class: "total" }, signed(s.total)))));
}

function itemRow(item, extras = []) {
  const open = state.open.has(item.id);
  return el("li", { class: "item" },
    el("div", { class: "item-main" },
      el("button", {
        class: "item-name",
        onclick: () => { open ? state.open.delete(item.id) : state.open.add(item.id); render(); }
      }, img(item.img), el("span", {}, item.name)),
      el("div", { class: "item-controls" }, extras)),
    open && item.description ? el("p", { class: "description" }, item.description) : null,
    open ? removeButton(item) : null);
}

/* -------------------------------------------- */
/*  Adding and removing items                   */
/* -------------------------------------------- */

const changesMode = () => state.actor?.itemChanges?.mode ?? "off";

function removeButton(item) {
  if (!item.removable || changesMode() === "off") return null;
  const approve = changesMode() === "approve";
  const pending = state.actor.itemChanges.requests.some(r => r.kind === "remove" && r.itemId === item.id && r.status === "pending");
  if (pending) return el("p", { class: "muted item-actions" }, "Waiting for the GM to approve removing this.");
  return el("div", { class: "item-actions" },
    el("button", {
      class: "ghost danger-text",
      onclick: () => window.confirm(approve ? `Ask the GM to remove ${item.name}?` : `Remove ${item.name}?`)
        && act("removeItem", { itemId: item.id })
    }, approve ? "Ask GM to remove" : "Remove"));
}

/** Pending and denied requests for one tab ("spell" or "item"). */
function requestsView(a, kind) {
  const list = (a.itemChanges?.requests ?? []).filter(r => (r.type === "spell") === (kind === "spell"));
  if (!list.length) return null;
  return el("section", { class: "requests card" },
    el("h2", {}, "Requests"),
    el("ul", { class: "items" }, list.map(r =>
      el("li", { class: `request ${r.status}` },
        img(r.img),
        el("span", { class: "request-text" },
          el("strong", {}, r.kind === "add" ? "Add " : "Remove "),
          r.quantity > 1 ? `${r.name} ×${r.quantity}` : r.name,
          el("small", { class: "muted" }, r.status === "pending" ? " · waiting for the GM" : ` · ${r.reason ? `couldn't be done: ${r.reason}` : "the GM said no"}`)),
        el("button", {
          class: "ghost", onclick: () => act("cancelItemRequest", { requestId: r.id })
        }, r.status === "pending" ? "Withdraw" : "Dismiss")))));
}

function addButton(kind) {
  if (changesMode() === "off") return null;
  return el("button", {
    class: "add-button",
    onclick: () => { openAdder(kind); }
  }, kind === "spell" ? "+ Add spell" : "+ Add item");
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

function adderView(a) {
  const adder = state.adder;
  const isSpell = adder.kind === "spell";
  const approve = changesMode() === "approve";
  const setFilter = (key, value) => { adder[key] = value; searchItems(); };

  const filters = el("div", { class: "adder-filters" },
    el("input", {
      type: "search", placeholder: isSpell ? "Search spells" : "Search items", value: adder.query,
      dataset: { focusKey: "adder-query" }, autocomplete: "off", enterkeyhint: "search",
      oninput: e => { adder.query = e.target.value; queueSearch(); }
    }),
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
        return el("li", { class: "item" },
          el("div", { class: "item-main" },
            el("button", { class: "item-name", onclick: () => toggleResult(r.uuid) },
              img(r.img),
              el("span", {}, r.name, el("small", { class: "muted result-meta" }, meta.filter(Boolean).join(" · ")))),
            el("div", { class: "item-controls" },
              el("button", { class: "primary", onclick: () => act("addItem", { uuid: r.uuid }) }, approve ? "Ask GM" : "Add"))),
          open ? el("p", { class: "description" }, details ? details.description || "No description." : "Loading…") : null);
      })),
      adder.total > adder.results.length
        ? el("p", { class: "muted hint" }, `Showing ${adder.results.length} of ${adder.total}. Type more of the name to narrow it down.`)
        : null
    ];
  }

  return el("section", { class: `adder card ${adder.loading ? "loading" : ""}` },
    el("header", { class: "adder-head" },
      el("h2", {}, isSpell ? "Add a spell" : "Add an item"),
      el("button", { class: "ghost", onclick: () => { state.adder = null; render(); }, "aria-label": "Close" }, "✕")),
    approve ? el("p", { class: "muted hint" }, "The GM approves each addition before it reaches your sheet.") : null,
    filters,
    body);
}

/** The add button, or the search panel when it's open for this tab. */
function adderSlot(a, kind) {
  return state.adder?.kind === kind ? adderView(a) : addButton(kind);
}

function usesControl(item) {
  if (!item.uses) return null;
  return el("span", { class: "uses" },
    el("small", { class: "muted" }, "Uses "),
    stepper(item.uses.value, v => act("itemUses", { itemId: item.id, value: v }), { max: item.uses.max, label: "Uses" }),
    el("small", { class: "muted" }, `/${item.uses.max}`));
}

function spellsView(a) {
  const byLevel = new Map();
  for (const spell of a.items.spells) {
    if (!byLevel.has(spell.level)) byLevel.set(spell.level, []);
    byLevel.get(spell.level).push(spell);
  }
  const levels = [...byLevel.keys()].sort((x, y) => x - y);
  return [
    adderSlot(a, "spell"),
    requestsView(a, "spell"),
    a.spellSlots.length ? el("div", { class: "slots card" },
      el("h2", {}, "Spell slots"),
      a.spellSlots.map(slot =>
        el("div", { class: "slot-row" },
          el("span", {}, slot.label),
          pips(slot.value, slot.max, v => act("spellSlot", { slot: slot.key, value: v }))))) : null,
    a.spellcasting.dc ? el("p", { class: "muted" },
      `Spell save DC ${a.spellcasting.dc}${a.spellcasting.attack ? ` · attack ${signed(a.spellcasting.attack)}` : ""}`) : null,
    levels.map(level => el("section", { class: "group" },
      el("h2", {}, level === 0 ? "Cantrips" : `Level ${level}`),
      el("ul", { class: "items" }, byLevel.get(level).map(spell => itemRow(spell, [
        spell.concentration ? el("span", { class: "chip", title: "Concentration" }, "C") : null,
        spell.ritual ? el("span", { class: "chip", title: "Ritual" }, "R") : null,
        usesControl(spell),
        spell.preparation?.toggleable
          ? el("label", { class: "check" },
            el("input", { type: "checkbox", checked: spell.preparation.prepared,
              onchange: e => act("spellPrepared", { itemId: spell.id, value: e.target.checked }) }), "Prepared")
          : spell.level > 0 && spell.preparation?.mode && spell.preparation.mode !== "prepared" && spell.preparation.mode !== "spell"
            ? el("span", { class: "chip" }, spell.preparation.mode)
            : null
      ])))))
  ];
}

function currencyView(a) {
  const coins = ["pp", "gp", "ep", "sp", "cp"];
  return el("div", { class: "currency card" }, coins.map(coin =>
    el("label", {},
      el("span", {}, coin.toUpperCase()),
      el("input", {
        type: "number", inputmode: "numeric", min: 0, value: a.currency[coin],
        onchange: e => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n >= 0) act("currency", { [coin]: n });
        }
      }))));
}

function inventoryView(a) {
  const groups = [["weapons", "Weapons"], ["equipment", "Equipment"], ["consumables", "Consumables"], ["tools", "Tools"], ["loot", "Loot & containers"]];
  return [
    currencyView(a),
    adderSlot(a, "item"),
    requestsView(a, "item"),
    groups.filter(([key]) => a.items[key].length).map(([key, title]) => el("section", { class: "group" },
      el("h2", {}, title),
      el("ul", { class: "items" }, a.items[key].map(item => itemRow(item, [
        usesControl(item),
        item.equipped !== undefined
          ? el("label", { class: "check" },
            el("input", { type: "checkbox", checked: item.equipped,
              onchange: e => act("itemEquipped", { itemId: item.id, value: e.target.checked }) }), "Equipped")
          : null,
        item.quantity !== undefined
          ? el("span", { class: "uses" }, el("small", { class: "muted" }, "Qty "),
            stepper(item.quantity, v => act("itemQuantity", { itemId: item.id, value: v }), { label: "Quantity" }))
          : null
      ])))))
  ];
}

function featuresView(a) {
  return [
    el("div", { class: "rest card" },
      el("h2", {}, "Rest"),
      a.classes.map(cls => el("div", { class: "slot-row" },
        el("span", {}, `Hit dice (${cls.name} ${cls.hitDice.denomination})`),
        stepper(cls.hitDice.value, v => act("hitDice", { classId: cls.id, value: v }), { max: cls.hitDice.max }))),
      el("div", { class: "rest-buttons" },
        el("button", { onclick: () => window.confirm("Take a short rest?") && act("rest", { type: "short" }) }, "Short rest"),
        el("button", { onclick: () => window.confirm("Take a long rest?") && act("rest", { type: "long" }) }, "Long rest")),
      el("p", { class: "muted hint" }, "Short rests don't spend hit dice here. Lower the count above for the dice you spend at the table.")),
    el("section", { class: "group" },
      el("h2", {}, "Features"),
      a.items.features.length
        ? el("ul", { class: "items" }, a.items.features.map(item => itemRow(item, [usesControl(item)])))
        : el("p", { class: "muted" }, "No features."))
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
  act("setTracker", { trackerId: tracker.id, scope: tracker.scope, value });
}

function trackerControl(t) {
  const locked = !t.canEdit;
  if (t.type === "text") {
    return el("input", {
      type: "text", value: t.value, maxlength: 500, disabled: locked, class: "tracker-text",
      onchange: e => setTracker(t, e.target.value)
    });
  }
  if (t.type === "pips") {
    if (locked) return el("span", { class: "pips locked" }, Array.from({ length: t.max }, (_, i) => el("span", { class: i < t.value ? "pip on" : "pip" })));
    return pips(t.value, t.max, v => setTracker(t, v));
  }
  const number = el("span", { class: "tracker-number" }, String(t.value), t.max !== null ? el("small", { class: "muted" }, `/${t.max}`) : null);
  let clock = null;
  if (t.type === "clock") {
    clock = el("span", { class: "clock", "aria-hidden": "true" });
    clock.style.setProperty("--fill", `${Math.round((t.value / t.max) * 360)}deg`);
  }
  if (locked) return el("span", { class: "tracker-value" }, clock, number);
  return el("span", { class: "tracker-value" },
    el("button", { disabled: t.min !== null && t.value <= t.min, onclick: () => setTracker(t, t.value - 1), "aria-label": "Decrease" }, "−"),
    clock, number,
    el("button", { disabled: t.max !== null && t.value >= t.max, onclick: () => setTracker(t, t.value + 1), "aria-label": "Increase" }, "+"));
}

function trackerCard(t) {
  return el("li", { class: "tracker card" },
    el("div", { class: "tracker-head" },
      el("strong", {}, t.name),
      !t.canEdit ? el("span", { class: "chip", title: "Only the GM can change this" }, "GM") : null,
      t.canDelete ? el("button", {
        class: "ghost tracker-delete", "aria-label": `Delete ${t.name}`,
        onclick: () => window.confirm(`Delete ${t.name}?`) && act("deleteTracker", { trackerId: t.id })
      }, "✕") : null),
    trackerControl(t),
    t.band ? el("p", { class: "tracker-band" }, el("strong", {}, `${t.band.label}. `), t.band.effect) : null,
    t.description ? el("p", { class: "muted tracker-description" }, t.description) : null);
}

function newTrackerForm() {
  const name = el("input", { type: "text", placeholder: "Name", maxlength: 60, required: true });
  const type = el("select", {},
    [["counter", "Counter"], ["pips", "Pips"], ["clock", "Clock"], ["text", "Text"]].map(([v, l]) => el("option", { value: v }, l)));
  // inputmode "numeric" hides the minus key on phones, so these use the full keyboard.
  const min = el("input", { type: "number", step: 1, placeholder: "No min", value: "0", "aria-label": "Minimum" });
  const max = el("input", { type: "number", step: 1, placeholder: "No max", "aria-label": "Maximum" });
  return el("details", { class: "card new-tracker" },
    el("summary", {}, "New tracker"),
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
      el("button", { type: "submit", class: "primary" }, "Add"),
      el("p", { class: "muted hint" }, "Counters can go negative; clear Min or Max for no limit. Pips and clocks ignore Min and use Max as their size.")));
}

function trackersView(a) {
  const { character, party, canCreate } = a.trackers;
  return [
    el("section", { class: "group" },
      el("h2", {}, a.name),
      character.length ? el("ul", { class: "trackers" }, character.map(trackerCard)) : el("p", { class: "muted" }, "No character trackers."),
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
  state.tab = storage.get(TAB_KEY) ?? "abilities";
  // A sign-in link carries the token in the fragment, which is never sent to the server.
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const linked = fragment.get("token");
  if (linked) history.replaceState(null, "", window.location.pathname + window.location.search);
  const token = linked ?? storage.get(TOKEN_KEY);
  if (token) await signIn(token);
  else render();
}

start();
