/**
 * What an external app may read and do, on behalf of a Foundry user.
 *
 * Every action runs in the GM's browser, so every action must check that the
 * requesting user owns the actor and must only touch whitelisted fields.
 * Written against dnd5e 4.x to 6.x; older data shapes are handled where cheap.
 */

import { RelayError } from "./errors.js";
import * as Items from "./items.js";
import * as Trackers from "./trackers.js";

export { RelayError };

const OWNER = "OWNER";
const MAX_DESCRIPTION = 4000;

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const localize = key => (key ? game.i18n.localize(key) : "");
const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function requireInt(value, name, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new RelayError(400, `${name} must be a whole number`);
  return clamp(n, min, max);
}

function requireBool(value, name) {
  if (typeof value !== "boolean") throw new RelayError(400, `${name} must be true or false`);
  return value;
}

function ownedActor(user, actorId) {
  const actor = game.actors.get(String(actorId ?? ""));
  // Same answer for "missing" and "not yours", so ids cannot be probed.
  if (!actor || !actor.testUserPermission(user, OWNER)) throw new RelayError(404, "Character not found");
  return actor;
}

function ownedItem(actor, itemId) {
  const item = actor.items.get(String(itemId ?? ""));
  if (!item) throw new RelayError(404, "Item not found");
  return item;
}

