# Player Companion API

The relay server exposes a small REST API and a WebSocket event stream. The web app uses exactly this API, so anything it does, another app can do too.

Every request is carried out by the module in the GM's browser, using Foundry's own permissions. **A GM must be logged in with the module enabled.** While none is, requests fail with `503`.

## Authentication

Send a player token with every request except `/api/health`:

```
Authorization: Bearer pc_…
```

Players make tokens in Foundry (**Game Settings → Player Companion → New token**). A token acts as its Foundry user, and only for characters that user **owns**. A character the user doesn't own answers `404`, the same as one that doesn't exist, so ids can't be probed.

## Requests

```sh
# The user and their characters
curl -H "Authorization: Bearer $TOKEN" https://sheets.example.net/api/me

# A character sheet
curl -H "Authorization: Bearer $TOKEN" https://sheets.example.net/api/actors/$ACTOR

# Take 7 damage
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"damage": 7}' https://sheets.example.net/api/actors/$ACTOR/hp
```

Bodies are JSON objects of at most 64 KB. Responses are JSON, gzipped when the client sends `Accept-Encoding: gzip`. Cross-origin browser apps are allowed from the origins in the relay's `ALLOWED_ORIGINS`.

### Errors

Errors are `{ "error": "message" }` with one of these statuses:

