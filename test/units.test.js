/**
 * Unit tests for the pieces that don't need a relay: the description
 * converter, tracker rules, the write queue and SHA-256.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { installFoundry } from "./support/foundry.js";

installFoundry();
const { describe: describeItem, toPlainText } = await import("../module/scripts/text.js");
const Trackers = await import("../module/scripts/trackers.js");
const { serial } = await import("../module/scripts/serial.js");
const { sha256Hex } = await import("../module/scripts/sha256.js");

const item = (html, extra = {}) => new Item({ name: "Test", type: "feat", system: { description: { value: html } }, ...extra });
const html = async (source, options) => (await describeItem(item(source), options)).html;

describe("descriptions", () => {
  test("deferred and immediate inline rolls show their formula, never a rolled result", async () => {
    assert.equal(await html("<p>[[/r 1d6]] or [[2d4 + 1]]</p>"), '<p><span class="roll">1d6</span> or <span class="roll">2d4 + 1</span></p>');
  });

  test("roll data fills in @ references", async () => {
    assert.equal(await html("<p>[[/r 1d8 + @mod + @prof]]</p>"), '<p><span class="roll">1d8 + 3 + 3</span></p>');
  });

  test("5etools tags become readable text", async () => {
    const out = await html("<p>{@atk mw} {@hit 5} to hit. {@h}{@damage 1d8 + 3} slashing. DC {@dc 13}. See {@spell fireball|xphb|Fireball} and {@condition prone}. {@b Bold {@i nested}}.</p>");
    assert.equal(out, '<p>Melee Weapon Attack: <span class="roll">+5</span> to hit. Hit: <span class="roll">1d8 + 3</span> slashing. <span class="roll">DC 13</span>. '
      + 'See <span class="ref">Fireball</span> and <span class="ref">prone</span>. <strong>Bold <em>nested</em></strong>.</p>');
  });

  test("document links become names; icons and request buttons are dropped", async () => {
    assert.equal(await html("<p>@UUID[Compendium.x.Item.y]{Longsword} [[/save dex 15]]</p>"),
      '<p><span class="ref">Longsword</span> <span class="roll">DC 15 DEX</span></p>');
  });

  test("dangerous markup is removed", async () => {
    const out = await html('<p onclick="alert(1)" style="color:red">Hi<script>alert(2)</script><img src=x onerror="alert(3)"><iframe src="https://evil"></iframe>'
      + '<a href="javascript:alert(4)">js</a> <a href="https://example.com" onclick="x()">web</a></p>');
    assert.equal(out, '<p>Hi<span class="ref">js</span> <a href="https://example.com">web</a></p>');
  });

  test("layout is kept, empty paragraphs and wrapper divs are not", async () => {
    assert.equal(await html("<div><div><p>One</p></div></div><p></p><p>&nbsp;</p><ul><li>A</li></ul><table><tbody><tr><td>1</td></tr></tbody></table>"),
      "<p>One</p><ul><li>A</li></ul><table><tbody><tr><td>1</td></tr></tbody></table>");
  });

  test("secret blocks only reach owners", async () => {
    const source = '<p>Open</p><section class="secret"><p>Hidden</p></section>';
    assert.equal(await html(source), "<p>Open</p>");
    assert.equal(await html(source, { secrets: true }), "<p>Open</p><p>Hidden</p>");
  });

  test("plain text keeps line breaks and table cells apart", () => {
    assert.equal(toPlainText("<p>One</p><p>Two</p><table><tr><td>a</td><td>b</td></tr></table>"), "One\nTwo\na\tb");
  });

  test("results are cached until the item changes", async () => {
    const doc = item("<p>[[/r 1d4]]</p>");
    const first = describeItem(doc);
    assert.equal(describeItem(doc), first, "same promise while unchanged");
    doc.touch();
    assert.notEqual(describeItem(doc), first);
  });
});

describe("trackers", () => {
  const def = input => Trackers.normalizeDefinition(input, { scope: "actor" });

  test("counters accept negative ranges and swap reversed bounds", () => {
    assert.deepEqual([def({ type: "counter", min: "-10", max: "-2" }).min, def({ type: "counter", min: "-10", max: "-2" }).max], [-10, -2]);
    const reversed = def({ type: "counter", min: 5, max: -5 });
    assert.deepEqual([reversed.min, reversed.max], [-5, 5]);
  });

  test("values clamp to the range, and the default is the nearest value to 0", () => {
    const d = def({ type: "counter", min: -10, max: -2 });
    assert.deepEqual([Trackers.clampValue(d, -15), Trackers.clampValue(d, 3), Trackers.defaultValue(d)], [-10, -2, -2]);
  });

  test("pips and clocks are sized 1–20 and ignore the minimum", () => {
    assert.deepEqual([def({ type: "pips", max: 50 }).max, def({ type: "pips", max: 0 }).max, def({ type: "clock", min: -5 }).min], [20, 1, 0]);
  });

  test("bands are parsed, sorted and found", () => {
    const d = def({ type: "bands", min: -5, max: 5, bands: "3 | High | Good things\n-1 | Even\n-3 | Low" });
    assert.deepEqual(d.bands.map(b => b.from), [-3, -1, 3]);
    assert.deepEqual([-5, -2, 0, 4].map(v => Trackers.bandFor(d, v).label), ["Low", "Low", "Even", "High"]);
  });

  test("text is trimmed and limited", () => {
    assert.equal(Trackers.clampValue({ type: "text" }, `  ${"x".repeat(600)}  `).length, 500);
  });
});

describe("serial", () => {
  test("runs tasks one at a time, in order", async () => {
    const run = serial();
    const log = [];
    const task = (name, ms) => () => new Promise(r => setTimeout(() => { log.push(name); r(name); }, ms));
    const results = await Promise.all([run(task("slow", 30)), run(task("fast", 1)), run(task("last", 1))]);
    assert.deepEqual(log, ["slow", "fast", "last"]);
    assert.deepEqual(results, ["slow", "fast", "last"]);
  });

  test("a failing task doesn't stop the ones after it", async () => {
    const run = serial();
    await assert.rejects(run(() => Promise.reject(new Error("boom"))), /boom/);
    assert.equal(await run(() => Promise.resolve("still runs")), "still runs");
  });
});

describe("sha256", () => {
  const expected = text => createHash("sha256").update(text).digest("hex");

  test("matches Node's SHA-256", async () => {
    for (const text of ["", "pc_abc", "é".repeat(100)]) assert.equal(await sha256Hex(text), expected(text));
  });

  test("the fallback for plain-HTTP Foundry matches too", async () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
      for (const text of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "pc_" + "x".repeat(43)]) {
        assert.equal(await sha256Hex(text), expected(text), `length ${text.length}`);
      }
    }
    finally {
      Object.defineProperty(globalThis, "crypto", real);
    }
  });
});
