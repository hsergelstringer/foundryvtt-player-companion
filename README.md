# Player Companion

A phone-friendly character sheet for D&D 5e games run in Foundry VTT, for playing **in person**. Players roll real dice at the table and keep their sheet up to date on their phones: hit points, spell slots, uses, inventory, trackers. Every change goes straight into Foundry, and changes made in Foundry show up on the phone live. The app doesn't roll anything.

```
 player's phone ──HTTPS──▶  relay server  ◀──WSS──  GM's browser (Foundry + module)
```

Foundry modules run in the browser and can't accept connections, so the module in the **GM's browser** connects out to a small relay server, and the phones talk to the relay. The module checks each player's token and makes changes through Foundry's dnd5e system with Foundry's own permissions. **A GM must be logged in** for the app to work; until one is, it shows "Foundry is offline".

## What players can do

- **See the whole character** as Foundry calculates it, so armor, conditions, encumbrance and effects are already counted: hit points, AC, initiative, every speed, proficiency, each spellcasting class's save DC and attack bonus, abilities, saves, skills and conditions.
- **Traits:** senses, damage resistances, immunities and vulnerabilities, condition immunities, languages, and armor, weapon and tool proficiencies. Senses and defenses also show under hit points, where they matter mid-fight.
- **Hit points:** take damage (temporary HP is used first), heal, set HP or temp HP. A bar pinned to the top keeps HP one tap away while scrolling.
- **Spells:** slots as pips in each level's header, prepare and unprepare, and see casting time, range, components, duration, damage and description.
- **Items and features:** uses (including actions with their own uses), quantities, equipped, attunement, currency, and full details: damage, to hit, properties, mastery, weight, price. Gear, the party's gear, features and spells each have a search box.
- **Descriptions** read as they do in Foundry: dice formulas filled in from the character, links and rules references as names, tables and lists kept.
- **Rests**, hit dice, death saves, exhaustion and Heroic Inspiration.
- **Party inventory:** see the party's shared items and coin, give items and coin to the party and take them out, with a log of who did what.
- **Combat:** the turn order of the current combat, with whose turn it is and who's up next, and enter the initiative they rolled at the table.
- **Custom trackers** for anything the sheet doesn't cover.
- **Add items and spells from compendiums**, and remove them, with the GM's approval if the GM wants it.

The web app works in any modern phone browser and can be added to the home screen. It follows the phone's light or dark mode.

## Set up

### 1. Run the relay

Each release publishes the relay as a container image:

```sh
docker run -d -p 8080:8080 -e RELAY_SECRET="$(openssl rand -hex 24)" \
  ghcr.io/hsergelstringer/foundryvtt-player-companion:latest
```

Or build it with `docker build -t player-companion server/`, or run it with Node 20+: `cd server && npm ci && RELAY_SECRET=… node server.js`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELAY_SECRET` | required, at least 16 characters | Lets the GM's browser connect. Keep it private. |
| `PORT` | `8080` | HTTP port |
| `ALLOWED_ORIGINS` | `*` | Origins allowed to call the API from other websites, comma separated |
| `FOUNDRY_URL` | off | Foundry's address as the relay reaches it: scheme, host and port only, e.g. `http://foundryvtt:30000`. When set, the relay serves Foundry's images to the app, so phones don't need to reach Foundry. Leave it unset and images load straight from Foundry. |

Portraits and item icons come from Foundry, at the address the GM opened Foundry on. If players' phones can't reach that address (Foundry is only on your home network, or behind a login like Cloudflare Access), set `FOUNDRY_URL` so the relay fetches them instead. The relay needs to reach Foundry for that, so it suits running both on the same machine or cluster.

Serve it over **HTTPS** on its own address (for example `https://sheets.example.net`), behind the same proxy as Foundry if you like. It needs WebSocket support on `/foundry` and `/api/events`. An HTTPS Foundry page can't connect to a plain `http://` relay.

### 2. Install the module

In Foundry: **Add-on Modules → Install Module**, paste this manifest URL, and click **Install**:

```
https://github.com/hsergelstringer/foundryvtt-player-companion/releases/latest/download/module.json
```

Enable **Player Companion** in a dnd5e world (dnd5e 4.0 or later, Foundry 13 or later).

### 3. Connect Foundry to the relay (GM)

Open **Game Settings → Configure Settings → Player Companion → Open Player Companion**. Enter:

- **Relay URL:** the relay's address, e.g. `https://sheets.example.net`
- **Relay secret:** the `RELAY_SECRET`
- **Web app URL:** where players open the app, usually the same address

Then **Save and connect**. The URL and secret stay in that browser only; players never receive them. The relay connects from whichever GM browser saved them, and reconnects on its own when Foundry reloads.

### 4. Give players access

Each player opens the same window in Foundry and clicks **New token** (or the GM makes one for them). The token and a sign-in link are shown **once**. Opening the link on a phone signs in and remembers it. Revoking a token in the same window signs that app out immediately.

## Settings

All in **Configure Settings → Player Companion**.

| Setting | Scope | What it does |
| --- | --- | --- |
| Adding and removing items in the web app | World | **The GM approves each change** (default), **Players change items directly**, or **Off** |
| Combat tracker in the web app | World | **Players see the order and enter their initiative** (default), **Players only see the order**, or **Off** |
| Party inventory in the web app | World | **Members give and take items and coin** (default), **Members can only look**, or **Off** |
| Players can create trackers | World | Lets players add and remove their own trackers |
| Show party trackers on the canvas | Each person | A small panel listing the party trackers |
| Party tracker panel position | Each person | Which corner the panel sits in |

