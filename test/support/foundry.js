/**
 * A small simulated Foundry VTT + dnd5e world, enough to load the real module
 * code (module/scripts) in Node and drive it through the relay.
 *
 * It copies the shapes the module reads, not Foundry's behaviour in general:
 * documents with update/delete that fire the same hooks, world settings with
 * onChange, compendium packs with indexes, chat messages, and dnd5e's prepared
 * labels. Call installFoundry() before importing any module file.
 */

import { parseHTML } from "linkedom";

let nextId = 0;
const randomID = () => `id${(++nextId).toString().padStart(14, "0")}`;

function setPath(target, path, value) {
  const keys = path.split(".");
  let node = target;
  while (keys.length > 1) {
    const key = keys.shift();
    node = node[key] ??= {};
  }
  node[keys[0]] = value;
}

function deleteProperty(target, path) {
  const keys = path.split(".");
  let node = target;
  while (keys.length > 1) {
    const key = keys.shift();
    node = node?.[key];
  }
  if (node && keys[0] in node) delete node[keys[0]];
}

/** Foundry's Collection: a Map with array helpers. */
export class Collection extends Map {
  find(fn) { for (const v of this.values()) if (fn(v)) return v; }
  filter(fn) { return [...this.values()].filter(fn); }
  some(fn) { return [...this.values()].some(fn); }
  map(fn) { return [...this.values()].map(fn); }
  get contents() { return [...this.values()]; }
  [Symbol.iterator]() { return this.values(); }
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

const handlers = new Map();
export const Hooks = {
  on(name, fn) { (handlers.get(name) ?? handlers.set(name, []).get(name)).push(fn); },
  once(name, fn) { this.on(name, fn); },
  callAll(name, ...args) { for (const fn of handlers.get(name) ?? []) fn(...args); return true; },
  call(name, ...args) { return this.callAll(name, ...args); }
};

/* -------------------------------------------- */
/*  Documents                                   */
/* -------------------------------------------- */

class Document {
  toObject() { return structuredClone(plain(this)); }
}

/** A document's own data, without methods or its parent. */
function plain(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (typeof v !== "function" && k !== "parent") out[k] = v;
  return out;
}

export class Item extends Document {
  constructor(data, parent = null) {
    super();
    Object.assign(this, { system: {}, labels: {}, flags: {}, _stats: { modifiedTime: Date.now() } }, structuredClone(data));
    this.id ??= this._id ?? randomID();
    this.parent = parent;
    if (this.system.activities) {
      const list = this.system.activities;
      this.system.activities = new Collection(list.map(a => [a.id, Object.assign(a, {
        update: async changes => { for (const [p, v] of Object.entries(changes)) setPath(a, p, v); this.touch(); }
      })]));
    }
  }

  get uuid() { return this.pack ? `Compendium.${this.pack}.Item.${this.id}` : `${this.parent ? `Actor.${this.parent.id}.` : ""}Item.${this.id}`; }
  get isEmbedded() { return !!this.parent; }
  get actor() { return this.parent; }
  getRollData() { return { mod: 3, prof: 3, ...(this.parent?.rollData ?? {}) }; }
  testUserPermission(user, level) { return this.parent ? this.parent.testUserPermission(user, level) : user.isGM; }
  touch() { this._stats.modifiedTime = Date.now() + (++nextId); }

  async update(changes) {
    for (const [path, value] of Object.entries(changes)) setPath(this, path, value);
    this.touch();
    Hooks.callAll("updateItem", this, changes);
    return this;
  }

  async delete() {
    this.parent?.items.delete(this.id);
    Hooks.callAll("deleteItem", this);
  }

  /** dnd5e's Item5e.createWithContents, without containers' contents. */
  static async createWithContents(items, { transformFirst } = {}) {
    const out = [];
    for (const item of items) {
      const data = transformFirst ? await transformFirst(item) : item.toObject();
      if (data) out.push({ ...data, _id: randomID() });
    }
    return out;
  }

