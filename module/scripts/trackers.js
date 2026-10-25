/**
 * Custom trackers: counters, pips, clocks, banded counters and text, either on
 * a character or shared by the party.
 *
 * Storage:
 *  - GM templates (world setting "trackerTemplates") define trackers that
 *    appear on every player character or on chosen characters. Their values
 *    live on each actor in flags.player-companion.trackers.<id>.value.
 *  - Personal trackers live entirely on the actor, in the same flag, with
 *    their definition next to the value.
 *  - Party trackers (world setting "worldTrackers") hold definition and value.
 *
 * "Hidden from players" hides a tracker in every player-facing UI and in the
 * web app. Character flags and world settings still reach players' browsers,
 * so it is not a way to keep real secrets.
 */

export const MODULE_ID = "player-companion";
const FLAG = "trackers";
const SOCKET = `module.${MODULE_ID}`;

export const TRACKER_TYPES = {
  counter: "Counter",
  pips: "Pips",
  clock: "Clock",
  bands: "Banded counter",
  text: "Text"
};

const NUMERIC = new Set(["counter", "pips", "clock", "bands"]);
const LIMIT = 9999;

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/* -------------------------------------------- */
/*  Definitions                                 */
/* -------------------------------------------- */

const int = (value, fallback = null) => {
  if (value === "" || value === null || value === undefined) return fallback;
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.max(-LIMIT, Math.min(LIMIT, n)) : fallback;
};
const str = (value, max) => String(value ?? "").trim().slice(0, max);

/**
 * Parse band lines, one per line: "from | label | effect".
 * A band covers its "from" value up to the next band's.
 */
export function parseBands(text) {
  return String(text ?? "").split("\n").map(line => line.split("|").map(s => s.trim()))
    .filter(([from, label]) => from !== undefined && from !== "" && label)
    .map(([from, label, effect]) => ({ from: int(from, 0), label: str(label, 60), effect: str(effect, 300) }))
    .sort((a, b) => a.from - b.from)
    .slice(0, 20);
}

export function formatBands(bands) {
  return (bands ?? []).map(b => [b.from, b.label, b.effect].filter(v => v !== "").join(" | ")).join("\n");
}

/** Clean up a tracker definition from a form or an API call. */
export function normalizeDefinition(input, { scope }) {
  const type = input.type in TRACKER_TYPES ? input.type : "counter";
  const def = {
    id: str(input.id, 32) || foundry.utils.randomID(),
    name: str(input.name, 60) || "Tracker",
    description: str(input.description, 500),
    type,
    min: null,
    max: null,
    bands: [],
    visibility: scope === "world"
      ? (input.visibility === "gm" ? "gm" : "players")
      : (input.visibility === "gm" ? "gm" : "owner"),
    playerEditable: input.playerEditable !== false && input.playerEditable !== "false",
    created: Number(input.created) || Date.now()
  };
  if (type === "pips" || type === "clock") {
    def.min = 0;
    def.max = Math.max(1, Math.min(20, int(input.max, type === "clock" ? 6 : 3)));
  }
  else if (type === "counter" || type === "bands") {
    def.min = int(input.min);
    def.max = int(input.max);
    if (def.min !== null && def.max !== null && def.min > def.max) [def.min, def.max] = [def.max, def.min];
  }
  if (type === "bands") def.bands = Array.isArray(input.bands) ? parseBands(formatBands(input.bands)) : parseBands(input.bands);
  return def;
}

export function clampValue(def, value) {
  if (def.type === "text") return str(value, 500);
  let n = int(value, 0);
  if (def.min !== null) n = Math.max(def.min, n);
  if (def.max !== null) n = Math.min(def.max, n);
  return n;
}

export function defaultValue(def) {
  return def.type === "text" ? "" : clampValue(def, 0);
}

export function bandFor(def, value) {
  if (def.type !== "bands" || !def.bands?.length) return null;
  let match = null;
  for (const band of def.bands) if (value >= band.from) match = band;
  return match ?? def.bands[0];
}

/* -------------------------------------------- */
/*  Reading                                     */
/* -------------------------------------------- */

const templates = () => game.settings.get(MODULE_ID, "trackerTemplates") ?? [];
const worldTrackers = () => game.settings.get(MODULE_ID, "worldTrackers") ?? [];

