# Changelog

## Unreleased

**Added**
- Custom items: **Make a custom item** in the Add item panel takes a name and a description, for things that aren't in any compendium. It arrives as loot, goes to the character or the party, and follows the *Adding and removing items* setting; the GM's approval card shows the description. The description is stored as plain text, so it can't roll, link or embed anything.

**API**
- New `addCustomItem` action.

## 0.0.16

**Changed**
- "Your turn", "You're up next", the dot on the Combat tab and entering initiative follow the character open in the app, not the Foundry user. A table sharing one player user no longer sees every character as theirs.
- Item details no longer show the price.

## 0.0.15

**Added**
- A **Combat** tab in the web app while a combat is set up: the turn order of the combat on the scene the GM is viewing, as players see it in Foundry (hidden combatants left out, no one else's hit points), with whose turn it is, who's up next, and a dot on the tab on your turn. Players enter the initiative they rolled at the table for their own characters. A new world setting, *Combat tracker in the web app*, chooses between entering initiative, view only, or off.

**API**
- New `GET /api/combat`, the `initiative` action, and the `combatChanged` event.

## 0.0.14

**Fixed**
- Image proxy hardening: one token check per token for a whole sheet of images, revoked tokens can't keep using a check that was in progress, images are streamed instead of held in memory, responses always revalidate, and a `FOUNDRY_URL` with a path is refused at startup. The app retries images that failed.

## 0.0.13

**Added**
- The relay can serve Foundry's images, for players whose phones can't reach Foundry (it's only on the home network, or behind a login). Set `FOUNDRY_URL` on the relay to Foundry's address as the relay reaches it; leave it unset to load images straight from Foundry as before. Images still need the player's token.
- A search box on the Spells tab. It matches names, summaries and schools, works with the Prepared filter, and shows only the levels with a match.

**API**
- New `GET /api/images/<path>` when the relay has `FOUNDRY_URL`. Health has `images`; the event stream's `ready` and `foundry` messages have `imageOrigin`. The module now sends its Foundry address when it connects, so update the module and the relay together.

## 0.0.12

**Added**
- Items can be added from compendiums straight to the party's inventory, with **Add item** on the Party view or on the group itself. It follows the *Adding and removing items* setting: with GM approval it waits as a request on the party, which only the player who asked can withdraw. Additions are logged, including approved ones.
- Search boxes for gear, the party's gear and features. They match names and summaries (type, damage, rarity…), ignoring case and accents.

**API**
- `addItem` and `cancelItemRequest` take `toParty`. Party sheets have `addMode` and `requests`, and requests have `mine`.

## 0.0.10

**Changed**
- The party shows only its gear and money. On the Party view, the character's header, hit points, AC and conditions are replaced by the party's name and members, and party items show only type, properties, rarity, attunement, weight, price, quantity and description (no to hit, damage, saves or uses, which depend on who wields an item).

**Fixed**
- A Group actor that players own appeared in their character list and opened as a character sheet full of zeros. It now opens as just the party's gear and money. Quantities and coin can be changed there; taking items and moving coin happen from a character.

**API**
- A Group actor's sheet is `{ id, name, type, img, party }`. Party items no longer include `uses`, `activityUses`, `activities`, `attunement`, `attuned`, `equipped` or `removable`. `giveToParty`, `takeFromParty` and `moveCurrency` answer `400` on a Group.

## 0.0.9

**Added**
- Party inventory. A character's party is the dnd5e Group actor it belongs to. The Gear tab has a Character / Party switch showing the party's items and coin; members give items and coin to the party, take them out, and change quantities, and every change is logged with who made it. A new world setting, *Party inventory in the web app*, chooses between members changing it, view only, or off.

**API**
- New actions `giveToParty`, `takeFromParty`, `moveCurrency`, `partyQuantity`, `partyCurrency` and `partyItemDescription`. Sheets have a `party` field. Changes to a party send `actorChanged` with the party's id and `memberIds` to its members; the setting sends `partyChanged`.

## 0.0.7

**Fixed**
- Two quick requests could overwrite each other's changes to item requests, party trackers or tracker templates, losing one (e.g. two fast "Ask GM" taps leaving one request). These changes now happen one at a time.
- Large characters could make the relay drop the Foundry connection, because every change sent every item's description.
- Description formulas like `1d8 + @mod` now update when the character's modifiers change.
- A `}` in an item's name broke the link on the GM's approval card.
- The exhaustion picker follows dnd5e's number of levels instead of assuming 6.
- `deathSaves` with nothing to change is an error instead of an empty update; malformed URLs get 400 instead of 500.
- If a description couldn't be loaded (e.g. while Foundry was offline), the web app retried in a loop; it now says so and tries again when the row is reopened.

**Added**
- Character traits: senses, damage resistances, immunities and vulnerabilities (with "except Magical" bypasses), damage modifications, condition immunities, languages and telepathy, and armor, weapon and tool proficiencies. A Traits card on the Stats tab, and a one-line summary of senses and defenses under hit points. Sheets have a new `traits` field.

**Changed**
- Descriptions load when a row is first opened, and stay cached until the item changes. Sheets are much smaller.
- The relay gzips responses, about 70% smaller.
- Denied item requests the player never dismisses are cleared after 30 days.

**API**
- New `itemDescription` action. Sheet items no longer include `description`/`descriptionHtml`; they have `hasDescription` and `updated` instead. `itemDetails` (compendium) still includes the description.
- Sheets have `exhaustionMax`.

**Tests**
- An automated test suite (`npm test`): unit tests for descriptions, trackers, the write queue and SHA-256, and end-to-end tests that run the real relay and module against a simulated Foundry world. It runs on every push and before every release.

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
