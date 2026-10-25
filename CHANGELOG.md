# Changelog

## 0.0.7

**Fixed**
- Two quick requests could overwrite each other's changes to item requests, party trackers or tracker templates, losing one (e.g. two fast "Ask GM" taps leaving one request). These changes now happen one at a time.
- Large characters could make the relay drop the Foundry connection, because every change sent every item's description.
- Description formulas like `1d8 + @mod` now update when the character's modifiers change.
- A `}` in an item's name broke the link on the GM's approval card.
- The exhaustion picker follows dnd5e's number of levels instead of assuming 6.
- `deathSaves` with nothing to change is an error instead of an empty update; malformed URLs get 400 instead of 500.

**Changed**
- Descriptions load when a row is first opened, and stay cached until the item changes. Sheets are much smaller.
- The relay gzips responses, about 70% smaller.
- Denied item requests the player never dismisses are cleared after 30 days.

**API**
- New `itemDescription` action. Sheet items no longer include `description`/`descriptionHtml`; they have `hasDescription` and `updated` instead. `itemDetails` (compendium) still includes the description.
- Sheets have `exhaustionMax`.

**Docs**
- The README is now a guide for GMs and players, with troubleshooting. The API reference moved to `docs/API.md`, and `docs/DEVELOPMENT.md` covers how it fits together, the security model and releasing.

## 0.0.6

- Item and spell details: casting time, range, target, components, duration, to hit, save, damage, properties, mastery, armor, rarity, weight and price, from dnd5e's own labels. Items with several activities list each one.
- Uses, activity uses and consumable quantities can be changed on collapsed rows. Attunement switch.
- Descriptions read as Foundry renders them: inline rolls with roll data filled in, dnd5e enrichers, links, and leftover 5etools tags. Tables and lists keep their layout.
- New actions: `itemAttuned`, `activityUses`.

## 0.0.5

- Add items and spells from compendiums in the web app, and remove them, with a world setting for GM approval (chat cards with Approve and Deny), direct changes, or off.
- Rolling removed; the companion is for in-person play.
- Every speed (fly, swim, climb, burrow, hover) and each spellcasting class's DC and attack bonus.
- Web app redesign: bottom tab bar, compact HP block with a pinned HP bar, bottom sheets instead of browser dialogs, instant taps with queued requests, light and dark themes.

## 0.0.4

- Tracker ranges can be negative, from the web app too.
- Clearer layout for the tracker editor and trackers window.

## 0.0.3

- Custom trackers: counters, pips, clocks, banded counters and text, per character or for the party, with GM templates, hidden and locked trackers, and a party panel on the canvas.
- Relay URLs work without `https://`, and connection errors are shown in the settings window.

## 0.0.2

- Fixed the settings window failing to open.

## 0.0.1

- First release: the relay server, the Foundry module and the phone web app.
