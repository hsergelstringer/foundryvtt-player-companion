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
import { installFoundry, startFoundry } from "./support/foundry.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SECRET = "test-secret-0123456789";

let relay;
let base;
let world;
let api;
let Items;
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
    assert.deepEqual(data, { relay: true, foundry: true, world: "Test World" });
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
    assert.deepEqual((await call("GET", "me", null, tokens.other)).data.characters, []);
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

  test("with the setting off, nothing can be added or removed", async () => {
    await game.settings.set("player-companion", "itemChanges", "off");
    assert.equal((await act("addItem", { uuid: "Compendium.dnd5e.items.Item.longsword" })).status, 403);
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
