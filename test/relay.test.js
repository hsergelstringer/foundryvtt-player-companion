/**
 * End-to-end tests: the real relay server (server/server.js) as a child
 * process, and the real module (module/scripts) loaded into a simulated
 * Foundry world, talking over WebSockets. Requests go through HTTP exactly as
 * the web app sends them.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Combat, installFoundry, startFoundry } from "./support/foundry.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SECRET = "test-secret-0123456789";

let relay;
let base;
let world;
let api;
let Items;
let Party;
const tokens = {};

const freePort = () => new Promise(resolve => {
  const server = createServer().listen(0, () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const waitFor = async (check, what, timeout = 5000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
};

/** Call the relay as the web app does. */
async function call(method, path, body, token = tokens.ursula, headers = {}) {
  const res = await fetch(`${base}/api/${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const act = (action, body, token) => call("POST", `actors/isen/${action}`, body, token);
const sheet = async () => (await call("GET", "actors/isen")).data;

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  relay = spawn(process.execPath, ["server.js"], {
    cwd: `${ROOT}/server`,
    env: { ...process.env, PORT: String(port), RELAY_SECRET: SECRET },
    stdio: ["ignore", "pipe", "inherit"]
  });
  await new Promise((resolve, reject) => {
    relay.stdout.on("data", chunk => { if (String(chunk).includes("listening")) resolve(); });
    relay.on("exit", code => reject(new Error(`Relay exited with ${code}`)));
  });

  world = installFoundry({ relayUrl: base, relaySecret: SECRET });
  await import("../module/scripts/main.js");
  Items = await import("../module/scripts/items.js");
  Party = await import("../module/scripts/party.js");
  startFoundry();
  api = game.modules.get("player-companion").api;
  await waitFor(() => api.Relay.status === "connected", "the module to connect to the relay");

  tokens.ursula = await api.Tokens.create(world.ursula, "Phone");
  tokens.other = await api.Tokens.create(world.other, "Phone");
});

after(() => {
  api?.Relay.disconnect();
  relay?.kill();
});

describe("relay and tokens", () => {
  test("health needs no token and reports Foundry connected", async () => {
    const { status, data } = await call("GET", "health", null, null);
    assert.equal(status, 200);
    assert.deepEqual(data, { relay: true, foundry: true, world: "Test World", images: false });
  });

  test("without FOUNDRY_URL, images aren't served", async () => {
    assert.equal((await call("GET", "images/icons/svg/d20.svg")).status, 404);
  });

  test("missing and unknown tokens are refused", async () => {
    assert.equal((await call("GET", "me", null, null)).status, 401);
    assert.equal((await call("GET", "me", null, "pc_not-a-real-token")).status, 401);
  });

  test("tokens are stored only as hashes", () => {
    const stored = JSON.stringify(world.ursula.flags);
    assert.ok(!stored.includes(tokens.ursula));
    assert.match(stored, /"hash":"[0-9a-f]{64}"/);
  });

  test("me lists only the user's own characters", async () => {
    assert.deepEqual((await call("GET", "me")).data.characters.map(c => c.id), ["isen"]);
    assert.deepEqual((await call("GET", "me", null, tokens.other)).data.characters.map(c => c.id), ["brann"]);
  });

  test("another player's character answers 404, for reads and changes", async () => {
    assert.equal((await call("GET", "actors/isen", null, tokens.other)).status, 404);
    assert.equal((await act("hp", { damage: 5 }, tokens.other)).status, 404);
    assert.equal((await act("itemDescription", { itemId: "hammer" }, tokens.other)).status, 404);
    assert.equal(world.isen.system.attributes.hp.value, 30);
  });

  test("unknown actions answer 404", async () => {
    assert.equal((await act("deleteEverything", {})).status, 404);
    assert.equal((await act("constructor", {})).status, 404);
  });

  test("large responses are gzipped", async () => {
    const res = await fetch(`${base}/api/actors/isen`, { headers: { Authorization: `Bearer ${tokens.ursula}`, "Accept-Encoding": "gzip" } });
    assert.equal(res.headers.get("content-encoding"), "gzip");
    assert.equal((await res.json()).name, "Isen Frostborn");
  });

  test("malformed URLs get 400, not a crash", async () => {
    assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
    assert.equal((await call("GET", "health", null, null)).status, 200);
  });
});

describe("the sheet", () => {
  test("has the calculated values", async () => {
    const s = await sheet();
    assert.equal(s.ac, 16);
    assert.equal(s.speed.walk, 30);
    assert.deepEqual(s.speed.all.map(x => x.key), ["walk", "swim"]);
    assert.deepEqual(s.spellcasting.classes.map(c => [c.name, c.dc, c.attack]), [["Cleric", 14, 6], ["Wizard", 12, 4]]);
    assert.equal(s.exhaustionMax, 6);
  });

  test("items carry details and summaries, but not descriptions", async () => {
    const hammer = (await sheet()).items.weapons[0];
    assert.equal(hammer.summary, "1d8 + 2 Bludgeoning · +5 to hit");
    assert.deepEqual(hammer.details.find(d => d.label === "Mastery"), { label: "Mastery", value: "Push" });
    assert.equal(hammer.activities.length, 2);
    assert.equal(hammer.hasDescription, true);
    assert.ok(!("descriptionHtml" in hammer));
  });

  test("traits: senses, damage defenses, conditions, languages and proficiencies", async () => {
    const { traits } = await sheet();
    assert.deepEqual(traits, {
      size: "Medium",
      senses: ["Darkvision 60 ft", "Sees invisible within 5 ft"],
      resistances: ["Fire", "Bludgeoning (except Magical or Silvered)"],
      immunities: ["Poison"],
      vulnerabilities: [],
      damageModifications: ["Slashing −3"],
      conditionImmunities: ["Frightened", "Charmed by fey"],
      languages: ["Common", "Dwarvish"],
      communication: ["Telepathy 30 ft"],
      proficiencies: { armor: ["Light Armor", "Shields"], weapons: ["Simple Weapons"], tools: ["Thieves' Tools"] }
    });
  });

  test("uses, activity uses and attunement are reported", async () => {
    const s = await sheet();
    const channel = s.items.features[0];
    assert.deepEqual(channel.uses, { value: 1, max: 2, recovery: "Short Rest" });
    assert.deepEqual(channel.activityUses, [{ id: "wrath", name: "Wrath of the Storm", value: 2, max: 3, recovery: "Long Rest" }]);
    assert.equal(s.items.equipment[0].attunement, "required");
  });
});

describe("changes", () => {
  test("damage uses temporary hit points first", async () => {
    const { data } = await act("hp", { damage: 7 });
    assert.deepEqual([data.hp.value, data.hp.temp], [28, 0]);
    await act("hp", { value: 30 });
    await act("hp", { temp: 5 });
  });

  test("healing stops at maximum", async () => {
    assert.equal((await act("hp", { heal: 999 })).data.hp.value, 44);
    await act("hp", { value: 30 });
  });

  test("bad input is a 400 with a message", async () => {
    for (const [action, body] of [["hp", {}], ["deathSaves", {}], ["spellSlot", { slot: "spell10", value: 1 }], ["inspiration", { value: "yes" }], ["itemQuantity", { itemId: "hammer", value: 1.5 }]]) {
      const { status, data } = await act(action, body);
      assert.equal(status, 400, `${action} ${JSON.stringify(body)}`);
      assert.ok(data.error);
    }
  });

  test("values are clamped to what's allowed", async () => {
    assert.equal((await act("spellSlot", { slot: "spell1", value: 99 })).data.spellSlots[0].value, 4);
    assert.equal((await act("exhaustion", { value: 40 })).data.exhaustion, 6);
    await act("exhaustion", { value: 0 });
  });

  test("item uses, activity uses, attunement and equipped", async () => {
    let s = (await act("itemUses", { itemId: "channel", value: 0 })).data;
    assert.equal(s.items.features[0].uses.value, 0);
    s = (await act("activityUses", { itemId: "channel", activityId: "wrath", value: 3 })).data;
    assert.equal(s.items.features[0].activityUses[0].value, 3);
    assert.equal((await act("activityUses", { itemId: "channel", activityId: "turn", value: 1 })).status, 400);
    s = (await act("itemAttuned", { itemId: "ring", value: true })).data;
    assert.equal(s.items.equipment[0].attuned, true);
    assert.equal((await act("itemAttuned", { itemId: "hammer", value: true })).status, 400);
    assert.equal((await act("itemEquipped", { itemId: "hammer", value: false })).data.items.weapons[0].equipped, false);
  });

  test("spell preparation toggles", async () => {
    assert.equal((await act("spellPrepared", { itemId: "bolt", value: false })).data.items.spells[0].preparation.prepared, false);
    assert.equal((await act("spellPrepared", { itemId: "hammer", value: true })).status, 400);
  });
});

describe("descriptions", () => {
  test("rolls are filled in from roll data, labels keep their formula", async () => {
    const { data } = await act("itemDescription", { itemId: "hammer" });
    assert.match(data.html, /<span class="roll">1d8 \+ 3<\/span>/);
    assert.match(data.html, /<span class="roll">two-handed \(1d10 \+ 3\)<\/span>/);
    assert.match(data.text, /Deals 1d8 \+ 3 damage/);
  });

  test("owners see secret blocks", async () => {
    assert.match((await act("itemDescription", { itemId: "hammer" })).data.html, /Cursed/);
  });

  test("scripts, handlers and images are stripped; enrichers and 5etools tags read as text", async () => {
    const { html } = (await act("itemDescription", { itemId: "channel" })).data;
    assert.doesNotMatch(html, /script|onclick|onerror|<img|alert/);
    assert.match(html, /<span class="roll">DC 14 DEX<\/span>/);
    assert.match(html, /<span class="roll">2d8<\/span> thunder/);
  });

  test("an item without a description says so", async () => {
    const { data } = await act("itemDescription", { itemId: "potion" });
    assert.deepEqual([data.html, data.text], ["", ""]);
  });
});

describe("compendium items", () => {
  test("search is accent- and case-insensitive and skips compendiums the player can't open", async () => {
    let { data } = await act("searchItems", { kind: "item", query: "EPEE" });
    assert.deepEqual(data.results.map(r => r.name), ["Épée of Testing"]);
    ({ data } = await act("searchItems", { kind: "item", query: "vorpal" }));
    assert.equal(data.total, 0);
    assert.deepEqual(data.packs.map(p => p.id), ["dnd5e.items"]);
  });

  test("search returns only items or only spells, and filters spell level", async () => {
    const items = (await act("searchItems", { kind: "item" })).data.results.map(r => r.type);
    assert.ok(!items.includes("feat") && !items.includes("spell"));
    assert.deepEqual((await act("searchItems", { kind: "spell", level: 0 })).data.results.map(r => r.name), ["Sacred Flame"]);
  });

  test("item details leave the price out", async () => {
    const { data } = await act("itemDetails", { uuid: "Compendium.dnd5e.items.Item.longsword" });
    assert.ok(data.details.length, "has other details");
    assert.ok(!data.details.some(d => d.label === "Price"));
  });

  test("hidden compendiums and features can't be fetched or added", async () => {
    assert.equal((await act("itemDetails", { uuid: "Compendium.world.secret.Item.vorpal" })).status, 404);
    assert.equal((await act("addItem", { uuid: "Compendium.dnd5e.items.Item.feature" })).status, 400);
    assert.equal((await act("addItem", { uuid: "Actor.isen" })).status, 404);
  });

  test("with GM approval, adding makes a request and a chat card; approving adds the item unequipped", async () => {
    await game.settings.set("player-companion", "itemChanges", "approve");
    const { data } = await act("addItem", { uuid: "Compendium.dnd5e.items.Item.longsword" });
    assert.match(data.notice, /Asked the GM to add Longsword/);
    const [request] = data.actor.itemChanges.requests;
    assert.equal(request.status, "pending");
    assert.ok(world.messages.some(m => m.flags["player-companion"]?.requestId === request.id));

    await Items.resolveRequest(request.id, true);
    const longsword = world.isen.items.find(i => i.name === "Longsword");
    assert.ok(longsword);
    assert.equal(longsword.system.equipped, undefined);
    assert.equal(longsword._stats.compendiumSource, "Compendium.dnd5e.items.Item.longsword");
    assert.deepEqual((await sheet()).itemChanges.requests, []);
    assert.match(world.messages.find(m => m.flags["player-companion"]?.requestId === request.id).content, /Approved by GM/);
  });

  test("simultaneous requests are all kept", async () => {
    const uuids = ["longsword", "potion", "epee", "longsword", "potion"].map(id => `Compendium.dnd5e.items.Item.${id}`);
    const results = await Promise.all(uuids.map(uuid => act("addItem", { uuid })));
    assert.ok(results.every(r => r.status === 200));
    assert.equal((await sheet()).itemChanges.requests.length, 5);
    for (const r of (await sheet()).itemChanges.requests) await act("cancelItemRequest", { requestId: r.id });
    assert.equal((await sheet()).itemChanges.requests.length, 0);
  });

  test("a denied request stays until dismissed", async () => {
    const { data } = await act("removeItem", { itemId: "hammer" });
    const id = data.actor.itemChanges.requests[0].id;
    assert.equal((await act("removeItem", { itemId: "hammer" })).status, 400, "asking twice is refused");
    await Items.resolveRequest(id, false);
    assert.equal((await sheet()).itemChanges.requests[0].status, "denied");
    assert.ok(world.isen.items.get("hammer"));
    await act("cancelItemRequest", { requestId: id });
    assert.equal((await sheet()).itemChanges.requests.length, 0);
  });

  test("with direct changes, consumables stack and the GM gets a note", async () => {
    await game.settings.set("player-companion", "itemChanges", "direct");
    const before = world.messages.size;
    const { data } = await act("addItem", { uuid: "Compendium.dnd5e.items.Item.potion" });
    assert.match(data.notice, /Added/);
    const { data: again } = await act("addItem", { uuid: "Compendium.dnd5e.items.Item.potion" });
    assert.match(again.notice, /existing Potion of Healing/);
    const potions = world.isen.items.filter(i => i._stats?.compendiumSource === "Compendium.dnd5e.items.Item.potion");
    assert.equal(potions.length, 1);
    assert.equal(world.messages.size, before + 2);
  });

  test("spells get a spellcasting method", async () => {
    await act("addItem", { uuid: "Compendium.dnd5e.spells.Item.cure" });
    assert.equal(world.isen.items.find(i => i.name === "Cure Wounds").system.method, "spell");
  });

  test("a custom item waits for approval, with what the player wrote on the GM's card", async () => {
    await game.settings.set("player-companion", "itemChanges", "approve");
    const { data } = await act("addCustomItem", { name: "  Grandmother's   locket ", description: "Silver, dented.\n\nOpens with a click." });
    assert.match(data.notice, /Asked the GM to add Grandmother's locket/);
    const [request] = data.actor.itemChanges.requests;
    const card = world.messages.find(m => m.flags["player-companion"]?.requestId === request.id).content;
    assert.match(card, /a custom item, <strong>Grandmother(&#x27;|')s locket<\/strong>, to/);
    assert.match(card, /Opens with a click/);

    await Items.resolveRequest(request.id, true);
    const locket = world.isen.items.find(i => i.name === "Grandmother's locket");
    assert.equal(locket.type, "loot");
    assert.equal(locket.system.price, undefined, "no price");
    assert.equal(locket.system.description.value, "<p>Silver, dented.</p><p>Opens with a click.</p>");
    await locket.delete();
  });

  test("a custom item's text can't run, roll or embed anything", async () => {
    await game.settings.set("player-companion", "itemChanges", "direct");
    const { data } = await act("addCustomItem", { name: "Note", description: "<script>x</script> [[/r 1d20]] @Embed[JournalEntry.secret] {@damage 2d6}\nline" });
    assert.equal(data.notice, "Added Note");
    const note = world.isen.items.find(i => i.name === "Note");
    const html = note.system.description.value;
    assert.ok(!html.includes("<script>") && !html.includes("[[") && !html.includes("@"), html);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /<br>line/);
    await note.delete();
    await game.settings.set("player-companion", "itemChanges", "approve");
  });

  test("custom items need a name, and a description that isn't too long", async () => {
    assert.equal((await act("addCustomItem", { name: "   " })).status, 400);
    assert.equal((await act("addCustomItem", { name: "x".repeat(101) })).status, 400);
    assert.equal((await act("addCustomItem", { name: "Gem", description: "x".repeat(4001) })).status, 400);
    assert.equal((await act("addCustomItem", { name: "Gem" }, tokens.other)).status, 404, "someone else's character");
  });

  test("with the setting off, nothing can be added or removed", async () => {
    await game.settings.set("player-companion", "itemChanges", "off");
    assert.equal((await act("addItem", { uuid: "Compendium.dnd5e.items.Item.longsword" })).status, 403);
    assert.equal((await act("addCustomItem", { name: "Gem" })).status, 403);
    assert.equal((await act("removeItem", { itemId: "hammer" })).status, 403);
    await game.settings.set("player-companion", "itemChanges", "approve");
  });
});

describe("trackers", () => {
  test("party trackers clamp into their range, including negatives", async () => {
    let fate = (await act("setTracker", { trackerId: "fate", scope: "world", value: -10 })).data.trackers.party.find(t => t.id === "fate");
    assert.equal(fate.value, -3);
    assert.equal(fate.band.label, "Chaos");
    fate = (await act("setTracker", { trackerId: "fate", scope: "world", value: 2 })).data.trackers.party.find(t => t.id === "fate");
    assert.equal(fate.band.label, "Order");
  });

  test("locked trackers are refused", async () => {
    assert.equal((await act("setTracker", { trackerId: "doom", scope: "world", value: 5 })).status, 403);
  });

  test("a player's change and a GM's new party tracker at the same moment both survive", async () => {
    const Trackers = await import("../module/scripts/trackers.js");
    await Promise.all([
      act("setTracker", { trackerId: "fate", scope: "world", value: 1 }),
      Trackers.saveWorldTracker({ name: "Storm", type: "pips", max: 4 })
    ]);
    const trackers = game.settings.get("player-companion", "worldTrackers");
    assert.ok(trackers.some(t => t.name === "Storm"), "the new tracker was kept");
    assert.equal(trackers.find(t => t.id === "fate").value, 1, "the player's change was kept");
  });

  test("players create and delete their own trackers", async () => {
    let s = (await act("createTracker", { name: "Luck", type: "counter", min: -2, max: 2 })).data;
    const luck = s.trackers.character.find(t => t.name === "Luck");
    assert.deepEqual([luck.min, luck.max, luck.value], [-2, 2, 0]);
    assert.equal((await act("setTracker", { trackerId: luck.id, scope: "actor", value: -5 })).data.trackers.character.find(t => t.id === luck.id).value, -2);
    s = (await act("deleteTracker", { trackerId: luck.id })).data;
    assert.ok(!s.trackers.character.some(t => t.id === luck.id));
  });

  test("players can't create trackers when the GM turns it off", async () => {
    await game.settings.set("player-companion", "allowPlayerTrackers", false);
    assert.equal((await act("createTracker", { name: "Nope" })).status, 403);
    await game.settings.set("player-companion", "allowPlayerTrackers", true);
  });
});

describe("party inventory", () => {
  const partyItem = (s, name) => Object.values(s.party.items).flat().find(i => i.name === name);
  const own = (name) => [...world.isen.items.values()].filter(i => i.name === name);

  test("the sheet shows the party's items, coin, members and log", async () => {
    const { party } = await sheet();
    assert.equal(party.name, "The Company");
    assert.equal(party.canEdit, true);
    assert.deepEqual(party.members.map(m => m.id), ["isen"]);
    assert.equal(party.currency.gp, 50);
    assert.deepEqual(party.items.consumables.map(i => [i.name, i.quantity, i.inParty]), [["Rations", 6, true]]);
    assert.ok(!partyItem({ party }, "Party Feature"), "features stay out of the stash");
    assert.deepEqual(party.log, []);
  });

  test("party items have inventory facts only, nothing that depends on a character", async () => {
    const spear = partyItem(await sheet(), "Spear");
    assert.equal(spear.summary, "Weapon · Common");
    assert.deepEqual(spear.details.map(d => d.label), ["Type", "Rarity", "Attunement", "Weight"]);
    for (const key of ["uses", "activityUses", "activities", "attunement", "attuned", "equipped", "removable"]) assert.ok(!(key in spear), key);
  });

  test("a character outside the party has none, and can't reach it", async () => {
    const brann = await call("GET", "actors/brann", null, tokens.other);
    assert.equal(brann.data.party, null);
    assert.equal((await call("POST", "actors/brann/takeFromParty", { itemId: "rations" }, tokens.other)).status, 404);
    assert.equal((await call("POST", "actors/brann/partyItemDescription", { itemId: "rations" }, tokens.other)).status, 404);
    // Nor through someone else's character.
    assert.equal((await act("takeFromParty", { itemId: "rations" }, tokens.other)).status, 404);
  });

  test("party descriptions never include secrets", async () => {
    const { data } = await act("partyItemDescription", { itemId: "rations" });
    assert.match(data.text, /One day of food/);
    assert.doesNotMatch(data.text, /Spoiled/);
  });

  test("giving part of a stack splits it, and the rest stacks onto it", async () => {
    let { status, data } = await act("giveToParty", { itemId: "arrows", quantity: 5 });
    assert.equal(status, 200);
    assert.equal(data.notice, "Gave 5 × Arrows to The Company");
    assert.equal(world.isen.items.get("arrows").system.quantity, 15);
    const given = partyItem(data.actor, "Arrows");
    assert.equal(given.quantity, 5);
    assert.equal(world.party.items.get(given.id).system.equipped, false, "arrives unequipped");

    ({ data } = await act("giveToParty", { itemId: "arrows" }));
    assert.equal(own("Arrows").length, 0);
    assert.equal(partyItem(data.actor, "Arrows").quantity, 20);
    assert.deepEqual(data.actor.party.log.map(e => [e.actor, e.user, e.text]),
      [["Isen Frostborn", "Ursula", "gave 15 × Arrows"], ["Isen Frostborn", "Ursula", "gave 5 × Arrows"]]);
  });

  test("taking moves items back, and can't take more than there are", async () => {
    let { data } = await act("takeFromParty", { itemId: partyItem(await sheet(), "Rations").id, quantity: 2 });
    assert.equal(data.notice, "Took 2 × Rations");
    assert.equal(partyItem(data.actor, "Rations").quantity, 4);
    assert.equal(own("Rations")[0].system.quantity, 2);

    const lantern = partyItem(data.actor, "Lantern").id;
    assert.equal((await act("takeFromParty", { itemId: lantern, quantity: 2 })).status, 400);
    ({ data } = await act("takeFromParty", { itemId: lantern }));
    assert.equal(partyItem(data.actor, "Lantern"), undefined);
    assert.equal(own("Lantern").length, 1);
  });

  test("only physical items can be given", async () => {
    assert.equal((await act("giveToParty", { itemId: "channel" })).status, 400);
    assert.equal((await act("giveToParty", { itemId: "bolt" })).status, 400);
    assert.equal((await act("giveToParty", { itemId: "nope" })).status, 404);
    assert.equal((await act("giveToParty", { itemId: "rope", quantity: 0 })).status, 200, "quantity is clamped to at least 1");
    assert.equal((await act("takeFromParty", { itemId: "partyfeat" })).status, 404);
  });

  test("two players taking the last one: only one gets it", async () => {
    const rope = partyItem(await sheet(), "Rope").id;
    const results = await Promise.all([act("takeFromParty", { itemId: rope }), act("takeFromParty", { itemId: rope })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 404]);
    assert.equal(own("Rope").length, 1);
  });

  test("coin moves both ways, and can't overdraw", async () => {
    let { status, data } = await act("moveCurrency", { direction: "toParty", gp: 20, sp: 4 });
    assert.equal(status, 200);
    assert.equal(data.notice, "Put 20 gp, 4 sp in The Company");
    assert.equal(data.actor.party.currency.gp, 70);
    assert.equal(data.actor.currency.gp, world.isen.system.currency.gp);

    const gp = world.isen.system.currency.gp;
    ({ data } = await act("moveCurrency", { direction: "fromParty", gp: 10 }));
    assert.equal(data.actor.currency.gp, gp + 10);
    assert.equal(data.actor.party.currency.gp, 60);

    const over = await act("moveCurrency", { direction: "fromParty", pp: 1 });
    assert.equal(over.status, 400);
    assert.equal(over.data.error, "The party has only 0 pp");
    assert.equal((await act("moveCurrency", { direction: "sideways", gp: 1 })).status, 400);
    assert.equal((await act("moveCurrency", { direction: "toParty" })).status, 400);
  });

  test("members set quantities and coin, and it's logged", async () => {
    const rations = partyItem(await sheet(), "Rations").id;
    let { data } = await act("partyQuantity", { itemId: rations, value: 3 });
    assert.equal(partyItem(data, "Rations").quantity, 3);
    ({ data } = await act("partyCurrency", { gp: 200 }));
    assert.equal(data.party.currency.gp, 200);
    assert.deepEqual(data.party.log.slice(0, 2).map(e => e.text), ["changed the coin: gp 60 → 200", "changed Rations from 4 to 3"]);
  });

  test("a group the player owns opens as just its gear and money", async () => {
    world.party.owners.add("other");
    try {
      assert.ok((await call("GET", "me", null, tokens.other)).data.characters.some(c => c.id === "party"));
      const { status, data } = await call("GET", "actors/party", null, tokens.other);
      assert.equal(status, 200);
      assert.deepEqual(Object.keys(data).sort(), ["id", "img", "name", "party", "type"]);
      assert.equal(data.party.id, "party");
      assert.ok(partyItem(data, "Spear"));

      const groupAct = (action, body) => call("POST", `actors/party/${action}`, body, tokens.other);
      const changed = await groupAct("partyQuantity", { itemId: partyItem(data, "Rations").id, value: 2 });
      assert.equal(changed.status, 200);
      assert.equal(changed.data.party.log[0].actor, "Other", "credited to the player, not the group");
      assert.equal((await groupAct("partyItemDescription", { itemId: partyItem(data, "Rations").id })).status, 200);
      // Moving needs a character on the other end.
      assert.equal((await groupAct("takeFromParty", { itemId: partyItem(data, "Rations").id })).status, 400);
      assert.equal((await groupAct("moveCurrency", { direction: "fromParty", gp: 1 })).status, 400);
    }
    finally {
      world.party.owners.delete("other");
    }
  });

  test("compendium items can be added straight to the party, but not spells", async () => {
    await game.settings.set("player-companion", "itemChanges", "direct");
    const owned = own("Longsword").length;
    const { status, data } = await act("addItem", { uuid: "Compendium.dnd5e.items.Item.longsword", toParty: true });
    assert.equal(status, 200);
    assert.equal(data.notice, "Added Longsword to The Company");
    assert.ok(partyItem(data.actor, "Longsword"));
    assert.equal(own("Longsword").length, owned, "the character doesn't get it");
    await waitFor(() => Party.partyLog(world.party)[0]?.text === "added Longsword", "the log entry");
    assert.equal(Party.partyLog(world.party)[0].actor, "Isen Frostborn");

    assert.equal((await act("addItem", { uuid: "Compendium.dnd5e.spells.Item.cure", toParty: true })).status, 400);
    assert.equal((await act("addItem", { uuid: "Compendium.dnd5e.items.Item.longsword", toParty: true }, tokens.other)).status, 404);
  });

  test("custom items can go to the party", async () => {
    await game.settings.set("player-companion", "itemChanges", "direct");
    const { data } = await act("addCustomItem", { name: "Strange map", toParty: true });
    assert.equal(data.notice, "Added Strange map to The Company");
    assert.ok(partyItem(data.actor, "Strange map"));
    await waitFor(() => Party.partyLog(world.party)[0]?.text === "added Strange map", "the log entry");
  });

  test("with GM approval, a party add waits as a request only its maker can withdraw", async () => {
    await game.settings.set("player-companion", "itemChanges", "approve");
    const { data } = await act("addItem", { uuid: "Compendium.dnd5e.items.Item.potion", quantity: 2, toParty: true });
    assert.equal(data.notice, "Asked the GM to add Potion of Healing (×2) to The Company");
    const [request] = data.actor.party.requests;
    assert.equal(request.mine, true);
    assert.deepEqual(data.actor.itemChanges.requests, [], "it's the party's request, not the character's");

    // Another player who owns the group sees it but can't withdraw it.
    world.party.owners.add("other");
    try {
      const theirs = await call("GET", "actors/party", null, tokens.other);
      assert.equal(theirs.data.party.requests[0].mine, false);
      assert.equal((await call("POST", "actors/party/cancelItemRequest", { requestId: request.id }, tokens.other)).status, 404);
    }
    finally {
      world.party.owners.delete("other");
    }

    await Items.resolveRequest(request.id, true);
    const after = await sheet();
    assert.equal(partyItem(after, "Potion of Healing").quantity, 2);
    assert.deepEqual(after.party.requests, []);
    await waitFor(() => Party.partyLog(world.party)[0]?.text === "added 2 × Potion of Healing", "the approved add in the log");
    assert.equal(Party.partyLog(world.party)[0].actor, "Isen Frostborn");
  });

  test("view-only and off", async () => {
    await game.settings.set("player-companion", "partyInventory", "view");
    const viewing = await sheet();
    assert.equal(viewing.party.canEdit, false);
    assert.equal((await act("partyQuantity", { itemId: partyItem(viewing, "Rations").id, value: 1 })).status, 403);
    assert.equal((await act("giveToParty", { itemId: "rope" })).status, 403);
    assert.equal(viewing.party.addMode, "off");
    assert.equal((await act("addItem", { uuid: "Compendium.dnd5e.items.Item.longsword", toParty: true })).status, 403);

    await game.settings.set("player-companion", "partyInventory", "off");
    assert.equal((await sheet()).party, null);
    assert.equal((await act("moveCurrency", { direction: "toParty", gp: 1 })).status, 404);
    await game.settings.set("player-companion", "partyInventory", "edit");
  });

  test("a change to the party in Foundry reaches its members' streams", async () => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/events`);
    const messages = [];
    socket.addEventListener("message", e => messages.push(JSON.parse(e.data)));
    await new Promise(resolve => socket.addEventListener("open", resolve));
    socket.send(JSON.stringify({ type: "auth", token: tokens.ursula }));
    await waitFor(() => messages.some(m => m.type === "ready"), "ready");

    await world.party.update({ "system.currency.cp": 7 });
    await waitFor(() => messages.some(m => m.type === "actorChanged" && m.actorId === "party"), "actorChanged");
    assert.deepEqual(messages.find(m => m.actorId === "party").memberIds, ["isen"]);
    socket.close();
  });
});

