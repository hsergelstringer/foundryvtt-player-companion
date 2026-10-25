/**
 * Adding items and spells from compendiums, and removing them, from the web app.
 *
 * The world setting "itemChanges" decides what happens:
 *  - "approve": each change becomes a request. The GMs get a whispered chat
 *    card with Approve and Deny buttons, and the player sees it as pending.
 *  - "direct":  the change happens at once, and the GMs get a note in chat.
 *  - "off":     the web app can't add or remove items.
 *
 * Requests live in the world setting "itemRequests". Approved requests are
 * removed; denied ones stay until the player dismisses them, so they see why
 * the item never arrived.
 *
 * Players only search compendiums they can see, so a GM hides a compendium
 * from the web app the same way as in Foundry: set its ownership to None.
 */

import { RelayError } from "./errors.js";
import { serial } from "./serial.js";

const MODULE_ID = "player-companion";
const MAX_RESULTS = 50;
const MAX_PENDING = 20;
/** Denied requests the player never dismissed are dropped after this long. */
const DENIED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Item types players can add and remove. Anything with advancement (classes, feats) stays in Foundry. */
export const ITEM_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"]);
const SPELL_TYPES = new Set(["spell"]);
const typesFor = kind => (kind === "spell" ? SPELL_TYPES : ITEM_TYPES);
export const isManaged = item => ITEM_TYPES.has(item.type) || SPELL_TYPES.has(item.type);

const INDEX_FIELDS = ["system.level", "system.school", "system.price", "system.rarity"];

const localize = key => (key ? game.i18n.localize(key) : "");
const esc = text => Handlebars.escapeExpression(String(text ?? ""));

export const itemChangeMode = () => game.settings.get(MODULE_ID, "itemChanges");
const requests = () => game.settings.get(MODULE_ID, "itemRequests") ?? [];
const saveRequests = list => {
  const cutoff = Date.now() - DENIED_TTL_MS;
  return game.settings.set(MODULE_ID, "itemRequests", list.filter(r => r.status !== "denied" || (r.resolved ?? r.created) > cutoff));
};
/** Every change to the request list goes through here, one at a time (see serial.js). */
const withRequests = serial();

/* -------------------------------------------- */
/*  Search                                      */
/* -------------------------------------------- */

/** Compendium indexes, by pack id. getIndex asks the server every time, and searches run per keystroke. */
const indexes = new Map();

function indexOf(pack) {
  if (!indexes.has(pack.collection)) {
    const loading = pack.getIndex({ fields: INDEX_FIELDS }).then(index => [...index]);
    loading.catch(() => indexes.delete(pack.collection));
    indexes.set(pack.collection, loading);
  }
  return indexes.get(pack.collection);
}

function packsFor(user) {
  return game.packs.filter(p => p.documentName === "Item" && p.testUserPermission(user, "OBSERVER"));
}

function priceLabel(price) {
  const value = Number(price?.value);
  if (!value) return "";
  const denomination = CONFIG.DND5E.currencies?.[price.denomination]?.abbreviation;
  return `${value} ${localize(denomination) || price.denomination || "gp"}`;
}

function describeEntry(entry, pack) {
  const sys = entry.system ?? {};
  const isSpell = entry.type === "spell";
  return {
    uuid: entry.uuid ?? `Compendium.${pack.collection}.Item.${entry._id}`,
    name: entry.name,
    img: entry.img,
    type: entry.type,
    typeLabel: localize(CONFIG.Item.typeLabels?.[entry.type]) || entry.type,
    level: isSpell ? Number(sys.level ?? 0) : null,
    school: isSpell ? localize(CONFIG.DND5E.spellSchools?.[sys.school]?.label) || sys.school || "" : null,
    price: isSpell ? "" : priceLabel(sys.price),
    rarity: isSpell ? "" : localize(CONFIG.DND5E.itemRarity?.[sys.rarity]) || "",
    pack: pack.title ?? pack.metadata.label
  };
}