| Status | Meaning |
| --- | --- |
| `400` | The body is missing something or has a bad value; the message says which |
| `401` | The token is missing, unknown or revoked |
| `403` | The GM's settings don't allow this (e.g. players can't create trackers) |
| `404` | No such character, item, tracker or request for this user, or no such action |
| `413` | The body is over 64 KB |
| `503` | No GM browser is connected to the relay |
| `504` | Foundry took more than 15 seconds to answer |

## Endpoints

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/api/health` | | `{ relay, foundry, world, images }`; no token needed. `images` is whether the relay serves Foundry's images |
| GET | `/api/me` | | `{ user, world, characters }` |
| GET | `/api/actors/:id` | | The [sheet](#the-sheet) |
| POST | `/api/actors/:id/<action>` | See below | Usually the updated sheet |
| GET | `/api/images/<path>` | | One of Foundry's images, when the relay has `FOUNDRY_URL` (see [Images](#images)) |

### Images

`img` fields are absolute URLs on the GM's Foundry address. If phones can't reach Foundry, a relay started with `FOUNDRY_URL` serves those images itself: for an `img` that starts with the `imageOrigin` from the [event stream](#live-updates), request `/api/images` followed by the URL's path, with the token in the `Authorization` header as usual. For example, `https://foundry.example.net/icons/svg/d20.svg` becomes `GET /api/images/icons/svg/d20.svg`.

Only `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.avif` and `.svg` files are served, up to 20 MB. Responses are `private, no-cache` and carry Foundry's `ETag` and `Last-Modified`, so caches revalidate with `If-None-Match` or `If-Modified-Since` (each revalidation checks the token too). A browser `<img>` can't send the header, so fetch the image and show it from a `blob:` URL, as the web app does. Without `FOUNDRY_URL` the route answers `404` and `imageOrigin` is `null`.

### Actions

Each action is `POST /api/actors/:id/<action>`. Unless noted, it returns the updated sheet.

**Hit points and conditions**

| Action | Body | Notes |
| --- | --- | --- |
| `hp` | `{ "damage": 7 }`, `{ "heal": 5 }`, `{ "value": 20 }` or `{ "temp": 5 }` | Damage uses temporary HP first. Healing stops at max HP. |
| `deathSaves` | `{ "success": 1, "failure": 0 }` | Either or both, 0–3 |
| `inspiration` | `{ "value": true }` | Heroic Inspiration |
| `exhaustion` | `{ "value": 2 }` | 0 to the sheet's `exhaustionMax` |
| `rest` | `{ "type": "short" }` or `{ "type": "long" }` | No dialog; hit dice aren't spent automatically |
| `hitDice` | `{ "classId": "…", "value": 3 }` | Hit dice remaining for that class |

**Spells and items**

| Action | Body | Notes |
| --- | --- | --- |
| `spellSlot` | `{ "slot": "spell3", "value": 1 }` | Slots remaining; `spell1`–`spell9` or `pact` |
| `spellPrepared` | `{ "itemId": "…", "value": true }` | Only spells whose `preparation.toggleable` is true |
| `itemUses` | `{ "itemId": "…", "value": 2 }` | Uses remaining |
| `activityUses` | `{ "itemId": "…", "activityId": "…", "value": 1 }` | Uses remaining on an activity with its own uses (`activityUses` on the item) |
| `itemQuantity` | `{ "itemId": "…", "value": 3 }` | |
| `itemEquipped` | `{ "itemId": "…", "value": true }` | |
| `itemAttuned` | `{ "itemId": "…", "value": true }` | Only items with `attunement` |
| `currency` | Any of `{ "pp", "gp", "ep", "sp", "cp" }` | Whole numbers |
| `itemDescription` | `{ "itemId": "…" }` | Returns `{ id, html, text }`; see [descriptions](#descriptions) |

**Adding and removing items** (see the GM's *Adding and removing items in the web app* setting)

| Action | Body | Notes |
| --- | --- | --- |
| `searchItems` | `{ "kind": "item", "query": "rope" }`, also `pack`, `type`, and `level` for spells | Returns `{ total, results, packs }`. At most 50 results, from compendiums the user can see. |
| `itemDetails` | `{ "uuid": "Compendium.…" }` | A search result in full, with `description` and `descriptionHtml` |
| `addItem` | `{ "uuid": "Compendium.…", "quantity": 1 }` | Adds the item, or asks the GM to. Returns `{ actor, notice }`. Add `"toParty": true` to add an item (not a spell) to the character's party instead; on a Group actor it always goes to the group. |
| `removeItem` | `{ "itemId": "…" }` | Removes the item, or asks the GM to. Returns `{ actor, notice }`. |
| `cancelItemRequest` | `{ "requestId": "…" }` | Withdraws a waiting request or dismisses a denied one. With `"toParty": true` (or on a Group), a party request; only the user who made it can. |

`notice` is a sentence for the player, such as "Asked the GM to add Longsword to Isen".

**Party inventory** (see the GM's *Party inventory in the web app* setting)

These act on the party of the character in the path, the Group actor it's a member of. A character with no party, or with the setting off, answers `404`; with the setting on *Members can only look*, changes answer `403`. Each change is added to the party's `log`.

| Action | Body | Notes |
| --- | --- | --- |
| `giveToParty` | `{ "itemId": "…", "quantity": 2 }` | One of the character's items. Leave out `quantity` to give all of it. Returns `{ actor, notice }`. |
| `takeFromParty` | `{ "itemId": "…", "quantity": 1 }` | A party item's id. Leave out `quantity` to take all of it. Returns `{ actor, notice }`. |
| `moveCurrency` | `{ "direction": "toParty", "gp": 20 }` | `direction` is `toParty` or `fromParty`; any of `pp`, `gp`, `ep`, `sp`, `cp`. Fails with `400` if there aren't enough. Returns `{ actor, notice }`. |
| `partyQuantity` | `{ "itemId": "…", "value": 4 }` | A party item's quantity |
| `partyCurrency` | Any of `{ "pp", "gp", "ep", "sp", "cp" }` | Sets the party's coin, e.g. for treasure found |
| `partyItemDescription` | `{ "itemId": "…" }` | Like `itemDescription`, for a party item. Secret blocks are never included. |

A Group actor the user owns can also be used directly as `:id`. Its sheet is only `{ id, name, type: "group", img, party }`; `partyQuantity`, `partyCurrency` and `partyItemDescription` work on it, while `giveToParty`, `takeFromParty` and `moveCurrency` need a character and answer `400`.

Moved items arrive unequipped and unattuned. Consumables and loot stack onto a matching item (same name and compendium source); moving all of a container brings its contents.

**Trackers**

| Action | Body | Notes |
| --- | --- | --- |
| `setTracker` | `{ "trackerId": "…", "scope": "actor", "value": 3 }` | `scope` is `world` for party trackers. Text trackers take a string. |
| `createTracker` | `{ "name": "Luck", "type": "pips", "max": 3 }` | Also `min`, `description`, and `bands` for banded counters. Needs the GM's *Players can create trackers*. |
| `deleteTracker` | `{ "trackerId": "…" }` | The player's own trackers only |

## The sheet

`GET /api/actors/:id` and most actions return the character as Foundry's dnd5e system has calculated it, so armor, conditions, encumbrance and active effects are already included.

| Field | Contents |
| --- | --- |
| `id`, `name`, `type`, `img`, `level` | |
| `classes` | `[{ id, name, subclass, levels, hitDice: { denomination, value, max } }]` |
| `species`, `background` | Names, or `null` |
| `hp` | `{ value, max, temp, tempmax }` |
| `ac`, `initiative`, `proficiency` | Numbers |
| `speed` | `{ walk, units, all, hover, special }`; `all` lists every non-zero speed as `{ key, label, value }` |
| `spellcasting` | `{ ability, dc, attack, classes }`; `classes` lists each spellcasting class's `{ id, name, ability, abilityLabel, dc, attack }` |
| `death` | `{ success, failure }` |
| `inspiration`, `exhaustion`, `exhaustionMax` | |
| `conditions` | Status ids, e.g. `["poisoned"]` |
| `traits` | Labels, each an array of strings: `senses` (e.g. `"Darkvision 60 ft"`), `resistances`, `immunities`, `vulnerabilities` (physical types note bypasses, e.g. `"Bludgeoning (except Magical)"`), `damageModifications` (e.g. `"Slashing −3"`), `conditionImmunities`, `languages`, `communication` (e.g. telepathy), and `proficiencies: { armor, weapons, tools }`; plus `size` as a string. Effects that grant a sense or resistance are included. |
| `currency` | `{ pp, gp, ep, sp, cp }` |
| `abilities` | `[{ key, label, abbreviation, value, mod, save, proficient }]` |
| `skills` | `[{ key, label, ability, total, passive, proficiency }]`; `proficiency` is 0, 0.5, 1 or 2 (expertise) |
| `spellSlots` | `[{ key, level, label, value, max }]`, including `pact` |
| `items` | `{ weapons, equipment, consumables, tools, loot, features, spells }`; see [items](#items) |
| `itemChanges` | `{ mode, requests }`; `mode` is `approve`, `direct` or `off`, and `requests` are this character's waiting and denied requests, each with `mine` when this user made it |
| `trackers` | `{ character, party, canCreate }`, each tracker with its value and whether this user can change (`canEdit`) or delete it (`canDelete`) |
| `party` | The character's party, or `null`: `{ id, name, img, canEdit, members, currency, items, log, addMode, requests }`. `addMode` is the item change mode for adding to the party (`off` when members can only look); `requests` are its waiting and denied requests, as in `itemChanges`. `members` are `{ id, name, img }`; `items` are `{ weapons, equipment, consumables, tools, loot }`, each `{ id, name, type, img, updated, hasDescription, quantity, summary, details, inParty: true }`, where `details` are only type, properties, rarity, attunement, weight and price (to hit, damage, saves and uses depend on a character, so they're left out); `log` is the 20 latest changes, newest first, as `{ id, at, user, actor, text }` (`text` like `"gave 5 × Arrows"`). |

### Items

| Field | Contents |
| --- | --- |
| `id`, `name`, `type`, `img` | |
| `updated` | Changes whenever the item does; use it to cache descriptions |
| `summary` | One line for a list, e.g. `"Action · 120 ft · V, S · Conc."` or `"1d8 + 2 Bludgeoning · +5 to hit"` |
| `details` | `[{ label, value }]`: casting time or activation, range, target, components, duration, to hit, save, damage, armor, properties, mastery, requirements, rarity, attunement, weight, price. Only the ones that apply. |
| `activities` | When an item has more than one: `[{ id, name, summary }]` |
| `uses` | `{ value, max, recovery }` or `null` |
| `activityUses` | Activities with their own uses: `[{ id, name, value, max, recovery }]` |
| `quantity`, `equipped` | When the item has them |
| `attunement`, `attuned` | `attunement` is `required` or `optional`, only on items that need it |
| `hasDescription` | Whether `itemDescription` has anything to return |
| `removable` | Whether `removeItem` works on it |
| `level`, `school`, `preparation`, `concentration`, `ritual` | Spells only. `preparation` is `{ mode, prepared, toggleable }`. |

All labels come from dnd5e, so they're in the world's language.

### Descriptions

Sheets leave descriptions out, because every change returns the whole sheet. Fetch one with `itemDescription`, and cache it by `id` and `updated`.

Both forms come from Foundry's text enricher, so they read as they do in Foundry:

- Inline rolls show their formula, with roll data filled in: `[[/r 1d8 + @mod]]` becomes `1d8 + 3`. Plain `[[1d6]]` is shown as a formula, not rolled.
- dnd5e enrichers read as text: `[[/save dex 15]]` becomes `DC 15 Dexterity`, `[[/damage 2d6 fire]]` becomes `2d6 fire`, and `&Reference[prone]` becomes `Prone`.
- Links (`@UUID[…]{Name}`) become their names.
- Leftover 5etools tags from importers are converted: `{@damage 1d6}`, `{@dc 15}`, `{@spell fireball|xphb}`.

`html` only uses `p`, `br`, `hr`, lists, tables, headings, `blockquote`, `strong`, `em`, `b`, `i`, `u`, `s`, `sup`, `sub`, `code`, `dl`, plain `http(s)` links, `<span class="roll">` for dice and `<span class="ref">` (or `ref broken`) for links to documents and rules. Rebuild it from that list rather than inserting it as HTML. `text` is the same as plain text.

Secret blocks are included only for the item's owners, as in Foundry.

## Live updates

Open a WebSocket to `/api/events` and send your token as the first message:

```json
{ "type": "auth", "token": "pc_…" }
```

You'll receive:

| Message | When |
| --- | --- |
| `{ "type": "ready", "user": …, "imageOrigin": … }` | The token was accepted. `imageOrigin` is the start of the image URLs the relay serves, or `null` (see [Images](#images)) |
| `{ "type": "actorChanged", "actorId": "…" }` | One of your characters, or anything on it, changed |
| `{ "type": "actorChanged", "actorId": "…", "memberIds": […] }` | A party one of your characters belongs to changed; `memberIds` are its characters |
| `{ "type": "partyChanged" }` | The party inventory setting changed |
| `{ "type": "trackersChanged" }` | Party trackers or tracker templates changed |
| `{ "type": "requestsChanged" }` | Item requests or the item setting changed |
| `{ "type": "foundry", "connected": false }` | The GM's browser disconnected (and `true` when it's back, with `imageOrigin`) |

Changes you make yourself also come back as events. The socket closes with code `4001` if the token is revoked.

## Adding an action

Add a function to `ACTIONS` in `module/scripts/actions.js`. It's reachable at `POST /api/actors/:id/<name>` with no relay changes. See [DEVELOPMENT.md](DEVELOPMENT.md#adding-an-action) for the rules every action has to follow.