  static async createDocuments(list, { parent }) {
    return list.map(data => {
      const item = new Item({ ...data, id: data._id }, parent);
      parent.items.set(item.id, item);
      Hooks.callAll("createItem", item);
      return item;
    });
  }
}

export class Actor extends Document {
  constructor(data) {
    super();
    const { items = [], ...rest } = structuredClone(data);
    Object.assign(this, { flags: {}, statuses: new Set(), owners: new Set(), _stats: { modifiedTime: Date.now() } }, rest);
    this.items = new Collection();
    for (const item of items) this.items.set(item.id, new Item(item, this));
  }

  get uuid() { return `Actor.${this.id}`; }
  get hasPlayerOwner() { return this.owners.size > 0; }
  get classes() { return Object.fromEntries(this.items.filter(i => i.type === "class").map(c => [c.name.toLowerCase(), c])); }
  get spellcastingClasses() { return Object.fromEntries(Object.entries(this.classes).filter(([, c]) => c.spellcasting)); }

  /** dnd5e's map of items by compendium source. */
  get sourcedItems() {
    return { get: id => {
      const found = this.items.filter(i => i._stats?.compendiumSource === id);
      return { filter: fn => ({ first: () => found.filter(fn)[0] ?? null }) };
    } };
  }

  testUserPermission(user) { return user.isGM || this.owners.has(user.id); }
  getFlag(scope, key) { return foundry.utils.getProperty(this.flags[scope] ?? {}, key); }
  async setFlag(scope, key, value) { return this.update({ [`flags.${scope}.${key}`]: value }); }
  async unsetFlag(scope, key) {
    deleteProperty(this.flags[scope] ?? {}, key);
    Hooks.callAll("updateActor", this, { flags: { [scope]: {} } });
  }

  async update(changes) {
    for (const [path, value] of Object.entries(changes)) setPath(this, path, value);
    this._stats.modifiedTime = Date.now() + (++nextId);
    Hooks.callAll("updateActor", this, changes);
    return this;
  }

  async shortRest() { return {}; }
  async longRest() {
    await this.update({ "system.attributes.hp.value": this.system.attributes.hp.max });
    return {};
  }
}

export class User {
  constructor({ id, name, isGM = false }) {
    Object.assign(this, { id, name, isGM, flags: {}, color: { css: "#c0392b" }, character: null });
  }
  getFlag(scope, key) { return foundry.utils.getProperty(this.flags[scope] ?? {}, key); }
  async setFlag(scope, key, value) {
    const current = this.getFlag(scope, key);
    const merged = current && typeof current === "object" && typeof value === "object" ? { ...current, ...value } : value;
    setPath(this.flags, `${scope}.${key}`, merged);
    Hooks.callAll("updateUser", this, { flags: { [scope]: { [key]: value } } });
  }
  async unsetFlag(scope, key) {
    deleteProperty(this.flags[scope] ?? {}, key);
    Hooks.callAll("updateUser", this, { flags: { [scope]: {} } });
  }
}

/* -------------------------------------------- */
/*  Settings, packs, chat                       */
/* -------------------------------------------- */

function createSettings(initial) {
  const values = new Map(Object.entries(initial));
  const config = new Map();
  return {
    values,
    register(module, key, options) {
      config.set(key, options);
      if (!values.has(key)) values.set(key, structuredClone(options.default));
    },
    registerMenu() {},
    get(module, key) { return structuredClone(values.get(key)); },
    async set(module, key, value) {
      // Like Foundry, the new value is only visible once the "server" answers.
      await new Promise(resolve => setTimeout(resolve, 5));
      values.set(key, structuredClone(value));
      config.get(key)?.onChange?.(value);
      return value;
    }
  };
}

function createPack(collection, title, entries, { observer = true } = {}) {
  const docs = entries.map(e => Object.assign(new Item(e), { pack: collection }));
  return {
    collection, title, documentName: "Item", metadata: { label: title }, docs,
    testUserPermission: user => user.isGM || observer,
    async getIndex() {
      return new Collection(docs.map(d => [d.id, { _id: d.id, uuid: d.uuid, name: d.name, img: d.img, type: d.type, system: d.system }]));
    }
  };
}

/* -------------------------------------------- */
/*  The world                                   */
/* -------------------------------------------- */

/** An enricher shaped like Foundry core's and dnd5e's output for the markup the fixtures use. */
async function enrichHTML(html, { secrets } = {}) {
  let out = html
    .replace(/\[\[\/r(?:oll)?\s+([^\]]+)\]\](?:\{([^}]+)\})?/g, (m, f, label) =>
      `<a class="inline-roll roll" data-formula="${f.trim()}"><i class="fas fa-dice-d20"></i>${label ?? f.trim()}</a>`)
    .replace(/\[\[\/save\s+(\w+)\s+(\d+)\]\]/g, (m, a, dc) =>
      `<span class="roll-link-group" data-type="save"><a class="roll-action"><i class="fa-solid fa-dice-d20"></i> DC ${dc} ${a.toUpperCase()}</a><a class="enricher-action"><i class="fa-solid fa-comment"></i></a></span>`)
    .replace(/@UUID\[([^\]]+)\]\{([^}]+)\}/g, (m, u, l) => `<a class="content-link" data-uuid="${u}"><i class="fas fa-suitcase"></i>${l}</a>`);
  if (!secrets) out = out.replace(/<section class="secret"[^>]*>[\s\S]*?<\/section>/g, "");
  return out;
}