/**
 * Search the compendiums a user can see.
 * @param {User} user
 * @param {object} options
 * @param {"item"|"spell"} options.kind
 * @param {string} [options.query]   Matched against names, case- and accent-insensitive
 * @param {string} [options.pack]    Only this compendium
 * @param {string} [options.type]    Only this item type
 * @param {number} [options.level]   Only spells of this level
 */
export async function search(user, { kind, query = "", pack: packId = "", type = "", level = null }) {
  const types = typesFor(kind);
  const fold = text => String(text ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
  const needle = fold(query);
  const packs = [];
  const matches = [];

  for (const pack of packsFor(user)) {
    const entries = (await indexOf(pack)).filter(e => types.has(e.type));
    if (!entries.length) continue;
    packs.push({ id: pack.collection, label: pack.title ?? pack.metadata.label });
    if (packId && pack.collection !== packId) continue;
    for (const entry of entries) {
      if (type && entry.type !== type) continue;
      if (level !== null && Number(entry.system?.level ?? 0) !== level) continue;
      const name = fold(entry.name);
      const at = needle ? name.indexOf(needle) : 0;
      if (at < 0) continue;
      matches.push({ rank: at === 0 ? 0 : 1, entry, pack });
    }
  }

  matches.sort((a, b) => a.rank - b.rank || a.entry.name.localeCompare(b.entry.name));
  return {
    total: matches.length,
    results: matches.slice(0, MAX_RESULTS).map(m => describeEntry(m.entry, m.pack)),
    packs
  };
}

/** Load a compendium item the user is allowed to see, or throw a 404. */
export async function compendiumItem(user, uuid, kind = null) {
  let doc = null;
  if (typeof uuid === "string" && uuid.startsWith("Compendium.") && uuid.length < 200) {
    try { doc = await foundry.utils.fromUuid(uuid); }
    catch { doc = null; }
  }
  const pack = doc?.pack ? game.packs.get(doc.pack) : null;
  if (!(doc instanceof Item) || !pack?.testUserPermission(user, "OBSERVER")) throw new RelayError(404, "Item not found");
  if (!(kind ? typesFor(kind) : new Set([...ITEM_TYPES, ...SPELL_TYPES])).has(doc.type)) {
    throw new RelayError(400, "Only items and spells can be added from the web app");
  }
  return doc;
}

/* -------------------------------------------- */
/*  Changing the actor                          */
/*  Runs in a GM's browser: the relay GM for    */
/*  direct changes, any GM for approvals.       */
/* -------------------------------------------- */

/**
 * Add a compendium item the way dropping it on the dnd5e sheet does: with its
 * contents, equipped/prepared cleared, consumables stacked, and spells given a
 * spellcasting method and class.
 * @returns {Promise<{ name: string, stacked: boolean }>}
 */
export async function addToActor(actor, source, { quantity } = {}) {
  const advancement = source.system.advancement;
  if (advancement && (advancement.size ?? Object.keys(advancement).length) > 0) {
    throw new RelayError(400, `${source.name} has advancement steps, so add it in Foundry`);
  }
  const Item5e = CONFIG.Item.documentClass;
  // onDropCreate looks at where an item was dropped; an empty element means "not on any section".
  const nowhere = { target: document.createElement("div") };
  let stacked = false;

  const toCreate = await Item5e.createWithContents([source], {
    transformFirst: async doc => {
      const data = doc instanceof foundry.abstract.Document ? game.items.fromCompendium(doc) : doc;
      for (const key of ["attuned", "equipped", "prepared", "crew.value"]) foundry.utils.deleteProperty(data.system ?? {}, key);
      if (quantity && data.system && "quantity" in data.system) data.system.quantity = quantity;

      // Stack identical consumables instead of adding a second copy.
      const sourceId = data._stats?.compendiumSource ?? source.uuid;
      if (data.type === "consumable") {
        const existing = actor.sourcedItems?.get(sourceId, { legacy: false })
          ?.filter(i => !i.system.container && i.name === data.name)?.first();
        if (existing) {
          await existing.update({ "system.quantity": existing.system.quantity + Math.max(data.system.quantity ?? 1, 1) });
          stacked = true;
          return null;
        }
      }
      CONFIG.Item.dataModels[data.type]?.onDropCreate?.(nowhere, actor, data);
      return data;
    }
  }) ?? [];

  for (const data of toCreate) foundry.utils.deleteProperty(data, "flags.dnd5e.bastionClaim");
  if (toCreate.length) await Item5e.createDocuments(toCreate, { keepId: true, parent: actor });
  return { name: source.name, stacked };
}

export async function removeFromActor(item) {
  await item.delete({ deleteContents: true });
}

/* -------------------------------------------- */
/*  Requests                                    */
/* -------------------------------------------- */

/** Requests about one actor, oldest first. */
export function requestsFor(actor) {
  return requests().filter(r => r.actorId === actor.id).sort((a, b) => a.created - b.created);
}

function describeRequest(request) {
  const what = request.quantity > 1 ? `${request.name} (×${request.quantity})` : request.name;
  return request.kind === "add" ? `add ${what} to ${request.actorName}` : `remove ${what} from ${request.actorName}`;
}

function cardHeader(request) {
  // A "}" in the name would end the link label early.
  const link = request.uuid ? `@UUID[${request.uuid}]{${esc(request.name).replace(/[{}]/g, "")}}` : `<strong>${esc(request.name)}</strong>`;
  const what = request.quantity > 1 ? `${link} (×${request.quantity})` : link;
  const action = request.kind === "add" ? `add ${what} to` : `remove ${what} from`;
  return `<p><strong>${esc(request.userName)}</strong> asks to ${action} <strong>${esc(request.actorName)}</strong>.</p>`;
}

function cardContent(request, outcome = null) {
  const body = outcome
    ? `<p class="pc-request-outcome"><em>${esc(outcome)}</em></p>`
    : `<div class="pc-request-buttons">
        <button type="button" data-pc-request="approve"><i class="fa-solid fa-check"></i> Approve</button>
        <button type="button" data-pc-request="deny"><i class="fa-solid fa-xmark"></i> Deny</button>
      </div>`;
  return `<div class="player-companion-request" data-request-id="${request.id}">${cardHeader(request)}${body}</div>`;
}

const gmIds = () => game.users.filter(u => u.isGM).map(u => u.id);

async function whisperGMs(actor, content, flags = {}) {
  return ChatMessage.implementation.create({
    content,
    whisper: gmIds(),
    speaker: ChatMessage.implementation.getSpeaker({ actor }),
    flags: { [MODULE_ID]: flags }
  });
}

async function closeCards(request, outcome) {
  for (const message of game.messages.filter(m => m.getFlag(MODULE_ID, "requestId") === request.id)) {
    await message.update({ content: cardContent(request, outcome) });
  }
}

/**
 * Queue a change for the GM, or make it now if the GM allows direct changes.
 * @param {User} user
 * @param {Actor} actor
 * @param {{ kind: "add", source: Item, quantity?: number } | { kind: "remove", item: Item }} change
 * @returns {Promise<string>}  What happened, to show the player
 */
export async function requestChange(user, actor, change) {
  const mode = itemChangeMode();
  if (mode === "off") throw new RelayError(403, "The GM hasn't allowed adding or removing items from the web app");

  const subject = change.kind === "add" ? change.source : change.item;
  const quantity = change.kind === "add" ? change.quantity ?? null : null;
  const request = {
    id: foundry.utils.randomID(),
    kind: change.kind,
    status: "pending",
    userId: user.id,
    userName: user.name,
    actorId: actor.id,
    actorName: actor.name,
    uuid: change.kind === "add" ? subject.uuid : null,
    itemId: change.kind === "remove" ? subject.id : null,
    name: subject.name,
    img: subject.img,
    type: subject.type,
    quantity,
    created: Date.now()
  };

  if (mode === "direct" || user.isGM) {
    let result;
    if (change.kind === "add") {
      const { stacked } = await addToActor(actor, change.source, { quantity });
      result = stacked ? `Added to your existing ${subject.name}` : `Added ${subject.name}`;
    }
    else {
      await removeFromActor(change.item);
      result = `Removed ${subject.name}`;
    }
    if (!user.isGM) await whisperGMs(actor, `${cardHeader(request).replace(" asks to ", " used the web app to ")}`);
    return result;
  }

  await withRequests(async () => {
    const list = requests();
    if (list.filter(r => r.actorId === actor.id && r.status === "pending").length >= MAX_PENDING) {
      throw new RelayError(400, `${actor.name} already has ${MAX_PENDING} requests waiting for the GM`);
    }
    if (change.kind === "remove" && list.some(r => r.status === "pending" && r.itemId === subject.id)) {
      throw new RelayError(400, `You've already asked to remove ${subject.name}`);
    }
    list.push(request);
    await saveRequests(list);
  });
  await whisperGMs(actor, cardContent(request), { requestId: request.id });
  return `Asked the GM to ${describeRequest(request)}`;
}

/** Approve or deny a pending request. Runs in a GM's browser. */
export function resolveRequest(requestId, approve) {
  return withRequests(() => resolve(requestId, approve));
}

async function resolve(requestId, approve) {
  const list = requests();
  const request = list.find(r => r.id === requestId);
  if (!request || request.status !== "pending") {
    ui.notifications.info("That request has already been handled.");
    return;
  }

  let outcome;
  let failure = null;
  if (approve) {
    try {
      const actor = game.actors.get(request.actorId);
      if (!actor) throw new Error(`${request.actorName} no longer exists`);
      if (request.kind === "add") {
        const source = await foundry.utils.fromUuid(request.uuid);
        if (!source) throw new Error(`${request.name} is no longer in its compendium`);
        await addToActor(actor, source, { quantity: request.quantity });
      }
      else {
        const item = actor.items.get(request.itemId);
        if (!item) throw new Error(`${request.actorName} no longer has ${request.name}`);
        await removeFromActor(item);
      }
      outcome = `Approved by ${game.user.name}.`;
    }
    catch (err) {
      failure = err.message;
      outcome = `Couldn't be done: ${err.message}`;
      ui.notifications.error(outcome);
    }
  }
  else outcome = `Denied by ${game.user.name}.`;

  const remaining = requests().filter(r => r.id !== requestId);
  if (!approve || failure) remaining.push({ ...request, status: "denied", reason: failure, resolved: Date.now() });
  await saveRequests(remaining);
  await closeCards(request, outcome);
}

/** The player withdraws a pending request or dismisses a denied one. */
export async function cancelRequest(actor, requestId) {
  const request = await withRequests(async () => {
    const list = requests();
    const found = list.find(r => r.id === requestId && r.actorId === actor.id);
    if (!found) throw new RelayError(404, "Request not found");
    await saveRequests(list.filter(r => r.id !== requestId));
    return found;
  });
  if (request.status === "pending") await closeCards(request, `Withdrawn by ${request.userName}.`);
}

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

export function registerItemSettings() {
  game.settings.register(MODULE_ID, "itemChanges", {
    name: "Adding and removing items in the web app",
    hint: "Whether players can add items and spells from compendiums, and remove them, in the web app. Players only see compendiums they have access to.",
    scope: "world", config: true, type: String, default: "approve",
    choices: {
      approve: "The GM approves each change",
      direct: "Players change items directly",
      off: "Off"
    },
    onChange: () => Hooks.callAll(`${MODULE_ID}.requestsChanged`)
  });
  game.settings.register(MODULE_ID, "itemRequests", {
    scope: "world", config: false, type: Array, default: [],
    onChange: () => Hooks.callAll(`${MODULE_ID}.requestsChanged`)
  });
}

export function setupItems() {
  for (const hook of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(hook, item => { if (item.pack) indexes.delete(item.pack); });
  }

  Hooks.on("renderChatMessageHTML", (message, html) => {
    const card = html.querySelector(".player-companion-request");
    const buttons = card?.querySelector(".pc-request-buttons");
    if (!buttons) return;
    if (!game.user.isGM) {
      buttons.remove();
      return;
    }
    for (const button of buttons.querySelectorAll("[data-pc-request]")) {
      button.addEventListener("click", async event => {
        event.preventDefault();
        buttons.querySelectorAll("button").forEach(b => { b.disabled = true; });
        await resolveRequest(card.dataset.requestId, button.dataset.pcRequest === "approve");
      });
    }
  });
}