describe("combat", () => {
  const combat = () => call("GET", "combat");
  const setInit = (body, actorId = "isen", token) => call("POST", `actors/${actorId}/initiative`, body, token);
  const setMode = mode => game.settings.set("player-companion", "combatTracker", mode);

  /** Isen (Ursula's), Brann (Other's), a hidden ambusher and an ogre (Other's, standing in for NPCs), and a marker. */
  function fight(data = {}) {
    game.combat = new Combat({
      round: 2, turn: 0, started: true, ...data,
      combatants: [
        { id: "c-isen", name: "Isen Frostborn", actorId: "isen", initiative: 15.16 },
        { id: "c-brann", name: "Brann", actorId: "brann", initiative: 12 },
        { id: "c-ambush", name: "Ambusher", actorId: "brann", initiative: 20, hidden: true },
        { id: "c-bless", name: "Bless ends", initiative: 14.99, img: "icons/svg/clockwork.svg" },
        { id: "c-ogre", name: "Ogre", actorId: "brann", initiative: null }
      ]
    });
    return game.combat;
  }

  after(() => { game.combat = null; });

  test("no combat answers combat: null", async () => {
    game.combat = null;
    assert.deepEqual((await combat()).data, { combat: null, canSetInitiative: true });
  });

  test("shows the order as Foundry shows it to the player, without others' details", async () => {
    fight();
    const { data } = await combat();
    assert.equal(data.combat.round, 2);
    assert.deepEqual(data.combat.combatants.map(c => c.id), ["c-isen", "c-bless", "c-brann", "c-ogre"], "the hidden ambusher is left out");
    const [isen, bless, brann, ogre] = data.combat.combatants;
    assert.deepEqual([isen.mine, isen.actorId, brann.mine, brann.actorId], [true, "isen", false, null]);
    assert.equal(bless.reminder, true);
    assert.equal(bless.img, "https://foundry.test/icons/svg/clockwork.svg");
    assert.equal(ogre.initiative, null);
    assert.ok(!JSON.stringify(data).includes("hp"), "no hit points");
  });

  test("a hidden combatant's turn isn't shown, but up next is", async () => {
    fight({ turn: 0 }); // the ambusher, highest initiative
    const { data } = await combat();
    assert.equal(data.combat.currentId, null);
    assert.equal(data.combat.nextId, "c-isen");
  });

  test("the owner sees their hidden combatant", async () => {
    fight();
    const { data } = await call("GET", "combat", null, tokens.other);
    const ambusher = data.combat.combatants.find(c => c.id === "c-ambush");
    assert.deepEqual([ambusher?.hidden, ambusher?.mine], [true, true]);
  });

  test("up next skips reminders and the defeated", async () => {
    const c = fight({ turn: 1 }); // Isen
    c.combatants.get("c-brann").defeated = true;
    const { data } = await combat();
    assert.equal(data.combat.currentId, "c-isen");
    assert.equal(data.combat.nextId, "c-ogre");
    assert.equal(data.combat.combatants.find(x => x.id === "c-brann").defeated, true);
  });

  test("before it starts there's no current turn", async () => {
    fight({ started: false, round: 0 });
    const { data } = await combat();
    assert.deepEqual([data.combat.started, data.combat.currentId, data.combat.nextId], [false, null, null]);
  });

  test("a player enters their initiative, and the order follows", async () => {
    const c = fight();
    const { status, data } = await setInit({ combatantId: "c-isen", value: 22 });
    assert.equal(status, 200);
    assert.equal(c.combatants.get("c-isen").initiative, 22);
    assert.equal(data.combat.combatants[0].id, "c-isen");
  });

  test("dnd5e's dexterity tiebreaker is added", async () => {
    const c = fight();
    game.settings.values.set("initiativeDexTiebreaker", true);
    try {
      await setInit({ combatantId: "c-isen", value: 11 });
      assert.equal(c.combatants.get("c-isen").initiative, 11.16);
    }
    finally { game.settings.values.delete("initiativeDexTiebreaker"); }
  });

  test("only for your own combatants", async () => {
    const c = fight();
    assert.equal((await setInit({ combatantId: "c-brann", value: 1 })).status, 404, "your character, someone else's combatant");
    assert.equal((await setInit({ combatantId: "c-brann", value: 1 }, "brann")).status, 404, "someone else's character");
    assert.equal((await setInit({ combatantId: "nope", value: 1 })).status, 404);
    assert.equal(c.combatants.get("c-brann").initiative, 12);
  });

  test("bad values are refused", async () => {
    fight();
    assert.equal((await setInit({ combatantId: "c-isen", value: "high" })).status, 400);
    assert.equal((await setInit({ combatantId: "c-isen", value: 4.5 })).status, 400);
  });

  test("view only, and off", async () => {
    const c = fight();
    try {
      await setMode("view");
      assert.equal((await combat()).data.canSetInitiative, false);
      assert.equal((await setInit({ combatantId: "c-isen", value: 3 })).status, 403);
      await setMode("off");
      assert.equal((await combat()).data.combat, null);
      assert.equal((await setInit({ combatantId: "c-isen", value: 3 })).status, 403);
      assert.equal(c.combatants.get("c-isen").initiative, 15.16);
    }
    finally { await setMode("edit"); }
  });

  test("changes reach every player's event stream", async () => {
    const c = fight();
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/events`);
    const messages = [];
    socket.addEventListener("message", e => messages.push(JSON.parse(e.data)));
    await new Promise(resolve => socket.addEventListener("open", resolve));
    socket.send(JSON.stringify({ type: "auth", token: tokens.other }));
    await waitFor(() => messages.some(m => m.type === "ready"), "ready");
    await c.update({ turn: 2 });
    await waitFor(() => messages.some(m => m.type === "combatChanged"), "combatChanged");
    socket.close();
  });
});

describe("live events and revoking", () => {
  test("a change in Foundry reaches the player's event stream", async () => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/events`);
    const messages = [];
    socket.addEventListener("message", e => messages.push(JSON.parse(e.data)));
    await new Promise(resolve => socket.addEventListener("open", resolve));
    socket.send(JSON.stringify({ type: "auth", token: tokens.ursula }));
    await waitFor(() => messages.some(m => m.type === "ready"), "ready");

    await world.isen.update({ "system.attributes.inspiration": true });
    await waitFor(() => messages.some(m => m.type === "actorChanged" && m.actorId === "isen"), "actorChanged");
    socket.close();
  });

  test("another player's stream doesn't hear about this character", async () => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/events`);
    const messages = [];
    socket.addEventListener("message", e => messages.push(JSON.parse(e.data)));
    await new Promise(resolve => socket.addEventListener("open", resolve));
    socket.send(JSON.stringify({ type: "auth", token: tokens.other }));
    await waitFor(() => messages.some(m => m.type === "ready"), "ready");
    await world.isen.update({ "system.attributes.inspiration": false });
    await new Promise(r => setTimeout(r, 600));
    assert.ok(!messages.some(m => m.type === "actorChanged"));
    socket.close();
  });

  test("a revoked token stops working at once and its stream is closed", async () => {
    const token = await api.Tokens.create(world.ursula, "Old phone");
    assert.equal((await call("GET", "me", null, token)).status, 200);

    const socket = new WebSocket(`${base.replace("http", "ws")}/api/events`);
    let closedWith = null;
    socket.addEventListener("close", e => { closedWith = e.code; });
    await new Promise(resolve => socket.addEventListener("open", resolve));
    socket.send(JSON.stringify({ type: "auth", token }));
    await new Promise(r => setTimeout(r, 200));

    const id = api.Tokens.list(world.ursula).find(t => t.label === "Old phone").id;
    await api.Tokens.revoke(world.ursula, id);
    assert.equal((await call("GET", "me", null, token)).status, 401);
    await waitFor(() => closedWith !== null, "the stream to close");
    assert.equal(closedWith, 4001);
    assert.equal((await call("GET", "me")).status, 200, "the user's other tokens still work");
  });
});