## Adding items and spells

The Gear and Spells tabs have **Add item** and **Add spell**. Players search by name, filter by type, spell level or compendium, read an entry, and add it. Items arrive the way they do when dropped on the dnd5e sheet: containers bring their contents, nothing arrives equipped, identical consumables stack, and spells get the character's spellcasting class. Opening an item on the sheet shows **Remove**.

- With **GM approval**, each GM gets a whispered chat card with **Approve** and **Deny**. The player sees the request as waiting and can withdraw it. A denied request shows until the player dismisses it.
- With **direct changes**, the change happens at once and the GMs get a note in chat.

Players only see compendiums they can open in Foundry. To keep one out of the app, set its ownership for players to **None**. Only physical items and spells can be added or removed this way; classes, features and anything with level-up steps still go through Foundry.

## Party inventory

The party's shared stash is a dnd5e **Group** actor. To set one up, create an actor of type **Group**, drag the player characters onto it as members, and (optionally) make it the primary party in dnd5e's settings. Give it items and coin like any actor; players don't need to own it.

In the web app, the Gear tab gets a **Character / Party** switch for every member:

- The party's coin and items, by type. Tap an item for its details and description.
- **Take** on a party item moves it, or some of a stack, to your character. **Give to the party** on one of your items does the reverse. **Move coins** moves coin either way.
- **Add item** adds an item from a compendium straight to the party, following the *Adding and removing items* setting: with GM approval it waits as a request on the party, which only the player who asked can withdraw.
- Quantities and coin can be changed directly, for rations eaten or treasure found.
- **Recent** lists the last changes made from the web app: who gave, took or changed what.

If you give players ownership of the Group, it also appears in their character list. Opened there, it shows only the party's gear and money; taking and moving coin happen from a character.

Moved items arrive unequipped and unattuned. Consumables and loot stack onto a matching item; giving a container gives its contents too. A character in more than one group uses the primary party, or else the first group by name. Spells, features and anything else that isn't a physical item stay on the character.

## Combat

While a combat is set up, the web app shows a **Combat** tab with the turn order of the combat on the scene the GM is viewing. Players see what Foundry's own tracker shows them: hidden combatants are left out (except their own), nobody else's hit points are shown, and a hidden combatant's turn isn't marked. The tab gets a dot when it's one of the player's characters' turn, and "You're up next" shows a turn ahead. Defeated combatants are struck through, and effect reminders from other modules (like the Heroic Tracker's markers) show in their place in the order.

Players roll initiative at the table, then tap the dash next to their character and enter the total. It goes straight into Foundry, re-sorting the order; with dnd5e's dexterity tiebreaker on, the tiebreaker is added as dnd5e would. They can only enter it for their own characters, and the *Combat tracker in the web app* setting can limit them to looking, or turn the tab off.

## Trackers

Trackers cover what the character sheet doesn't: stress, corruption, reputation, a doom clock, a monk's fate score. Open the trackers window from **Trackers** in the Token controls or in a character sheet's title bar.

| Type | Shows as |
| --- | --- |
| Counter | A number, with an optional minimum and maximum (either can be negative) |
| Pips | A row of dots, like spell slots (1–20) |
| Clock | A filling circle (1–20 segments) |
| Banded counter | A counter whose ranges have names and effects, e.g. `3 \| Disciplined \| Allies crit on 18+` |
| Text | A short note |

- **Character trackers** belong to one character. **Templates** (GM) add a tracker to every player character or to chosen ones.
- **Party trackers** are shared and shown in a panel on the canvas.
- A tracker can be **hidden from players** or **locked** so only the GM changes it. Hidden trackers never reach the app, but they're only hidden in Foundry's screens, not kept secret from someone using the browser console.

## Troubleshooting

| Problem | Likely cause |
| --- | --- |
| The app says **Foundry is offline** | No GM browser is connected. Log in as GM and check the status in the Player Companion window. |
| Connecting fails with **404** on `…/foundry` | The relay URL points at Foundry or another site, not the relay. |
| Connecting fails with **"The relay rejected the secret"** | The secret in Foundry doesn't match `RELAY_SECRET`. |
| Connecting fails from an HTTPS Foundry | The relay is served over plain HTTP. Put it behind HTTPS. |
| **"That token is no longer valid"** | The token was revoked. Make a new one in Foundry. |
| A Plutonium **import dialog** appears when items are added | Plutonium's own setting that intercepts items created on actors. It does the same for drags in Foundry; turn it off in Plutonium's config. |
| **Portraits and icons don't show** away from home | Phones can't reach Foundry's address. Set `FOUNDRY_URL` on the relay, or make Foundry reachable. |
| A second GM's browser took over | Only one browser can hold the relay connection. The latest to connect wins. |

## Limits

- A GM must be logged in. To keep it always on, leave a GM browser open on a spare machine.
- Written against dnd5e 4.x–6.x. It has been tested against a simulated Foundry, not yet a full live world.
- Short rests don't spend hit dice; players lower the count after rolling at the table.

## More

- [API reference](docs/API.md): REST endpoints, the sheet format and live events, for building other apps.
- [Developer guide](docs/DEVELOPMENT.md): how it fits together, the security model, adding actions, running locally and releasing.
- [Changelog](CHANGELOG.md)
