/**
 * The party's shared inventory: the items and coin on a dnd5e Group actor.
 *
 * A character's party is the group actor it is a member of, dnd5e's primary
 * party first. Players don't own the group in Foundry, so the web app reaches
 * it through their own character: every action names the character, and the
 * module checks that the character is a member before touching the group.
 *
 * The world setting "partyInventory" decides what members can do:
 *  - "edit": give items and coin to the party, take them out, and change
 *            quantities and coin (default).
 *  - "view": see the party's inventory; only the GM changes it, in Foundry.
 *  - "off":  the web app doesn't show the party.
 *
 * Every change made from the web app is logged on the group, in
 * flags.player-companion.partyLog (newest first, the last 50), so the table
 * can see who took what.
 */

import { RelayError } from "./errors.js";
import { ITEM_TYPES } from "./items.js";
import { serial } from "./serial.js";

const MODULE_ID = "player-companion";
const LOG_FLAG = "partyLog";
const LOG_SIZE = 50;
export const COINS = ["pp", "gp", "ep", "sp", "cp"];
/** Item types that merge into a matching item instead of arriving as a second copy. */
const STACKABLE = new Set(["consumable", "loot"]);

const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
const hasQuantity = item => "quantity" in item.system;
const quantityOf = item => (hasQuantity(item) ? num(item.system.quantity) : 1);
const named = (item, count) => (count > 1 ? `${count} × ${item.name}` : item.name);
const coinText = coins => COINS.filter(k => coins[k]).map(k => `${coins[k]} ${k}`).join(", ");

export const partyMode = () => game.settings.get(MODULE_ID, "partyInventory");

/** Every change to a party's items, coin or log goes through here, one at a time (see serial.js). */
const withParty = serial();

/* -------------------------------------------- */
/*  Finding the party                           */
/* -------------------------------------------- */

/** Member actor ids. dnd5e stores members as [{ actor }], where actor is the document, or its id if it's gone. */
function memberIds(group) {
  return [...(group.system.members ?? [])]
    .map(member => member?.actor ?? member)
    .map(actor => (typeof actor === "string" ? actor : actor?.id))
    .filter(Boolean);
}

function primaryParty() {
  try {
    const actor = game.settings.get("dnd5e", "primaryParty")?.actor;
    return typeof actor === "string" ? game.actors.get(actor) : actor ?? null;
  }
  catch { return null; }
}

/** The group a character belongs to, or null. A group the player owns and opens directly is its own party. */
export function partyOf(actor) {
  if (partyMode() === "off") return null;
  if (actor.type === "group") return actor;
  const groups = game.actors.filter(a => a.type === "group" && a.system.type?.value !== "encounter" && memberIds(a).includes(actor.id));
  const primary = primaryParty();
  return groups.find(g => g === primary) ?? groups.sort((a, b) => a.name.localeCompare(b.name))[0] ?? null;
}

/** The members a group's change should reach. */
export function membersOf(group) {
  return memberIds(group).map(id => game.actors.get(id)).filter(Boolean);
}

/** @param {object} [options]  `edit` to change the party; `move` to move things between it and a character. */
function requireParty(actor, { edit = false, move = false } = {}) {
  const party = partyOf(actor);
  // Same answer for "no party" and "the setting is off".
  if (!party) throw new RelayError(404, `${actor.name} isn't in a party`);
  if (edit && partyMode() !== "edit") throw new RelayError(403, "Only the GM can change the party's inventory");
  if (move && party === actor) throw new RelayError(400, "Open a character to move things in or out of the party");
  return party;
}

export const partyItems = group => group.items.filter(i => ITEM_TYPES.has(i.type));

export function partyItem(actor, itemId) {
  const item = requireParty(actor).items.get(itemId);
  if (!item || !ITEM_TYPES.has(item.type)) throw new RelayError(404, "That item isn't in the party's inventory");
  return item;
}

export const partyLog = group => group.getFlag(MODULE_ID, LOG_FLAG) ?? [];

async function log(group, user, actor, text) {
  // Changes made on the group itself are credited to the player rather than the group.
  const who = actor === group ? user.name : actor.name;
  const entry = { id: foundry.utils.randomID(), at: Date.now(), user: user.name, actor: who, text };
  await group.setFlag(MODULE_ID, LOG_FLAG, [entry, ...partyLog(group)].slice(0, LOG_SIZE));
}

/* -------------------------------------------- */
/*  Moving items                                */
/* -------------------------------------------- */

/** An item on the target that this one should stack onto: same type, name and compendium source, not in a container. */
function stackTarget(item, target) {
  if (!STACKABLE.has(item.type) || !hasQuantity(item)) return null;
  const source = item._stats?.compendiumSource ?? null;
  return target.items.find(i => i.type === item.type && i.name === item.name && hasQuantity(i) && !i.system.container
    && (i._stats?.compendiumSource ?? null) === source) ?? null;
}

/** Item data for the receiving actor: out of any container, unequipped, unattuned, with the moved quantity. */
function arriving(data, count) {
  const system = data.system ?? {};
  foundry.utils.deleteProperty(system, "container");
  for (const key of ["attuned", "equipped"]) if (key in system) system[key] = false;
  if ("quantity" in system) system.quantity = count;
  return data;
}

/**
 * Move some or all of an item to another actor. Moving all of it brings a
 * container's contents along; moving part of a stack moves only that item.
 */
