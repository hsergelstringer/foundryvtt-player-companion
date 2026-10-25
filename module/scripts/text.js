/**
 * Item descriptions for the web app.
 *
 * Foundry descriptions are HTML full of markup only Foundry understands:
 * inline rolls ([[/r 1d6]]), document links (@UUID[...]{Name}), dnd5e
 * enrichers ([[/save dex 15]], [[/damage 2d6 fire]], &Reference[prone]),
 * roll data (@mod, @prof), and sometimes raw 5etools tags ({@dice 1d6})
 * left behind by importers.
 *
 * describe() runs the description through Foundry's own enricher, then keeps
 * only a small set of safe tags. Dice become <span class="roll">, links to
 * documents and rules become <span class="ref">, and everything else that
 * isn't plain formatting is unwrapped or dropped. The web app checks the
 * result against the same list again before showing it.
 */

const MAX_LENGTH = 20000;

/** Tags kept as they are (with no attributes). */
const KEEP = new Set([
  "p", "br", "hr", "ul", "ol", "li", "strong", "b", "em", "i", "u", "s", "sup", "sub", "code", "blockquote",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "h1", "h2", "h3", "h4", "h5", "h6", "dl", "dt", "dd"
]);
/** Tags dropped along with everything inside them. */
const DROP = new Set(["script", "style", "iframe", "object", "embed", "img", "video", "audio", "svg", "canvas", "form", "input", "button", "select", "textarea", "template", "noscript"]);
/** Block containers turned into paragraphs, so their text doesn't run together. */
const BLOCKS = new Set(["div", "section", "article", "aside", "header", "footer", "figure", "figcaption", "details", "summary"]);

const escapeText = text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* -------------------------------------------- */
/*  Before enriching                            */
/* -------------------------------------------- */

/** 5etools tags whose first part is a dice formula or number. */
const FIVE_E_ROLLS = { dice: v => v, damage: v => v, d20: v => (/^[+-]/.test(v) ? v : `+${v}`), hit: v => (/^[+-]/.test(v) ? v : `+${v}`), scaledice: (v, p) => p[2] ?? v, scaledamage: (v, p) => p[2] ?? v, recharge: v => `Recharge ${v || 6}–6` };

const ATTACKS = {
  mw: "Melee Weapon Attack", rw: "Ranged Weapon Attack", "mw,rw": "Melee or Ranged Weapon Attack",
  ms: "Melee Spell Attack", rs: "Ranged Spell Attack", "ms,rs": "Melee or Ranged Spell Attack",
  m: "Melee Attack Roll", r: "Ranged Attack Roll", "m,r": "Melee or Ranged Attack Roll"
};

/** Turn {@tag text|source|display} into readable markup. Innermost tags first, so nesting works. */
function convertFiveETools(text) {
  let previous;
  do {
    previous = text;
    text = text.replace(/\{@(\w+)\s*([^{}]*)\}/g, (match, tag, body) => {
      const parts = body.split("|");
      const first = parts[0].trim();
      tag = tag.toLowerCase();
      if (tag === "b" || tag === "bold") return `<strong>${first}</strong>`;
      if (tag === "i" || tag === "italic") return `<em>${first}</em>`;
      if (tag === "dc") return `<span data-pc="roll">DC ${first}</span>`;
      if (FIVE_E_ROLLS[tag]) return `<span data-pc="roll">${FIVE_E_ROLLS[tag](first, parts)}</span>`;
      if (tag === "atk" || tag === "atkr") return `${ATTACKS[first.replace(/\s/g, "")] ?? "Attack"}:`;
      if (tag === "h") return "Hit: ";
      // Links ({@spell fireball|xphb|Fireball}, {@condition prone}, ...): show the display text.
      return `<span data-pc="ref">${(parts[2] ?? first).trim()}</span>`;
    });
  } while (text !== previous);
  // "DC {@dc 15}" would read "DC DC 15".
  return text.replace(/\bDC\s*<span data-pc="roll">DC /g, '<span data-pc="roll">DC ');
}

/**
 * Inline rolls written as [[1d6]] are rolled when enriched, which would show a
 * random number. Make them deferred ([[/r 1d6]]) so the formula is shown.
 * dnd5e's own enrichers ([[/save ...]], [[lookup ...]]) are left alone.
 */
const deferRolls = text => text.replace(/\[\[(?!\s*\/)(?!\s*lookup\b)([^\[\]]+)\]\]/gi, "[[/r $1]]");

/* -------------------------------------------- */
/*  Cleaning                                    */
/* -------------------------------------------- */

const isIcon = node => node.tagName === "I" && (/\bfa[srlbd]?\b|\bfa-/.test(node.className) || !node.textContent.trim());

function isRoll(node) {
  const cls = node.classList;
  return node.dataset?.pc === "roll" || cls.contains("inline-roll") || cls.contains("roll-action") || cls.contains("roll-link")
    || (cls.contains("roll-link-group") && node.dataset.type === "damage");
}

function isRef(node) {
  const cls = node.classList;
  return node.dataset?.pc === "ref" || cls.contains("content-link") || cls.contains("reference-link") || node.tagName === "A";
}