function templateApplies(template, actor) {
  if (template.appliesTo === "all" || template.appliesTo === undefined) {
    return actor.type === "character" && actor.hasPlayerOwner;
  }
  return Array.isArray(template.appliesTo) && template.appliesTo.includes(actor.id);
}

/** Every tracker on an actor, templates first, each with its current value. */
export function actorTrackers(actor) {
  const stored = actor.getFlag(MODULE_ID, FLAG) ?? {};
  const fromTemplates = templates().filter(t => templateApplies(t, actor)).map(t => ({
    ...t, scope: "actor", source: "template",
    value: clampValue(t, stored[t.id]?.value ?? defaultValue(t))
  }));
  const personal = Object.entries(stored).filter(([, d]) => d?.name).map(([id, d]) => ({
    ...d, id, scope: "actor", source: "personal",
    value: clampValue(d, d.value ?? defaultValue(d))
  })).sort((a, b) => a.created - b.created);
  return [...fromTemplates, ...personal];
}

export function partyTrackers() {
  return worldTrackers().map(t => ({ ...t, scope: "world", source: "world", value: clampValue(t, t.value ?? defaultValue(t)) }));
}

/* -------------------------------------------- */
/*  Permissions                                 */
/* -------------------------------------------- */

export const allowPlayerTrackers = () => game.settings.get(MODULE_ID, "allowPlayerTrackers");

export function canSee(user, tracker) {
  return user.isGM || tracker.visibility !== "gm";
}

export function canEditValue(user, tracker, actor) {
  if (user.isGM) return true;
  if (!canSee(user, tracker) || !tracker.playerEditable) return false;
  return tracker.scope === "world" || !!actor?.testUserPermission(user, "OWNER");
}

export function canManagePersonal(user, actor) {
  return user.isGM || (allowPlayerTrackers() && actor.testUserPermission(user, "OWNER"));
}

/** Trackers as a given user may see them, with what they may do to each. */
export function trackersFor(user, actor) {
  const decorate = tracker => {
    const band = bandFor(tracker, tracker.value);
    return {
      id: tracker.id,
      scope: tracker.scope,
      source: tracker.source,
      name: tracker.name,
      description: tracker.description,
      type: tracker.type,
      min: tracker.min,
      max: tracker.max,
      value: tracker.value,
      band: band ? { label: band.label, effect: band.effect } : null,
      hidden: tracker.visibility === "gm",
      canEdit: canEditValue(user, tracker, actor),
      canDelete: tracker.source === "personal" && !!actor && canManagePersonal(user, actor)
    };
  };
  return {
    character: actor ? actorTrackers(actor).filter(t => canSee(user, t)).map(decorate) : [],
    party: partyTrackers().filter(t => canSee(user, t)).map(decorate),
    canCreate: !!actor && canManagePersonal(user, actor)
  };
}

/* -------------------------------------------- */
/*  Writing                                     */
/*  These run with the current client's rights: */
/*  the GM's browser (and the relay), or a      */
/*  player's browser for their own characters.  */
/* -------------------------------------------- */

export async function setActorValue(actor, trackerId, value) {
  const tracker = actorTrackers(actor).find(t => t.id === trackerId);
  if (!tracker) throw new Error("Tracker not found");
  const clamped = clampValue(tracker, value);
  await actor.update({ [`flags.${MODULE_ID}.${FLAG}.${trackerId}.value`]: clamped });
  return clamped;
}

export async function setWorldValue(trackerId, value) {
  const list = worldTrackers();
  const tracker = list.find(t => t.id === trackerId);
  if (!tracker) throw new Error("Tracker not found");
  if (!game.user.isGM) {
    // Players can't write world settings; the active GM does it for them.
    game.socket.emit(SOCKET, { type: "setWorldValue", userId: game.user.id, trackerId, value });
    return;
  }
  tracker.value = clampValue(tracker, value);
  await game.settings.set(MODULE_ID, "worldTrackers", list);
  return tracker.value;
}

export async function savePersonal(actor, input) {
  const def = normalizeDefinition(input, { scope: "actor" });
  const existing = actor.getFlag(MODULE_ID, FLAG)?.[def.id];
  def.value = clampValue(def, existing?.value ?? input.value ?? defaultValue(def));
  await actor.update({ [`flags.${MODULE_ID}.${FLAG}.${def.id}`]: def });
  return def;
}

