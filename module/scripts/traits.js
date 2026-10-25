/**
 * A character's traits as readable labels: size, senses, damage resistances,
 * immunities and vulnerabilities, condition immunities, languages and
 * proficiencies.
 *
 * Values come from the actor's prepared data, so effects that grant darkvision
 * or a resistance are included. Labels come from dnd5e's config and its own
 * Trait.keyLabel helper where it exists. Every read is guarded, so a field
 * missing in some dnd5e version is left out rather than breaking the sheet.
 */

const localize = key => (key ? game.i18n.localize(String(key)) : "");
const labelOf = entry => localize(typeof entry === "object" ? entry?.label : entry);
const splitCustom = text => String(text ?? "").split(";").map(s => s.trim()).filter(Boolean);
const asArray = value => (value instanceof Set ? [...value] : Array.isArray(value) ? value : []);

function safe(fn, fallback) {
  try { return fn() ?? fallback; }
  catch { return fallback; }
}

/** dnd5e's label for a trait key (e.g. "sim" → "Simple Weapons"), or a fallback. */
function traitLabel(key, trait, fallback = key) {
  const label = safe(() => globalThis.dnd5e?.documents?.Trait?.keyLabel?.(key, { trait }), null);
  return label && label !== key ? label : fallback;
}

function lengthLabel(value, units) {
  const unit = localize(CONFIG.DND5E.movementUnits?.[units]?.abbreviation) || units || "ft";
  return `${value} ${unit}`;
}

function senses(system) {
  const data = system.attributes?.senses ?? {};
  const ranges = data.ranges ?? data;
  const list = Object.entries(CONFIG.DND5E.senses ?? {})
    .map(([key, config]) => ({ key, value: Number(ranges[key]) }))
    .filter(s => s.value > 0)
    .map(s => `${labelOf(CONFIG.DND5E.senses[s.key]) || s.key} ${lengthLabel(s.value, data.units)}`);
  return [...list, ...splitCustom(data.special)];
}

/**
 * Damage types for a resistance, immunity or vulnerability. Physical types the
 * trait doesn't cover against, say, magical weapons say so.
 */
function damageTrait(trait) {
  if (!trait) return [];
  const types = CONFIG.DND5E.damageTypes ?? {};
  const bypasses = asArray(trait.bypasses).map(b => labelOf(CONFIG.DND5E.itemProperties?.[b]) || b);
  const except = bypasses.length ? ` (except ${new Intl.ListFormat(game.i18n.lang || "en", { type: "disjunction" }).format(bypasses)})` : "";
  const values = asArray(trait.value);
  const list = values.includes("ALL") ? ["All damage"] : values.map(key => {
    const config = types[key];
    return `${labelOf(config) || key}${config?.isPhysical ? except : ""}`;
  });
  return [...list, ...splitCustom(trait.custom)];
}

/** Flat damage changes, e.g. "Fire −3" from Heavy Armor Master–style features. */
function damageModifications(dm) {
  return Object.entries(dm?.amount ?? {})
    .filter(([, amount]) => amount !== "" && amount !== null && amount !== undefined && Number(amount) !== 0)
    .map(([key, amount]) => {
      const n = Number(amount);
      const text = Number.isFinite(n) ? (n > 0 ? `+${n}` : `−${Math.abs(n)}`) : String(amount);
      return `${labelOf(CONFIG.DND5E.damageTypes?.[key]) || key} ${text}`;
    });
}

function conditionImmunities(ci) {
  if (!ci) return [];
  return [...asArray(ci.value).map(key => labelOf(CONFIG.DND5E.conditionTypes?.[key]) || key), ...splitCustom(ci.custom)];
}

function languages(traits) {
  const data = traits.languages;
  if (!data) return { languages: [], communication: [] };
  const prepared = data.labels;
  if (prepared) return { languages: asArray(prepared.languages), communication: asArray(prepared.ranged) };
  return {
    languages: [...asArray(data.value).map(key => traitLabel(key, "languages")), ...splitCustom(data.custom)],
    communication: []
  };
}

function proficiencies(system) {
  const traits = system.traits ?? {};
  const list = (field, trait) => [...asArray(field?.value).map(key => traitLabel(key, trait)), ...splitCustom(field?.custom)];
  // Tools are stored as { [key]: { value } } on characters in dnd5e 3 and later.
  const tools = Object.entries(system.tools ?? {})
    .filter(([, data]) => Number(data?.value ?? 0) > 0)
    .map(([key]) => traitLabel(key, "tool"));
  return {
    armor: list(traits.armorProf, "armor"),
    weapons: list(traits.weaponProf, "weapon"),
    tools: tools.length ? tools : list(traits.toolProf, "tool")
  };
}

/** Everything above, for the sheet. Empty lists mean the character has none. */
export function characterTraits(actor) {
  const system = actor.system ?? {};
  const traits = system.traits ?? {};
  const { languages: spoken, communication } = safe(() => languages(traits), { languages: [], communication: [] });
  return {
    size: safe(() => labelOf(CONFIG.DND5E.actorSizes?.[traits.size]), "") || "",
    senses: safe(() => senses(system), []),
    resistances: safe(() => damageTrait(traits.dr), []),
    immunities: safe(() => damageTrait(traits.di), []),
    vulnerabilities: safe(() => damageTrait(traits.dv), []),
    damageModifications: safe(() => damageModifications(traits.dm), []),
    conditionImmunities: safe(() => conditionImmunities(traits.ci), []),
    languages: spoken,
    communication,
    proficiencies: safe(() => proficiencies(system), { armor: [], weapons: [], tools: [] })
  };
}