function plainText(html) {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(String(html), "text/html");
  const text = (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION)}…` : text;
}

/** Absolute URL for an image path, so an app on another origin can load it. */
function imageUrl(path) {
  if (!path) return null;
  try { return new URL(path, window.location.origin).href; }
  catch { return null; }
}

/** Item uses as { value, max, spentPath } across dnd5e versions, or null. */
function itemUses(item) {
  const uses = item.system.uses;
  const max = num(uses?.max);
  if (!uses || !max) return null;
  if ("spent" in uses) return { value: max - num(uses.spent), max, path: "system.uses.spent", spent: true };
  return { value: num(uses.value), max, path: "system.uses.value", spent: false };
}

/** Spell preparation across dnd5e 4.x (system.preparation) and 5.x (system.method / system.prepared). */
function spellPreparation(item) {
  const sys = item.system;
  if (sys.preparation) {
    const mode = sys.preparation.mode;
    return {
      mode,
      prepared: mode === "always" || !!sys.preparation.prepared,
      toggleable: mode === "prepared" && sys.level > 0,
      update: value => ({ "system.preparation.prepared": value })
    };
  }
  const prepared = num(sys.prepared);
  const mode = prepared === 2 ? "always" : (sys.method ?? "spell");
  return {
    mode,
    prepared: prepared >= 1,
    toggleable: prepared !== 2 && (sys.method ?? "spell") === "spell" && sys.level > 0,
    update: value => ({ "system.prepared": value ? 1 : 0 })
  };
}

/* -------------------------------------------- */
/*  Serialisation                               */
/* -------------------------------------------- */

function serializeItem(item) {
  const sys = item.system;
  const data = {
    id: item.id,
    name: item.name,
    type: item.type,
    img: imageUrl(item.img),
    description: plainText(sys.description?.value),
    uses: null,
    removable: Items.isManaged(item)
  };
  const uses = itemUses(item);
  if (uses) data.uses = { value: uses.value, max: uses.max };
  if ("quantity" in sys) data.quantity = num(sys.quantity);
  if ("equipped" in sys) data.equipped = !!sys.equipped;
  if ("attuned" in sys) data.attuned = !!sys.attuned;
  if (item.type === "spell") {
    const prep = spellPreparation(item);
    data.level = num(sys.level);
    data.school = localize(CONFIG.DND5E.spellSchools?.[sys.school]?.label) || sys.school || "";
    data.preparation = { mode: prep.mode, prepared: prep.prepared, toggleable: prep.toggleable };
    data.concentration = !!sys.properties?.has?.("concentration");
    data.ritual = !!sys.properties?.has?.("ritual");
  }
  return data;
}

const ITEM_GROUPS = {
  weapon: "weapons",
  equipment: "equipment",
  consumable: "consumables",
  tool: "tools",
  loot: "loot",
  container: "loot",
  backpack: "loot",
  feat: "features",
  spell: "spells"
};

function serializeClasses(actor) {
  return Object.values(actor.classes ?? {}).map(cls => {
    const sys = cls.system;
    const levels = num(sys.levels);
    const denomination = sys.hd?.denomination ?? sys.hitDice ?? "";
    const spent = num(sys.hd?.spent ?? sys.hitDiceUsed);
    return {
      id: cls.id,
      name: cls.name,
      subclass: cls.subclass?.name ?? null,
      levels,
      hitDice: { denomination, value: levels - spent, max: levels }
    };
  });
}

function serializeSpellSlots(actor) {
  const spells = actor.system.spells ?? {};
  const slots = [];
  for (let level = 1; level <= 9; level++) {
    const slot = spells[`spell${level}`];
    if (num(slot?.max) > 0) slots.push({ key: `spell${level}`, level, label: `Level ${level}`, value: num(slot.value), max: num(slot.max) });
  }
  if (num(spells.pact?.max) > 0) {
    slots.push({ key: "pact", level: num(spells.pact.level), label: `Pact (level ${num(spells.pact.level)})`,
      value: num(spells.pact.value), max: num(spells.pact.max) });
  }
  return slots;
}

/**
 * Every speed the character has, after conditions, encumbrance and bonuses.
 * dnd5e 6 keeps speeds in movement.speeds; earlier versions put them on movement itself.
 */
function serializeSpeed(actor) {
  const movement = actor.system.attributes?.movement ?? {};
  const speeds = movement.speeds ?? movement;
  const types = CONFIG.DND5E.movementTypes ?? { walk: {}, burrow: {}, climb: {}, fly: {}, swim: {} };
  const all = Object.entries(types)
    .map(([key, config]) => ({
      key,
      label: key === "walk" ? "Walk" : localize(config.label ?? config) || key,
      value: num(speeds[key])
    }))
    .filter(s => s.value > 0 && s.key !== "jump");
  return {
    walk: num(speeds.walk),
    units: movement.units ?? "ft",
    all,
    hover: !!movement.hover,
    special: movement.special || ""
  };
}

/** Save DC and attack bonus for each spellcasting class, falling back to the actor's single values. */
function serializeSpellcasting(actor) {
  const attr = actor.system.attributes ?? {};
  const abilityLabel = key => localize(CONFIG.DND5E.abilities[key]?.label) || key?.toUpperCase() || "";
  const classes = Object.values(actor.spellcastingClasses ?? {}).map(cls => {
    const sc = cls.spellcasting ?? cls.system.spellcasting ?? {};
    return { id: cls.id, name: cls.name, ability: sc.ability ?? "", abilityLabel: abilityLabel(sc.ability), dc: num(sc.save), attack: num(sc.attack) };
  }).filter(c => c.dc);
  return {
    ability: attr.spellcasting || null,
    dc: num(attr.spell?.dc ?? attr.spelldc),
    attack: num(attr.spell?.attack ?? 0),
    classes
  };
}

export function serializeActor(actor, user) {
  const sys = actor.system;
  const attr = sys.attributes ?? {};

  const abilities = Object.entries(CONFIG.DND5E.abilities).map(([key, config]) => {
    const ability = sys.abilities?.[key] ?? {};
    const save = typeof ability.save === "object" ? ability.save?.value : ability.save;
    return {
      key,
      label: localize(config.label),
      abbreviation: localize(config.abbreviation) || key.toUpperCase(),
      value: num(ability.value),
      mod: num(ability.mod),
      save: num(save),
      proficient: num(ability.proficient) > 0
    };
  });

  const skills = Object.entries(CONFIG.DND5E.skills).map(([key, config]) => {
    const skill = sys.skills?.[key] ?? {};
    return {
      key,
      label: localize(config.label),
      ability: skill.ability ?? config.ability,
      total: num(skill.total),
      passive: num(skill.passive),
      proficiency: num(skill.value) // 0 none, 0.5 half, 1 proficient, 2 expertise
    };
  });

  const items = { weapons: [], equipment: [], consumables: [], tools: [], loot: [], features: [], spells: [] };
  for (const item of actor.items) {
    const group = ITEM_GROUPS[item.type];
    if (group) items[group].push(serializeItem(item));
  }
  for (const list of Object.values(items)) list.sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name));

  const hp = attr.hp ?? {};
  return {
    id: actor.id,
    name: actor.name,
    type: actor.type,
    img: imageUrl(actor.img),
    level: num(sys.details?.level),
    classes: serializeClasses(actor),
    species: actor.system.details?.race?.name ?? actor.items.find(i => i.type === "race")?.name ?? null,
    background: actor.system.details?.background?.name ?? actor.items.find(i => i.type === "background")?.name ?? null,
    hp: { value: num(hp.value), max: num(hp.max), temp: num(hp.temp), tempmax: num(hp.tempmax) },
    ac: num(attr.ac?.value),
    initiative: num(attr.init?.total ?? attr.init?.mod),
    proficiency: num(attr.prof),
    speed: serializeSpeed(actor),
    spellcasting: serializeSpellcasting(actor),
    death: { success: num(attr.death?.success), failure: num(attr.death?.failure) },
    inspiration: !!attr.inspiration,
    exhaustion: num(attr.exhaustion),
    conditions: [...(actor.statuses ?? [])],
    currency: Object.fromEntries(["pp", "gp", "ep", "sp", "cp"].map(k => [k, num(sys.currency?.[k])])),
    abilities,
    skills,
    spellSlots: serializeSpellSlots(actor),
    items,
    itemChanges: {
      mode: Items.itemChangeMode(),
      requests: Items.requestsFor(actor).map(r => ({
        id: r.id, kind: r.kind, status: r.status, name: r.name, img: imageUrl(r.img), type: r.type,
        quantity: r.quantity, itemId: r.itemId, reason: r.reason ?? null, userName: r.userName
      }))
    },
    trackers: user ? Trackers.trackersFor(user, actor) : null
  };
}

/* -------------------------------------------- */
/*  Actions                                     */
/* -------------------------------------------- */

export function listCharacters(user) {
  return game.actors
    .filter(a => a.testUserPermission(user, OWNER) && (user.isGM ? a.hasPlayerOwner : true))
    .sort((a, b) => (b.id === user.character?.id) - (a.id === user.character?.id) || a.name.localeCompare(b.name))
    .map(a => ({ id: a.id, name: a.name, type: a.type, img: imageUrl(a.img), level: num(a.system.details?.level) }));
}

/**
 * Each action receives (user, params) and returns JSON-safe data.
 * Actions that change a character return the updated sheet.
 */
export const ACTIONS = {
  me(user) {
    return {
      user: { id: user.id, name: user.name, color: user.color?.css ?? String(user.color ?? "") },
      world: { id: game.world.id, title: game.world.title },
      characters: listCharacters(user)
    };
  },

  getActor(user, { actorId }) {
    return serializeActor(ownedActor(user, actorId), user);
  },

  /** Body: { value?, temp? } to set, or { damage } / { heal } to apply. */
  async hp(user, { actorId, value, temp, damage, heal }) {
    const actor = ownedActor(user, actorId);
    const hp = actor.system.attributes.hp;
    const max = num(hp.max) + num(hp.tempmax);
    const update = {};
    let current = num(hp.value);
    let currentTemp = num(hp.temp);

    if (damage !== undefined) {
      let amount = requireInt(damage, "damage", { min: 0, max: 9999 });
      const absorbed = Math.min(currentTemp, amount);
      currentTemp -= absorbed;
      amount -= absorbed;
      current = Math.max(0, current - amount);
      Object.assign(update, { "system.attributes.hp.value": current, "system.attributes.hp.temp": currentTemp });
    }
    if (heal !== undefined) {
      current = clamp(current + requireInt(heal, "heal", { min: 0, max: 9999 }), 0, max);
      update["system.attributes.hp.value"] = current;
    }
    if (value !== undefined) update["system.attributes.hp.value"] = requireInt(value, "value", { min: 0, max });
    if (temp !== undefined) update["system.attributes.hp.temp"] = requireInt(temp, "temp", { min: 0, max: 9999 });
    if (!Object.keys(update).length) throw new RelayError(400, "Send value, temp, damage or heal");

    await actor.update(update);
    return serializeActor(actor, user);
  },

  async deathSaves(user, { actorId, success, failure }) {
    const actor = ownedActor(user, actorId);
    const update = {};
    if (success !== undefined) update["system.attributes.death.success"] = requireInt(success, "success", { min: 0, max: 3 });
    if (failure !== undefined) update["system.attributes.death.failure"] = requireInt(failure, "failure", { min: 0, max: 3 });
    await actor.update(update);
    return serializeActor(actor, user);
  },

  async inspiration(user, { actorId, value }) {
    const actor = ownedActor(user, actorId);
    await actor.update({ "system.attributes.inspiration": requireBool(value, "value") });
    return serializeActor(actor, user);
  },

  async exhaustion(user, { actorId, value }) {
    const actor = ownedActor(user, actorId);
    const max = CONFIG.DND5E.conditionTypes?.exhaustion?.levels ?? 6;
    await actor.update({ "system.attributes.exhaustion": requireInt(value, "value", { min: 0, max }) });
    return serializeActor(actor, user);
  },

  /** Body: { slot: "spell1".."spell9" | "pact", value } where value is slots remaining. */
  async spellSlot(user, { actorId, slot, value }) {
    const actor = ownedActor(user, actorId);
    if (!/^(spell[1-9]|pact)$/.test(String(slot))) throw new RelayError(400, "slot must be spell1-spell9 or pact");
    const max = num(actor.system.spells?.[slot]?.max);
    if (!max) throw new RelayError(400, "This character has no slots of that level");
    await actor.update({ [`system.spells.${slot}.value`]: requireInt(value, "value", { min: 0, max }) });
    return serializeActor(actor, user);
  },

  /** Body: { itemId, value } where value is uses remaining. */
  async itemUses(user, { actorId, itemId, value }) {
    const actor = ownedActor(user, actorId);
    const item = ownedItem(actor, itemId);
    const uses = itemUses(item);
    if (!uses) throw new RelayError(400, "That item has no limited uses");
    const remaining = requireInt(value, "value", { min: 0, max: uses.max });
    await item.update({ [uses.path]: uses.spent ? uses.max - remaining : remaining });
    return serializeActor(actor, user);
  },

  async itemQuantity(user, { actorId, itemId, value }) {
    const actor = ownedActor(user, actorId);
    const item = ownedItem(actor, itemId);
    if (!("quantity" in item.system)) throw new RelayError(400, "That item has no quantity");
    await item.update({ "system.quantity": requireInt(value, "value", { min: 0, max: 99999 }) });
    return serializeActor(actor, user);
  },

  async itemEquipped(user, { actorId, itemId, value }) {
    const actor = ownedActor(user, actorId);
    const item = ownedItem(actor, itemId);
    if (!("equipped" in item.system)) throw new RelayError(400, "That item cannot be equipped");
    await item.update({ "system.equipped": requireBool(value, "value") });
    return serializeActor(actor, user);
  },

  async spellPrepared(user, { actorId, itemId, value }) {
    const actor = ownedActor(user, actorId);
    const item = ownedItem(actor, itemId);
    if (item.type !== "spell") throw new RelayError(400, "That item is not a spell");
    const prep = spellPreparation(item);
    if (!prep.toggleable) throw new RelayError(400, "That spell cannot be prepared or unprepared");
    await item.update(prep.update(requireBool(value, "value")));
    return serializeActor(actor, user);
  },

  /** Body: { classId, value } where value is hit dice remaining for that class. */
  async hitDice(user, { actorId, classId, value }) {
    const actor = ownedActor(user, actorId);
    const cls = ownedItem(actor, classId);
    if (cls.type !== "class") throw new RelayError(400, "That item is not a class");
    const levels = num(cls.system.levels);
    const spent = levels - requireInt(value, "value", { min: 0, max: levels });
    await cls.update(cls.system.hd ? { "system.hd.spent": spent } : { "system.hitDiceUsed": spent });
    return serializeActor(actor, user);
  },

  /** Body: any of { pp, gp, ep, sp, cp }. */
  async currency(user, { actorId, ...coins }) {
    const actor = ownedActor(user, actorId);
    const update = {};
    for (const key of ["pp", "gp", "ep", "sp", "cp"]) {
      if (coins[key] !== undefined) update[`system.currency.${key}`] = requireInt(coins[key], key, { min: 0, max: 9_999_999 });
    }
    if (!Object.keys(update).length) throw new RelayError(400, "Send at least one of pp, gp, ep, sp, cp");
    await actor.update(update);
    return serializeActor(actor, user);
  },

  /**
   * Body: { trackerId, scope: "actor" | "world", value }.
   * "world" is a party tracker; actorId still names the character being viewed.
   */
  async setTracker(user, { actorId, trackerId, scope, value }) {
    const actor = ownedActor(user, actorId);
    const list = scope === "world" ? Trackers.partyTrackers() : Trackers.actorTrackers(actor);
    const tracker = list.find(t => t.id === trackerId);
    if (!tracker || !Trackers.canSee(user, tracker)) throw new RelayError(404, "Tracker not found");
    if (!Trackers.canEditValue(user, tracker, actor)) throw new RelayError(403, "Only the GM can change that tracker");
    if (tracker.type !== "text" && !Number.isFinite(Number(value))) throw new RelayError(400, "value must be a number");
    if (scope === "world") await Trackers.setWorldValue(tracker.id, value);
    else await Trackers.setActorValue(actor, tracker.id, value);
    return serializeActor(actor, user);
  },

  /** Body: { name, type: counter|pips|clock|bands|text, min?, max?, description?, bands? }. */
  async createTracker(user, { actorId, name, type, min, max, description, bands }) {
    const actor = ownedActor(user, actorId);
    if (!Trackers.canManagePersonal(user, actor)) throw new RelayError(403, "The GM hasn't allowed players to create trackers");
    if (typeof name !== "string" || !name.trim()) throw new RelayError(400, "name is required");
    if (type !== undefined && !(type in Trackers.TRACKER_TYPES)) throw new RelayError(400, "Unknown tracker type");
    const existing = Object.values(actor.getFlag(Trackers.MODULE_ID, "trackers") ?? {}).filter(d => d?.name).length;
    if (existing >= 50) throw new RelayError(400, "That character already has 50 trackers");
    await Trackers.savePersonal(actor, { name, type, min, max, description, bands, playerEditable: true, visibility: "owner" });
    return serializeActor(actor, user);
  },

  async deleteTracker(user, { actorId, trackerId }) {
    const actor = ownedActor(user, actorId);
    const tracker = Trackers.actorTrackers(actor).find(t => t.id === trackerId && t.source === "personal");
    if (!tracker) throw new RelayError(404, "Tracker not found");
    if (!Trackers.canManagePersonal(user, actor)) throw new RelayError(403, "The GM hasn't allowed players to remove trackers");
    await Trackers.deletePersonal(actor, tracker.id);
    return serializeActor(actor, user);
  },

  /**
   * Body: { kind: "item" | "spell", query?, pack?, type?, level? }.
   * Searches the compendiums this user can see. Returns { total, results, packs }.
   */
  async searchItems(user, { actorId, kind, query, pack, type, level }) {
    ownedActor(user, actorId);
    if (kind !== "item" && kind !== "spell") throw new RelayError(400, "kind must be item or spell");
    const found = await Items.search(user, {
      kind,
      query: typeof query === "string" ? query.slice(0, 100) : "",
      pack: typeof pack === "string" ? pack : "",
      type: typeof type === "string" ? type : "",
      level: level === undefined || level === null || level === "" ? null : requireInt(level, "level", { min: 0, max: 9 })
    });
    return { ...found, results: found.results.map(r => ({ ...r, img: imageUrl(r.img) })) };
  },

  /** Body: { uuid }. A compendium item's details, for the search results. */
  async itemDetails(user, { actorId, uuid }) {
    ownedActor(user, actorId);
    const doc = await Items.compendiumItem(user, uuid);
    return { uuid, ...serializeItem(doc) };
  },

  /**
   * Body: { uuid, quantity? }. Adds a compendium item or spell, or asks the GM to.
   * Returns { actor, notice }.
   */
  async addItem(user, { actorId, uuid, quantity }) {
    const actor = ownedActor(user, actorId);
    const source = await Items.compendiumItem(user, uuid);
    const notice = await Items.requestChange(user, actor, {
      kind: "add", source,
      quantity: quantity === undefined || quantity === null ? null : requireInt(quantity, "quantity", { min: 1, max: 999 })
    });
    return { actor: serializeActor(actor, user), notice };
  },

  /** Body: { itemId }. Removes an item or spell, or asks the GM to. Returns { actor, notice }. */
  async removeItem(user, { actorId, itemId }) {
    const actor = ownedActor(user, actorId);
    const item = ownedItem(actor, itemId);
    if (!Items.isManaged(item)) throw new RelayError(400, "Only items and spells can be removed from the web app");
    const notice = await Items.requestChange(user, actor, { kind: "remove", item });
    return { actor: serializeActor(actor, user), notice };
  },

  /** Body: { requestId }. Withdraws a pending request or dismisses a denied one. */
  async cancelItemRequest(user, { actorId, requestId }) {
    const actor = ownedActor(user, actorId);
    await Items.cancelRequest(actor, String(requestId ?? ""));
    return serializeActor(actor, user);
  },

  /** Body: { type: "short" | "long" }. Rests without a dialog; hit dice are not spent automatically. */
  async rest(user, { actorId, type }) {
    const actor = ownedActor(user, actorId);
    if (type === "short") await actor.shortRest({ dialog: false, chat: true });
    else if (type === "long") await actor.longRest({ dialog: false, chat: true, newDay: true });
    else throw new RelayError(400, "type must be short or long");
    return serializeActor(actor, user);
  }
};