export async function deletePersonal(actor, trackerId) {
  await actor.unsetFlag(MODULE_ID, `${FLAG}.${trackerId}`);
}

export async function saveWorldTracker(input) {
  const def = normalizeDefinition(input, { scope: "world" });
  const list = worldTrackers();
  const index = list.findIndex(t => t.id === def.id);
  def.value = clampValue(def, index >= 0 ? list[index].value : defaultValue(def));
  if (index >= 0) list[index] = def;
  else list.push(def);
  await game.settings.set(MODULE_ID, "worldTrackers", list);
  return def;
}

export async function deleteWorldTracker(trackerId) {
  await game.settings.set(MODULE_ID, "worldTrackers", worldTrackers().filter(t => t.id !== trackerId));
}

export async function saveTemplate(input) {
  const def = normalizeDefinition(input, { scope: "actor" });
  def.appliesTo = Array.isArray(input.appliesTo) && input.appliesTo.length ? input.appliesTo : "all";
  const list = templates();
  const index = list.findIndex(t => t.id === def.id);
  if (index >= 0) list[index] = def;
  else list.push(def);
  await game.settings.set(MODULE_ID, "trackerTemplates", list);
  return def;
}

export async function deleteTemplate(templateId) {
  await game.settings.set(MODULE_ID, "trackerTemplates", templates().filter(t => t.id !== templateId));
}

/* -------------------------------------------- */
/*  Editor dialog                               */
/* -------------------------------------------- */

const esc = text => Handlebars.escapeExpression(String(text ?? ""));

/**
 * Ask for a tracker definition. Returns the form data, or null if cancelled.
 * @param {object} [tracker]          Existing definition to edit
 * @param {"actor"|"world"|"template"} kind
 */
async function editDefinition(tracker = {}, kind = "actor") {
  const type = tracker.type ?? "counter";
  const options = Object.entries(TRACKER_TYPES)
    .map(([key, label]) => `<option value="${key}" ${key === type ? "selected" : ""}>${label}</option>`).join("");
  const characters = game.actors.filter(a => a.type === "character" && a.hasPlayerOwner);
  const applies = Array.isArray(tracker.appliesTo) ? tracker.appliesTo : [];
  const visibilityLabel = kind === "world" ? "Visible to players" : "Visible to the character's player";

  const content = `
    <div class="player-companion-tracker-form">
      <div class="form-group"><label>Name</label><div class="form-fields">
        <input type="text" name="name" value="${esc(tracker.name)}" maxlength="60" required autofocus></div></div>
      <div class="form-group"><label>Type</label><div class="form-fields"><select name="type">${options}</select></div></div>
      <div class="form-group"><label>Range</label><div class="form-fields">
        <input type="number" name="min" value="${tracker.min ?? ""}" step="1" placeholder="No min" aria-label="Minimum">
        <span class="pc-range-to">to</span>
        <input type="number" name="max" value="${tracker.max ?? ""}" step="1" placeholder="No max" aria-label="Maximum"></div></div>
      <p class="hint">Counters can go negative, and either end can be left empty. Pips and clocks ignore the minimum and use the maximum as their size (1–20).</p>
      <div class="form-group stacked"><label>Bands (banded counters only)</label>
        <textarea name="bands" rows="4" placeholder="3 | Disciplined | Allies within 30 ft crit on 18+&#10;-1 | In Balance&#10;-3 | Chaos">${esc(formatBands(tracker.bands))}</textarea>
        <p class="hint">One per line: <code>from | name | effect</code>. Each band runs from its number up to the next band.</p></div>
      <div class="form-group stacked"><label>Description</label>
        <textarea name="description" rows="2" maxlength="500">${esc(tracker.description)}</textarea></div>
      ${game.user.isGM ? `
      <div class="form-group"><label>${visibilityLabel}</label><div class="form-fields">
        <input type="checkbox" name="visible" ${tracker.visibility === "gm" ? "" : "checked"}></div></div>
      <div class="form-group"><label>Players can change the value</label><div class="form-fields">
        <input type="checkbox" name="playerEditable" ${tracker.playerEditable === false ? "" : "checked"}></div></div>` : ""}
      ${kind === "template" ? `
      <div class="form-group stacked"><label>Applies to</label>
        <select name="appliesTo" multiple size="${Math.min(6, Math.max(2, characters.length))}">
          ${characters.map(a => `<option value="${a.id}" ${applies.includes(a.id) ? "selected" : ""}>${esc(a.name)}</option>`).join("")}
        </select>
        <p class="hint">Select none to apply to every player character.</p></div>` : ""}
    </div>`;

  return DialogV2.prompt({
    window: { title: tracker.id ? `Edit ${tracker.name}` : "New tracker", icon: "fa-solid fa-list-check" },
    position: { width: 520 },
    content,
    ok: {
      label: "Save",
      callback: (event, button) => {
        const form = button.form;
        const data = {
          id: tracker.id,
          created: tracker.created,
          name: form.elements.name.value,
          type: form.elements.type.value,
          min: form.elements.min.value,
          max: form.elements.max.value,
          bands: form.elements.bands.value,
          description: form.elements.description.value,
          visibility: form.elements.visible && !form.elements.visible.checked ? "gm" : "visible",
          playerEditable: form.elements.playerEditable ? form.elements.playerEditable.checked : true
        };
        if (form.elements.appliesTo) data.appliesTo = [...form.elements.appliesTo.selectedOptions].map(o => o.value);
        return data;
      }
    },
    rejectClose: false
  });
}