/**
 * Install the globals the module expects and build a world:
 * a GM, two players, Ursula's character Isen (Cleric 5 / Wizard 2), compendiums and trackers.
 */
export function installFoundry({ relayUrl = "", relaySecret = "" } = {}) {
  // dnd5e's trait label helper, for the keys the fixtures use.
  const traitLabels = { lgt: "Light Armor", sim: "Simple Weapons", thief: "Thieves' Tools" };
  globalThis.dnd5e = { documents: { Trait: { keyLabel: key => traitLabels[key] ?? key } } };
  const { document, DOMParser } = parseHTML("<!doctype html><html><body><div id=\"interface\"></div></body></html>");
  Object.assign(globalThis, {
    document, DOMParser, Hooks, Actor, Item, User,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    window: { location: { origin: "https://foundry.test" } },
    Handlebars: { escapeExpression: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") },
    Roll: { replaceFormulaData: (f, data) => f.replace(/@(\w+)/g, (m, k) => data[k] ?? 0) },
    ui: { notifications: { info() {}, warn() {}, error() {} } }
  });

  class ApplicationV2 { static DEFAULT_OPTIONS = {}; render() {} }
  globalThis.foundry = {
    applications: {
      api: { ApplicationV2, HandlebarsApplicationMixin: Base => class extends Base {}, DialogV2: {} },
      ux: { TextEditor: { implementation: { enrichHTML } } },
      instances: new Map()
    },
    abstract: { Document },
    utils: {
      randomID, deleteProperty,
      getProperty: (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj),
      hasProperty: (obj, path) => path.split(".").reduce((o, k) => (o && k in o ? o[k] : undefined), obj) !== undefined,
      isEmpty: o => !o || !Object.keys(o).length,
      fromUuid: async uuid => world.packs.flatMap(p => p.docs).find(d => d.uuid === uuid) ?? null
    }
  };

  globalThis.CONFIG = {
    Item: {
      documentClass: Item,
      typeLabels: { weapon: "Weapon", equipment: "Equipment", consumable: "Consumable", container: "Container", spell: "Spell", loot: "Loot", tool: "Tool" },
      dataModels: { spell: { onDropCreate: (event, actor, data) => { data.system.method = "spell"; } } }
    },
    DND5E: {
      abilities: { str: { label: "Strength", abbreviation: "str" }, dex: { label: "Dexterity", abbreviation: "dex" }, con: { label: "Constitution", abbreviation: "con" },
        int: { label: "Intelligence", abbreviation: "int" }, wis: { label: "Wisdom", abbreviation: "wis" }, cha: { label: "Charisma", abbreviation: "cha" } },
      skills: { prc: { label: "Perception", ability: "wis" }, ste: { label: "Stealth", ability: "dex" } },
      spellSchools: { evo: { label: "Evocation" } },
      movementTypes: { walk: { label: "Speed" }, burrow: { label: "Burrow" }, climb: { label: "Climb" }, fly: { label: "Fly" }, jump: { label: "Jump" }, swim: { label: "Swim" } },
      conditionTypes: { exhaustion: { levels: 6 }, poisoned: { label: "Poisoned" }, frightened: { label: "Frightened" } },
      senses: { blindsight: { label: "Blindsight" }, darkvision: { label: "Darkvision" }, tremorsense: { label: "Tremorsense" }, truesight: { label: "Truesight" } },
      damageTypes: { bludgeoning: { label: "Bludgeoning", isPhysical: true }, fire: { label: "Fire" }, poison: { label: "Poison" }, slashing: { label: "Slashing", isPhysical: true } },
      itemProperties: { mgc: { label: "Magical" }, sil: { label: "Silvered" } },
      actorSizes: { med: { label: "Medium" } },
      movementUnits: { ft: { abbreviation: "ft" } },
      currencies: { gp: { abbreviation: "gp" } },
      itemRarity: { common: "Common", rare: "Rare" },
      weaponMasteries: { push: { label: "Push" } },
      limitedUsePeriods: { lr: { label: "Long Rest" }, sr: { label: "Short Rest" } },
      weightUnits: { lb: { abbreviation: "lb" } }
    }
  };

  const gm = new User({ id: "gm", name: "GM", isGM: true });
  const ursula = new User({ id: "ursula", name: "Ursula" });
  const other = new User({ id: "other", name: "Other" });
  const users = new Collection([gm, ursula, other].map(u => [u.id, u]));

  const isen = new Actor({
    id: "isen", name: "Isen Frostborn", type: "character", img: "systems/dnd5e/isen.webp",
    owners: new Set(["ursula"]),
    statuses: new Set(["poisoned"]),
    system: {
      details: { level: 7, race: { name: "Human" } },
      attributes: {
        hp: { value: 30, max: 44, temp: 5, tempmax: 0 }, ac: { value: 16 }, init: { total: 3 }, prof: 3,
        movement: { speeds: { walk: 30, fly: 0, swim: 30, jump: 7 }, units: "ft", hover: false, special: "" },
        spellcasting: "wis", spell: { dc: 14, attack: 6 }, death: { success: 0, failure: 0 }, inspiration: false, exhaustion: 0,
        senses: { ranges: { darkvision: 60, blindsight: null }, units: "ft", special: "Sees invisible within 5 ft" }
      },
      traits: {
        size: "med",
        dr: { value: new Set(["fire", "bludgeoning"]), bypasses: new Set(["mgc", "sil"]), custom: "" },
        di: { value: new Set(["poison"]), bypasses: new Set(), custom: "" },
        dv: { value: new Set(), bypasses: new Set(), custom: "" },
        dm: { amount: { slashing: "-3", fire: "" } },
        ci: { value: new Set(["frightened"]), custom: "Charmed by fey" },
        languages: { value: new Set(["common"]), custom: "", labels: { languages: ["Common", "Dwarvish"], ranged: ["Telepathy 30 ft"] } },
        armorProf: { value: new Set(["lgt"]), custom: "Shields" },
        weaponProf: { value: new Set(["sim"]), custom: "" }
      },
      tools: { thief: { value: 1 }, herb: { value: 0 } },
      abilities: { str: { value: 14, mod: 2, save: { value: 5 }, proficient: 1 }, dex: { value: 16, mod: 3, save: { value: 3 } }, con: { value: 14, mod: 2, save: { value: 2 } },
        int: { value: 12, mod: 1, save: { value: 1 } }, wis: { value: 16, mod: 3, save: { value: 6 }, proficient: 1 }, cha: { value: 8, mod: -1, save: { value: -1 } } },
      skills: { prc: { total: 6, passive: 16, value: 1, ability: "wis" }, ste: { total: 9, passive: 19, value: 2, ability: "dex" } },
      currency: { pp: 0, gp: 120, ep: 0, sp: 14, cp: 3 },
      spells: { spell1: { value: 3, max: 4 }, spell2: { value: 1, max: 3 }, pact: { value: 0, max: 0 } }
    },
    items: [
      { id: "cleric", name: "Cleric", type: "class", subclass: { name: "Tempest Domain" }, spellcasting: { ability: "wis", save: 14, attack: 6 }, system: { levels: 5, hd: { denomination: "d8", spent: 2 } } },
      { id: "wizard", name: "Wizard", type: "class", spellcasting: { ability: "int", save: 12, attack: 4 }, system: { levels: 2, hd: { denomination: "d6", spent: 0 } } },
      { id: "hammer", name: "Warhammer", type: "weapon",
        labels: { activation: "Action", range: "5 ft", damages: [{ label: "1d8 + 2 Bludgeoning" }], toHit: "+5", properties: [{ abbr: "ver", label: "Versatile" }] },
        system: { quantity: 1, equipped: true, mastery: "push", weight: { value: 5, units: "lb" },
          activities: [{ id: "swing", name: "Attack", labels: { toHit: "+5" } }, { id: "throw", name: "Throw", labels: { toHit: "+5" } }],
          description: { value: "<p>Deals [[/r 1d8 + @mod]] damage, or [[/r 1d10 + @mod]]{two-handed}.</p><section class=\"secret\"><p>Cursed.</p></section>" } } },
      { id: "potion", name: "Potion of Healing", type: "consumable", _stats: { compendiumSource: "Compendium.dnd5e.items.Item.potion" },
        system: { quantity: 2, uses: { max: 1, spent: 0 }, description: { value: "" } } },
      { id: "ring", name: "Ring of Protection", type: "equipment", labels: { armor: "+1 AC" }, system: { attunement: "required", attuned: false, equipped: true, quantity: 1, description: { value: "<p>+1 AC.</p>" } } },
      { id: "channel", name: "Channel Divinity", type: "feat", labels: { recovery: "Short Rest", activation: "Action" },
        system: { uses: { max: 2, spent: 1 },
          activities: [{ id: "turn", name: "Turn Undead", labels: { save: "DC 14 Wisdom" } }, { id: "wrath", name: "Wrath of the Storm", uses: { max: 3, spent: 1, recovery: [{ period: "lr" }] }, labels: {} }],
          description: { value: "<p onclick=\"alert(1)\">Holy power<script>alert(2)</script><img src=x onerror=alert(3)> [[/save dex 14]] and {@damage 2d8} thunder.</p>" } } },
      { id: "arrows", name: "Arrows", type: "consumable", _stats: { compendiumSource: "Compendium.dnd5e.items.Item.arrows" },
        system: { quantity: 20, equipped: true, description: { value: "" } } },
      { id: "rope", name: "Rope", type: "equipment", system: { quantity: 1, equipped: false, description: { value: "" } } },
      { id: "bolt", name: "Guiding Bolt", type: "spell", labels: { activation: "Action", range: "120 ft", components: { full: "V, S" }, duration: "1 Round" },
        system: { level: 1, school: "evo", method: "spell", prepared: 1, properties: new Set(), description: { value: "<p>{@damage 4d6} radiant.</p>" } } }
    ]
  });

  // Other's character, who isn't in the party.
  const brann = new Actor({ id: "brann", name: "Brann", type: "character", owners: new Set(["other"]),
    system: { details: { level: 3 }, attributes: { hp: { value: 20, max: 20 } }, currency: { gp: 5 } } });

  // A dnd5e Group actor: the party, with Isen as its only member.
  const party = new Actor({
    id: "party", name: "The Company", type: "group",
    system: { type: { value: "party" }, currency: { pp: 0, gp: 50, ep: 0, sp: 0, cp: 0 } },
    items: [
      { id: "rations", name: "Rations", type: "consumable", system: { quantity: 6, description: { value: "<p>One day of food.</p><section class=\"secret\"><p>Spoiled.</p></section>" } } },
      { id: "lantern", name: "Lantern", type: "equipment", system: { quantity: 1, equipped: false, description: { value: "" } } },
      { id: "spear", name: "Spear", type: "weapon", labels: { toHit: "+4", damages: [{ label: "1d6 + 2 Piercing" }] },
        system: { quantity: 1, rarity: "common", attunement: "optional", weight: { value: 3, units: "lb" }, uses: { max: 2, spent: 0 }, description: { value: "" } } },
      { id: "partyfeat", name: "Party Feature", type: "feat", system: {} }
    ]
  });
  party.system.members = [{ actor: isen }, { actor: "deleted-actor" }];

  const world = {
    users, gm, ursula, other, isen, brann, party,
    actors: new Collection([isen, brann, party].map(a => [a.id, a])),
    messages: new Collection(),
    packs: [
      createPack("dnd5e.items", "Items (SRD)", [
        { id: "longsword", name: "Longsword", type: "weapon", system: { price: { value: 15, denomination: "gp" }, equipped: true, quantity: 1, description: { value: "<p>Versatile.</p>" } } },
        { id: "potion", name: "Potion of Healing", type: "consumable", system: { quantity: 1, description: { value: "<p>Heals.</p>" } } },
        { id: "epee", name: "Épée of Testing", type: "weapon", system: {} },
        { id: "feature", name: "Cleric Feature", type: "feat", system: {} }
      ]),
      createPack("dnd5e.spells", "Spells (SRD)", [
        { id: "cure", name: "Cure Wounds", type: "spell", system: { level: 1, school: "evo", description: { value: "<p>Heal [[/r 2d8 + @mod]].</p>" } } },
        { id: "flame", name: "Sacred Flame", type: "spell", system: { level: 0, school: "evo" } }
      ]),
      createPack("world.secret", "GM Secrets", [{ id: "vorpal", name: "Vorpal Sword", type: "weapon", system: {} }], { observer: false })
    ]
  };
  isen.owners.add("ursula");
  ursula.character = isen;

  const settings = createSettings({
    relayUrl, relaySecret,
    worldTrackers: [
      { id: "doom", name: "Doom", type: "clock", min: 0, max: 6, value: 2, visibility: "players", playerEditable: false, created: 1, bands: [] },
      { id: "fate", name: "Fate", type: "bands", min: -3, max: 3, value: 0, visibility: "players", playerEditable: true, created: 2,
        bands: [{ from: -3, label: "Chaos", effect: "" }, { from: -1, label: "Balance", effect: "" }, { from: 2, label: "Order", effect: "" }] }
    ]
  });

  globalThis.ChatMessage = { implementation: {
    getSpeaker: ({ actor }) => ({ alias: actor?.name }),
    async create(data) {
      const message = { id: randomID(), ...data,
        getFlag(scope, key) { return this.flags?.[scope]?.[key]; },
        async update(changes) { Object.assign(this, changes); } };
      world.messages.set(message.id, message);
      return message;
    }
  } };

  globalThis.game = {
    user: gm, users, settings, world: { id: "test", title: "Test World" }, system: { id: "dnd5e" },
    actors: world.actors, messages: world.messages,
    packs: Object.assign(new Collection(world.packs.map(p => [p.collection, p])), { filter: fn => world.packs.filter(fn) }),
    items: { fromCompendium: doc => {
      const data = doc.toObject();
      delete data.id; delete data.pack;
      data._stats = { ...data._stats, compendiumSource: doc.uuid };
      return data;
    } },
    i18n: { localize: k => k, getListFormatter: () => new Intl.ListFormat("en", { style: "narrow" }) },
    socket: { on() {}, emit() {} },
    modules: new Map([["player-companion", {}]])
  };

  return world;
}

/** Fire the init and ready hooks, as Foundry does after loading modules. */
export function startFoundry() {
  Hooks.callAll("init");
  Hooks.callAll("ready");
}