async function moveItem(item, target, count) {
  const whole = count >= quantityOf(item);
  const stack = stackTarget(item, target);
  const Item5e = CONFIG.Item.documentClass;

  if (stack) await stack.update({ "system.quantity": quantityOf(stack) + count });
  else if (whole) {
    // New ids, with contents pointed at their new container, as dnd5e does when dragging between actors.
    const data = await Item5e.createWithContents([item], { transformFirst: doc => arriving(doc.toObject(), count) });
    await Item5e.createDocuments(data, { parent: target, keepId: true });
  }
  else {
    const data = arriving(item.toObject(), count);
    delete data._id;
    await Item5e.createDocuments([data], { parent: target });
  }

  if (whole) await item.delete({ deleteContents: true });
  else await item.update({ "system.quantity": quantityOf(item) - count });
}

function countToMove(item, quantity) {
  const total = quantityOf(item);
  const count = quantity ?? total;
  if (count > total) throw new RelayError(400, `There ${total === 1 ? "is" : "are"} only ${total}`);
  if (count < 1) throw new RelayError(400, `There are no ${item.name} left to move`);
  return count;
}

/**
 * Give one of the character's items to the party.
 * @param {number|null} quantity  How many; null for all of them
 * @returns {Promise<string>}  What happened, to show the player
 */
export function give(user, actor, itemId, quantity) {
  return withParty(async () => {
    const party = requireParty(actor, { edit: true, move: true });
    const item = actor.items.get(itemId);
    if (!item) throw new RelayError(404, "Item not found");
    if (!ITEM_TYPES.has(item.type)) throw new RelayError(400, "Only items can go in the party's inventory");
    const count = countToMove(item, quantity);
    await moveItem(item, party, count);
    await log(party, user, actor, `gave ${named(item, count)}`);
    return `Gave ${named(item, count)} to ${party.name}`;
  });
}

/** Take an item, or some of a stack, out of the party's inventory. */
export function take(user, actor, itemId, quantity) {
  return withParty(async () => {
    const party = requireParty(actor, { edit: true, move: true });
    const item = partyItem(actor, itemId);
    const count = countToMove(item, quantity);
    await moveItem(item, actor, count);
    await log(party, user, actor, `took ${named(item, count)}`);
    return `Took ${named(item, count)}`;
  });
}

/** Set how many of a party item there are, e.g. when the party eats a ration. */
export function setQuantity(user, actor, itemId, value) {
  return withParty(async () => {
    const party = requireParty(actor, { edit: true });
    const item = partyItem(actor, itemId);
    if (!hasQuantity(item)) throw new RelayError(400, "That item has no quantity");
    const before = quantityOf(item);
    if (before === value) return;
    await item.update({ "system.quantity": value });
    await log(party, user, actor, `changed ${item.name} from ${before} to ${value}`);
  });
}

/* -------------------------------------------- */
/*  Coin                                        */
/* -------------------------------------------- */

/**
 * Move coin between the character and the party.
 * @param {"toParty"|"fromParty"} direction
 * @param {Record<string, number>} coins  Validated amounts of pp, gp, ep, sp, cp
 */
export function moveCoins(user, actor, direction, coins) {
  return withParty(async () => {
    const party = requireParty(actor, { edit: true, move: true });
    const [from, to] = direction === "toParty" ? [actor, party] : [party, actor];
    const fromUpdate = {};
    const toUpdate = {};
    for (const key of COINS) {
      const amount = coins[key] ?? 0;
      if (!amount) continue;
      const has = num(from.system.currency?.[key]);
      if (amount > has) throw new RelayError(400, `${from === party ? "The party has" : `${actor.name} has`} only ${has} ${key}`);
      fromUpdate[`system.currency.${key}`] = has - amount;
      toUpdate[`system.currency.${key}`] = num(to.system.currency?.[key]) + amount;
    }
    if (!Object.keys(fromUpdate).length) throw new RelayError(400, "Send at least one of pp, gp, ep, sp, cp");
    await from.update(fromUpdate);
    await to.update(toUpdate);
    const what = coinText(coins);
    await log(party, user, actor, direction === "toParty" ? `put in ${what}` : `took out ${what}`);
    return direction === "toParty" ? `Put ${what} in ${party.name}` : `Took ${what} from ${party.name}`;
  });
}

/** Set the party's coin, e.g. to add treasure the party found. */
export function setCoins(user, actor, coins) {
  return withParty(async () => {
    const party = requireParty(actor, { edit: true });
    const update = {};
    const changes = [];
    for (const key of COINS) {
      if (coins[key] === undefined) continue;
      const before = num(party.system.currency?.[key]);
      if (before === coins[key]) continue;
      update[`system.currency.${key}`] = coins[key];
      changes.push(`${key} ${before} → ${coins[key]}`);
    }
    if (!changes.length) return;
    await party.update(update);
    await log(party, user, actor, `changed the coin: ${changes.join(", ")}`);
  });
}

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

export function registerPartySettings() {
  game.settings.register(MODULE_ID, "partyInventory", {
    name: "Party inventory in the web app",
    hint: "The party is the Group actor a character belongs to (dnd5e's primary party first). Members see its items and coin, and can give and take them.",
    scope: "world", config: true, type: String, default: "edit",
    choices: {
      edit: "Members give and take items and coin",
      view: "Members can only look",
      off: "Off"
    },
    onChange: () => Hooks.callAll(`${MODULE_ID}.partyChanged`)
  });
}
