/**
 * The secondary facts the dnd5e sheet shows for an item: casting time, range,
 * components, damage, properties, weight and so on.
 *
 * Everything comes from the labels dnd5e prepares on items and activities
 * (item.labels, activity.labels), so numbers already include the character's
 * modifiers and match what Foundry shows. Each read is guarded: a field that's
 * missing in some dnd5e version is left out, never an error.
 */

const localize = key => (key ? game.i18n.localize(String(key)) : "");
const list = values => values.filter(Boolean).join(", ");
const str = value => (value === null || value === undefined ? "" : String(value).trim());

function safe(fn, fallback = null) {
  try { return fn() ?? fallback; }
  catch { return fallback; }
}

/** Activities a player would see on the sheet. */
function visibleActivities(item) {
  return safe(() => [...(item.system.activities ?? [])].filter(a => !a.isHidden), []);
}

function damageText(labels) {
  return list((labels?.damages ?? labels?.damage ?? []).map?.(d => d.label ?? d.formula) ?? []);
}

function activationText(item) {
  const labels = item.labels ?? {};
  if (item.type === "spell") return str(labels.ritualActivation || labels.activation);
  return str(labels.activation);
}

function componentsText(item) {
  const labels = item.labels ?? {};
  const full = safe(() => labels.components?.full);
  if (full) return full;
  const vsm = safe(() => labels.components?.vsm?.join(", "), "");
  return [vsm, labels.materials ? `(${labels.materials})` : ""].filter(Boolean).join(" ");
}

function weightText(sys) {
  const weight = sys.weight;
  const value = Number(typeof weight === "object" ? weight?.value : weight);
  if (!value) return "";
  const units = typeof weight === "object" ? weight.units : null;
  const unitLabel = localize(CONFIG.DND5E.weightUnits?.[units]?.abbreviation) || units || "lb";
  return `${value} ${unitLabel}`;
}

function propertiesText(item) {
  const labels = item.labels?.properties;
  if (Array.isArray(labels)) {
    return list(labels
      .filter(p => !["mgc", "concentration", "ritual", "vocal", "somatic", "material"].includes(p.abbr))
      .map(p => localize(p.label)));
  }
  return "";
}

function typeText(item) {
  return str(safe(() => item.system.type?.label) || localize(CONFIG.Item.typeLabels?.[item.type]));
}

/** The save DC and to-hit of an item's first activities that have them. */
function firstOf(activities, key) {
  for (const activity of activities) {
    const value = safe(() => activity.labels?.[key]);
    if (value) return str(value);
  }
  return "";
}

/**
 * Details for the expanded row, a one-line summary for the collapsed row, and
 * the item's activities when it has more than one.
 * @returns {{ summary: string, details: { label: string, value: string }[], activities: object[], recovery: string, attunement: string|null }}
 */
export function itemFacts(item) {
  const sys = item.system ?? {};
  const labels = item.labels ?? {};
  const activities = visibleActivities(item);
  const isSpell = item.type === "spell";
  const isWeapon = item.type === "weapon";

  const activation = activationText(item);
  const range = [str(labels.range), str(labels.reach)].filter(Boolean).join(", ");
  const target = str(labels.target);
  const duration = str(isSpell ? (labels.concentrationDuration || labels.duration) : labels.duration);
  const toHit = str(labels.toHit) || firstOf(activities, "toHit");
  const save = firstOf(activities, "save");
  const damage = damageText(labels) || (isWeapon ? [str(labels.damage), str(labels.damageTypes)].filter(Boolean).join(" ") : "");
  const mastery = isWeapon && sys.mastery ? localize(CONFIG.DND5E.weaponMasteries?.[sys.mastery]?.label) || sys.mastery : "";
  const attunement = ["required", "optional"].includes(sys.attunement) ? sys.attunement : null;
  const recovery = str(labels.recovery);

  const details = [
    isSpell ? null : ["Type", typeText(item)],
    [isSpell ? "Casting time" : "Activation", activation],
    ["Range", range],
    ["Target", target],
    isSpell ? ["Components", componentsText(item)] : null,
    ["Duration", duration],
    ["To hit", toHit],
    ["Save", save],
    ["Damage", damage],
    ["Armor", str(labels.armor)],
    ["Strength", sys.strength ? String(sys.strength) : ""],
    ["Properties", propertiesText(item)],
    ["Mastery", mastery],
    ["Requirements", str(sys.requirements)],
    // Recovery shows next to the uses counter instead.
    ["Rarity", localize(CONFIG.DND5E.itemRarity?.[sys.rarity])],
    ["Attunement", attunement === "required" ? "Required" : attunement === "optional" ? "Optional" : ""],
    // No price: the table doesn't track what things cost.
    ["Weight", weightText(sys)]
  ].filter(row => row && row[1]).map(([label, value]) => ({ label, value }));

  // One line for the collapsed row: what you need at the table without opening it.
  const summary = (isSpell
    ? [activation, range, componentsText(item).replace(/\s*\(.*\)$/, ""), item.system.properties?.has?.("concentration") ? "Conc." : ""]
    : isWeapon
      ? [damage, toHit ? `${toHit} to hit` : ""]
      : item.type === "equipment" && labels.armor
        ? [str(labels.armor), typeText(item)]
        : [activation, save, damage]
  ).filter(Boolean).join(" · ");

  const shownActivities = activities.length > 1 ? activities.map(a => ({
    id: a.id,
    name: str(a.name) || localize(CONFIG.DND5E.activityTypes?.[a.type]?.documentClass?.metadata?.title) || a.type,
    summary: [
      str(safe(() => a.activationLabels?.activation ?? a.labels?.activation)),
      str(safe(() => a.labels?.toHit)) ? `${a.labels.toHit} to hit` : "",
      str(safe(() => a.labels?.save)),
      damageText(a.labels)
    ].filter(Boolean).join(" · ")
  })) : [];

  return { summary, details, activities: shownActivities, recovery, attunement };
}

/** Activities with their own limited uses, separate from the item's. */
export function activityUses(item) {
  return visibleActivities(item).map(activity => {
    const uses = activity.uses;
    const max = Number(uses?.max);
    if (!max) return null;
    return {
      id: activity.id,
      name: str(activity.name) || item.name,
      value: Math.max(0, max - Number(uses.spent ?? 0)),
      max,
      recovery: str(safe(() => game.i18n.getListFormatter({ style: "narrow" }).format(
        (uses.recovery ?? []).map(r => localize(CONFIG.DND5E.limitedUsePeriods?.[r.period]?.label ?? r.period)).filter(Boolean)
      )))
    };
  }).filter(Boolean);
}