/**
 * What a roll should say. Core inline rolls show their formula as written, so
 * @mod and the like are filled in from the item's roll data, and a labelled
 * roll ([[/r 2d6]]{Fire}) keeps its formula next to the label.
 */
function rollText(node, rollData) {
  const label = node.textContent.trim();
  const formula = node.classList.contains("inline-roll") ? node.dataset?.formula?.trim() : null;
  if (!formula) return label;
  let resolved = formula;
  if (rollData && formula.includes("@")) {
    try {
      resolved = Roll.replaceFormulaData(formula, rollData, { missing: "0" });
      resolved = globalThis.dnd5e?.dice?.simplifyRollFormula?.(resolved) ?? resolved;
    }
    catch { resolved = formula; }
  }
  return label === formula ? resolved : `${label} (${resolved})`;
}

function clean(node, rollData) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += escapeText(child.textContent);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName.toLowerCase();
    if (DROP.has(tag) || isIcon(child)) continue;
    // dnd5e's "ask players to roll" buttons are only icons with tooltips.
    if (child.classList.contains("enricher-action") || child.classList.contains("award-link")) continue;

    if (isRoll(child)) {
      const text = rollText(child, rollData).replace(/\s+/g, " ").trim();
      if (text) out += `<span class="roll">${escapeText(text)}</span>`;
    }
    else if (child.classList.contains("roll-link-group")) out += clean(child, rollData);
    else if (tag === "a" && /^https?:\/\//i.test(child.getAttribute("href") ?? "") && !child.classList.contains("content-link")) {
      out += `<a href="${escapeText(child.getAttribute("href"))}">${clean(child, rollData)}</a>`;
    }
    else if (isRef(child)) {
      const text = child.textContent.replace(/\s+/g, " ").trim();
      if (text) out += `<span class="ref${child.classList.contains("broken") ? " broken" : ""}">${escapeText(text)}</span>`;
    }
    else if (KEEP.has(tag)) {
      const inner = clean(child, rollData);
      out += tag === "br" || tag === "hr" ? `<${tag}>` : `<${tag}>${inner}</${tag}>`;
    }
    else if (BLOCKS.has(tag)) {
      const inner = clean(child, rollData);
      if (inner.trim()) out += `<p>${inner}</p>`;
    }
    else out += clean(child, rollData); // span, font, and anything unknown: keep the text
  }
  return out;
}

/** Tidy the cleaned markup: drop empty paragraphs and paragraphs nested inside paragraphs. */
function tidy(html) {
  return html
    .replace(/<p>(\s|&nbsp;|<br>)*<\/p>/g, "")
    .replace(/<p>(\s*<p>)+/g, "<p>").replace(/(<\/p>\s*)+<\/p>/g, "</p>")
    .trim();
}

/** Plain text from cleaned markup, for API users who want text. */
export function toPlainText(html) {
  const spaced = html.replace(/<\/(p|li|tr|h\d|blockquote)>|<br>/g, "$&\n").replace(/<\/t[dh]>/g, "$&\t");
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${spaced}</body></html>`, "text/html");
  return (doc.body.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* -------------------------------------------- */
/*  Public                                      */
/* -------------------------------------------- */

const cache = new Map();
const CACHE_LIMIT = 2000;

/**
 * A document's description as safe HTML and plain text.
 * @param {Item} item
 * @param {object} [options]
 * @param {boolean} [options.secrets]  Keep secret blocks (only for people who own the item)
 * @returns {Promise<{ html: string, text: string }>}
 */
export function describe(item, { secrets = false } = {}) {
  const source = item.system?.description?.value ?? "";
  if (!source.trim()) return Promise.resolve({ html: "", text: "" });
  // The owner's modifiedTime is in the key because formulas use its roll data (@mod, @prof).
  const key = `${item.uuid}:${item._stats?.modifiedTime ?? ""}:${item.parent?._stats?.modifiedTime ?? ""}:${secrets}:${source.length}`;
  if (!cache.has(key)) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, build(item, source, secrets).catch(err => {
      cache.delete(key);
      throw err;
    }));
  }
  return cache.get(key);
}

async function build(item, source, secrets) {
  let rollData = null;
  try { rollData = item.getRollData?.() ?? null; }
  catch { rollData = null; }

  let html = deferRolls(convertFiveETools(source));
  const TextEditor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  if (TextEditor?.enrichHTML) {
    try {
      html = await TextEditor.enrichHTML(html, { relativeTo: item, rollData, secrets, documents: true, links: true, rolls: true, embeds: true });
    }
    catch (err) {
      console.warn("player-companion | Couldn't enrich the description of", item.uuid, err);
    }
  }

  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
  if (!secrets) doc.querySelectorAll("section.secret, .secret").forEach(n => n.remove());
  let result = tidy(clean(doc.body, rollData));
  // The web app re-parses this, which closes any tags the cut leaves open.
  if (result.length > MAX_LENGTH) result = `${result.slice(0, MAX_LENGTH).replace(/<[^>]*$/, "")}…`;
  return { html: result, text: toPlainText(result) };
}