/* -------------------------------------------- */
/*  Tracker window                              */
/* -------------------------------------------- */

export class TrackerWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "player-companion-trackers",
    classes: ["player-companion-trackers"],
    window: { title: "Trackers", icon: "fa-solid fa-list-check", resizable: true },
    position: { width: 420, height: "auto" },
    actions: {
      view: TrackerWindow.#onView,
      step: TrackerWindow.#onStep,
      setPip: TrackerWindow.#onSetPip,
      create: TrackerWindow.#onCreate,
      edit: TrackerWindow.#onEdit,
      remove: TrackerWindow.#onRemove
    }
  };

  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/trackers.hbs` } };

  /** "party", "templates" or an actor id. */
  view = "party";

  static open(view) {
    const app = foundry.applications.instances.get(TrackerWindow.DEFAULT_OPTIONS.id) ?? new TrackerWindow();
    if (view) app.view = view;
    app.render({ force: true });
    return app;
  }

  static refresh() {
    const app = foundry.applications.instances.get(TrackerWindow.DEFAULT_OPTIONS.id);
    if (app?.rendered) app.render();
  }

  get actor() {
    return game.actors.get(this.view) ?? null;
  }

  _characters() {
    const user = game.user;
    return game.actors
      .filter(a => a.type === "character" && (user.isGM ? a.hasPlayerOwner : a.testUserPermission(user, "OWNER")))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async _prepareContext() {
    const user = game.user;
    const characters = this._characters();
    if (this.view === "templates" && !user.isGM) this.view = "party";
    if (!["party", "templates"].includes(this.view) && !this.actor) this.view = "party";

    const views = [
      { id: "party", label: "Party" },
      ...characters.map(a => ({ id: a.id, label: a.name })),
      ...(user.isGM ? [{ id: "templates", label: "Templates" }] : [])
    ].map(v => ({ ...v, active: v.id === this.view }));

    const decorate = list => list.map(t => ({
      ...t,
      isText: t.type === "text",
      isPips: t.type === "pips",
      isClock: t.type === "clock",
      isNumber: t.type === "counter" || t.type === "bands",
      pips: t.type === "pips" ? Array.from({ length: t.max }, (_, i) => ({ index: i + 1, on: i < t.value })) : null,
      clockStyle: t.type === "clock" ? `--fill: ${Math.round((t.value / t.max) * 360)}deg` : null,
      // Templates are edited in the Templates view, never per character.
      canManage: t.source !== "template" && (user.isGM || t.canDelete),
      hasMax: t.max !== null,
      canDecrease: t.canEdit && (t.min === null || t.value > t.min),
      canIncrease: t.canEdit && (t.max === null || t.value < t.max)
    }));

    let trackers = [];
    let canCreate = false;
    let emptyText = "No trackers yet.";
    if (this.view === "party") {
      trackers = decorate(trackersFor(user, null).party);
      canCreate = user.isGM;
      emptyText = user.isGM ? "No party trackers yet." : "The GM hasn't shared any party trackers.";
    }
    else if (this.view === "templates") {
      trackers = templates().map(t => ({
        ...t,
        typeLabel: TRACKER_TYPES[t.type],
        appliesLabel: t.appliesTo === "all" ? "All player characters"
          : t.appliesTo.map(id => game.actors.get(id)?.name).filter(Boolean).join(", ") || "Nobody"
      }));
      canCreate = true;
      emptyText = "No templates. A template adds a tracker to every player character, or to the ones you choose.";
    }
    else {
      const result = trackersFor(user, this.actor);
      trackers = decorate(result.character);
      canCreate = result.canCreate;
    }

    return { views, trackers, canCreate, emptyText, isTemplates: this.view === "templates", isGM: user.isGM };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    for (const input of this.element.querySelectorAll("input[data-text-tracker]")) {
      input.addEventListener("change", event => this.#write(event.target.dataset.id, event.target.dataset.scope, event.target.value));
    }
  }

  async #write(trackerId, scope, value) {
    const tracker = scope === "world" ? partyTrackers().find(t => t.id === trackerId)
      : actorTrackers(this.actor).find(t => t.id === trackerId);
    if (!tracker || !canEditValue(game.user, tracker, this.actor)) {
      ui.notifications.warn("You can't change that tracker.");
      return;
    }
    try {
      if (scope === "world") await setWorldValue(trackerId, value);
      else await setActorValue(this.actor, trackerId, value);
    }
    catch (err) {
      ui.notifications.error(err.message);
    }
  }

  #find(target) {
    const { id, scope } = target.closest("[data-id]").dataset;
    const list = scope === "world" ? partyTrackers() : this.view === "templates" ? templates() : actorTrackers(this.actor);
    return list.find(t => t.id === id);
  }

  static #onView(event, target) {
    this.view = target.dataset.view;
    this.render();
  }

  static #onStep(event, target) {
    const tracker = this.#find(target);
    if (!tracker) return;
    const steps = Number(target.dataset.steps) * (event.shiftKey ? 5 : 1);
    this.#write(tracker.id, tracker.scope, tracker.value + steps);
  }

  static #onSetPip(event, target) {
    const tracker = this.#find(target);
    if (!tracker) return;
    const index = Number(target.dataset.index);
    this.#write(tracker.id, tracker.scope, index === tracker.value ? index - 1 : index);
  }

  static async #onCreate() {
    const kind = this.view === "party" ? "world" : this.view === "templates" ? "template" : "actor";
    const data = await editDefinition({}, kind);
    if (!data) return;
    if (kind === "world") await saveWorldTracker(data);
    else if (kind === "template") await saveTemplate(data);
    else await savePersonal(this.actor, data);
  }

  static async #onEdit(event, target) {
    const tracker = this.#find(target);
    if (!tracker) return;
    const kind = this.view === "party" ? "world" : this.view === "templates" ? "template" : "actor";
    const data = await editDefinition(tracker, kind);
    if (!data) return;
    if (kind === "world") await saveWorldTracker(data);
    else if (kind === "template") await saveTemplate(data);
    else await savePersonal(this.actor, data);
  }

  static async #onRemove(event, target) {
    const tracker = this.#find(target);
    if (!tracker) return;
    const confirmed = await DialogV2.confirm({
      window: { title: `Delete ${tracker.name}` },
      content: this.view === "templates"
        ? "<p>Remove this template? Characters keep their stored values, but the tracker disappears from them.</p>"
        : "<p>Delete this tracker?</p>"
    });
    if (!confirmed) return;
    if (this.view === "party") await deleteWorldTracker(tracker.id);
    else if (this.view === "templates") await deleteTemplate(tracker.id);
    else await deletePersonal(this.actor, tracker.id);
  }
}

/* -------------------------------------------- */
/*  Party panel on the canvas                   */
/* -------------------------------------------- */

const PANEL_ID = "player-companion-party-trackers";

export function refreshPanel() {
  let panel = document.getElementById(PANEL_ID);
  const user = game.user;
  const trackers = partyTrackers().filter(t => canSee(user, t));
  if (!game.settings.get(MODULE_ID, "showPartyPanel") || !trackers.length) {
    panel?.remove();
    return;
  }
  if (!panel) {
    panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.addEventListener("click", () => TrackerWindow.open("party"));
    (document.getElementById("interface") ?? document.body).append(panel);
  }
  panel.className = `position-${game.settings.get(MODULE_ID, "partyPanelPosition")}`;
  panel.innerHTML = trackers.map(t => {
    const band = bandFor(t, t.value);
    let value;
    if (t.type === "text") value = esc(t.value || "—");
    else if (t.type === "pips") value = Array.from({ length: t.max }, (_, i) => `<span class="pip ${i < t.value ? "on" : ""}"></span>`).join("");
    else if (t.type === "clock") value = `<span class="clock" style="--fill: ${Math.round((t.value / t.max) * 360)}deg"></span> ${t.value}/${t.max}`;
    else value = `${t.value}${t.max !== null ? `<span class="of">/${t.max}</span>` : ""}`;
    const tip = [t.description, band ? `${band.label}${band.effect ? `: ${band.effect}` : ""}` : ""].filter(Boolean).join(" — ");
    return `<div class="panel-tracker ${t.visibility === "gm" ? "hidden-tracker" : ""}" data-tooltip="${esc(tip)}">
      <span class="name">${esc(t.name)}</span>
      <span class="value">${value}</span>
      ${band ? `<span class="band">${esc(band.label)}</span>` : ""}
    </div>`;
  }).join("");
}

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

export function registerTrackerSettings() {
  const onChange = () => {
    TrackerWindow.refresh();
    refreshPanel();
    Hooks.callAll(`${MODULE_ID}.trackersChanged`);
  };
  game.settings.register(MODULE_ID, "trackerTemplates", { scope: "world", config: false, type: Array, default: [], onChange });
  game.settings.register(MODULE_ID, "worldTrackers", { scope: "world", config: false, type: Array, default: [], onChange });
  game.settings.register(MODULE_ID, "allowPlayerTrackers", {
    name: "Players can create trackers",
    hint: "Lets players add and remove their own trackers on their characters, in Foundry and in the web app. GM templates and party trackers always work.",
    scope: "world", config: true, type: Boolean, default: true, onChange
  });
  game.settings.register(MODULE_ID, "showPartyPanel", {
    name: "Show party trackers on the canvas",
    hint: "A small panel listing the party trackers you can see. Click it for the full trackers window.",
    scope: "client", config: true, type: Boolean, default: true, onChange: refreshPanel
  });
  game.settings.register(MODULE_ID, "partyPanelPosition", {
    name: "Party tracker panel position",
    scope: "client", config: true, type: String, default: "top-right",
    choices: { "top-left": "Top left", "top-right": "Top right", "bottom-left": "Bottom left", "bottom-right": "Bottom right" },
    onChange: refreshPanel
  });
}

export function setupTrackers() {
  Hooks.on("getSceneControlButtons", controls => {
    const tokens = controls.tokens;
    if (!tokens) return;
    tokens.tools.playerCompanionTrackers = {
      name: "playerCompanionTrackers",
      title: "Trackers",
      icon: "fa-solid fa-list-check",
      order: Object.keys(tokens.tools).length,
      button: true,
      visible: true,
      onChange: () => TrackerWindow.open(game.user.character?.id)
    };
  });

  // A "Trackers" button in the title bar of character sheets.
  Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
    const actor = app.document;
    if (!(actor instanceof Actor) || actor.type !== "character") return;
    if (!actor.testUserPermission(game.user, "OWNER")) return;
    app.options.actions.playerCompanionTrackers ??= () => TrackerWindow.open(actor.id);
    controls.push({
      icon: "fa-solid fa-list-check",
      label: "Trackers",
      action: "playerCompanionTrackers",
      onClick: () => TrackerWindow.open(actor.id)
    });
  });

  Hooks.on("updateActor", (actor, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) TrackerWindow.refresh();
  });
  Hooks.on("updateSetting", setting => {
    if (setting.key === `${MODULE_ID}.allowPlayerTrackers`) TrackerWindow.refresh();
  });

  Hooks.once("ready", () => {
    refreshPanel();
    game.socket.on(SOCKET, async message => {
      if (message?.type !== "setWorldValue" || game.user !== game.users.activeGM) return;
      const user = game.users.get(message.userId);
      const tracker = partyTrackers().find(t => t.id === message.trackerId);
      if (!user || !tracker || !canEditValue(user, tracker, null)) return;
      await setWorldValue(tracker.id, message.value);
    });
  });
}
