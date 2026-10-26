/**
 * The combat tracker in the web app: the turn order of the combat on the
 * scene the GM is viewing, and players entering their own initiative (they
 * roll at the table).
 *
 * Players see what Foundry's own tracker shows them: hidden combatants are
 * left out unless they own them, and nobody else's hit points are sent.
 * Combatants with no actor, like the Heroic Tracker's effect markers, show
 * as reminders.
 *
 * The world setting "combatTracker" decides what players can do:
 *  - "edit": see the order and enter their own characters' initiative (default).
 *  - "view": see the order; initiative is entered in Foundry.
 *  - "off":  the web app doesn't show combat.
 */

import { RelayError } from "./errors.js";

const MODULE_ID = "player-companion";
const NOTIFY_DELAY_MS = 300;

export const combatMode = () => game.settings.get(MODULE_ID, "combatTracker");

/** The combat players see: the one on the scene the GM is viewing, as in Foundry's tracker. */
export function currentCombat() {
  if (combatMode() === "off") return null;
  return game.combat ?? null;
}

export const ownsCombatant = (combatant, user) => !!combatant.actor?.testUserPermission(user, "OWNER");

/** Whether Foundry's tracker would show this combatant to the user. */
export const visibleTo = (combatant, user) => user.isGM || !combatant.hidden || ownsCombatant(combatant, user);

/**
 * The combatant after the current one who gets a turn and that the user can
 * see: "up next". Skips defeated combatants and reminders, wrapping to the top.
 */
export function nextCombatant(combat, user) {
  const turns = combat.turns ?? [];
  if (!combat.started || !turns.length) return null;
  const at = Math.max(0, combat.turn ?? 0);
  for (let step = 1; step < turns.length; step++) {
    const c = turns[(at + step) % turns.length];
    if (c.actor && !isDefeated(c) && visibleTo(c, user)) return c;
  }
  return null;
}

export const isDefeated = combatant => !!(combatant.isDefeated ?? combatant.defeated);

/**
 * Set the initiative a player rolled at the table, for their own combatant.
 * With dnd5e's dexterity tiebreaker on, the tiebreaker is added as dnd5e does.
 */
export async function setInitiative(user, actor, combatantId, value) {
  if (combatMode() !== "edit") throw new RelayError(403, "The GM enters initiative in Foundry");
  const combat = currentCombat();
  if (!combat) throw new RelayError(404, "There's no combat running");
  const combatant = combat.combatants.get(String(combatantId ?? ""));
  // Same answer for "not in this combat" and "not this character's", so ids can't be probed.
  if (!combatant || combatant.actorId !== actor.id || !ownsCombatant(combatant, user)) {
    throw new RelayError(404, `${actor.name} isn't in the combat`);
  }
  await combat.setInitiative(combatant.id, value + tiebreaker(combatant.actor ?? actor));
  return combat;
}

function tiebreaker(actor) {
  try {
    if (!game.settings.get("dnd5e", "initiativeDexTiebreaker")) return 0;
  }
  catch { return 0; }
  const dex = Number(actor.system.abilities?.dex?.value);
  return Number.isFinite(dex) ? dex / 100 : 0;
}

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

let queued = null;

/** Tell the web apps the combat changed, once per burst of changes (a new round updates several documents). */
function changed() {
  clearTimeout(queued);
  queued = setTimeout(() => {
    queued = null;
    Hooks.callAll(`${MODULE_ID}.combatChanged`);
  }, NOTIFY_DELAY_MS);
}

export function setupCombat() {
  for (const hook of ["createCombat", "updateCombat", "deleteCombat", "createCombatant", "updateCombatant", "deleteCombatant"]) {
    Hooks.on(hook, changed);
  }
  // Viewing another scene can change which combat is shown.
  Hooks.on("canvasReady", changed);
}

export function registerCombatSettings() {
  game.settings.register(MODULE_ID, "combatTracker", {
    name: "Combat tracker in the web app",
    hint: "Shows the turn order of the combat on the scene the GM is viewing, as players see it in Foundry. Players can enter the initiative they rolled at the table for their own characters.",
    scope: "world", config: true, type: String, default: "edit",
    choices: {
      edit: "Players see the order and enter their initiative",
      view: "Players only see the order",
      off: "Off"
    },
    onChange: changed
  });
}
