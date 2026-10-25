# Player Companion

Lets players manage their D&D 5e characters from outside Foundry, on a phone-friendly web app or any app that uses the REST API.

```
 player's phone ──HTTPS/WSS──▶  relay server  ◀──WSS──  GM's browser (Foundry + module)
 (web app / REST)               (this repo's /server)    does the work with Foundry's permissions
```

Foundry modules run in the browser and can't listen for HTTP requests, so the module in the **GM's browser** connects out to a small relay server. The relay forwards each request to the module. The module checks the player's token, checks that the player owns the character, and makes the change through the normal Foundry/dnd5e API, so other connected clients see it immediately. **A GM must be logged in** for the web app to work. While no GM is connected, the web app shows "Foundry is offline".

## What players can do

- See their character: HP, AC, initiative, speed, proficiency, spell DC, abilities, saves, skills, conditions, spells, inventory and features (with descriptions)
- Apply damage (temp HP is used first) or healing, set HP or temp HP
- Roll ability checks, saves, skills, death saves and initiative, with advantage or disadvantage. Rolls post to Foundry chat as the character.
- Track spell slots, item and feature uses, hit dice, death saves, exhaustion and Heroic Inspiration
- Prepare or unprepare spells, equip items, change quantities and currency
- Take a short or long rest
- See changes made in Foundry live
- Update custom trackers, and add their own if the GM allows it

## Trackers

Custom trackers for anything the character sheet doesn't cover: stress, corruption, reputation, a doom clock, a monk's fate score.

| Type | Shows as |
| --- | --- |
| Counter | A number with optional minimum and maximum |
| Pips | A row of dots, like spell slots (1–20) |
| Clock | A filling circle with segments (1–20) |
| Banded counter | A counter whose ranges have names and effects, e.g. `3 \| Disciplined \| Allies crit on 18+` |
| Text | A short note |

- **Character trackers** belong to one character. The GM can add them with **templates**, which apply to every player character or only to the ones chosen. If the GM allows it, players can also add their own.
- **Party trackers** are shared by everyone and shown in a small panel on the canvas. Click the panel to open the trackers window.
- Each tracker can be **hidden from players** or **locked** so only the GM changes it. Hidden trackers never reach the web app, but they are only hidden from player screens inside Foundry, not kept secret from someone using the browser console.
- Open the trackers window from the **Trackers** button in the Token controls toolbar or in a character sheet's title bar.

Settings: **Players can create trackers** (world), **Show party trackers on the canvas** and **Party tracker panel position** (per person).

## Set up

### 1. Run the relay

Each release publishes the relay image to GitHub Container Registry:

```sh
docker run -d -p 8080:8080 -e RELAY_SECRET="$(openssl rand -hex 24)" \
  ghcr.io/hsergelstringer/foundryvtt-player-companion:latest
```

To build it yourself instead, run `docker build -t player-companion server/`. Or run it without Docker: `npm ci && RELAY_SECRET=... node server.js` (Node 20+).

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELAY_SECRET` | required, at least 16 characters | Shared with the GM's browser so it can connect |
| `PORT` | `8080` | HTTP port |
| `ALLOWED_ORIGINS` | `*` | CORS origins for third-party web apps, comma separated |

Serve it over HTTPS (for example behind the same Gateway/HTTPRoute as Foundry). An HTTPS Foundry page can't open a plain `ws://` connection.

### 2. Install the module

In Foundry: **Add-on Modules → Install Module**, paste this manifest URL and click **Install**:

```
https://github.com/hsergelstringer/foundryvtt-player-companion/releases/latest/download/module.json
```

Then enable **Player Companion** in the world. For development, symlink `module/` into the Foundry data directory as `Data/modules/player-companion` instead.

### 3. Connect (GM)

In **Game Settings → Configure Settings → Player Companion → Open Player Companion**, enter the relay URL (e.g. `https://sheets.example.net`), the `RELAY_SECRET` and the player web app URL (usually the same address), then **Save and connect**. The URL and secret are client settings: they stay in that browser only, and players never receive them.

### 4. Give players access

Each player opens the same settings window in Foundry and clicks **New token** (or the GM makes one for them). The token and a sign-in link are shown **once**. Opening the link on a phone signs in and remembers the token. Revoke a token in the same window; apps using it stop working immediately.

Foundry stores only a SHA-256 hash of each token, in a flag on the user it belongs to.

## REST API

All requests except `/api/health` need `Authorization: Bearer <token>`. A token acts as its Foundry user, and only for characters that user **owns**.

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/health` | |
| GET | `/api/me` | Returns the user and their characters |
| GET | `/api/actors/:id` | Returns the sheet |
| POST | `/api/actors/:id/hp` | `{ "damage": 7 }`, `{ "heal": 5 }`, `{ "value": 20 }`, `{ "temp": 5 }` |
| POST | `/api/actors/:id/roll` | `{ "kind": "skill", "key": "prc", "mode": "advantage" }`; `kind` is `ability`, `save`, `skill`, `death` or `initiative` |
| POST | `/api/actors/:id/spellSlot` | `{ "slot": "spell3", "value": 1 }` (slots remaining; `pact` for pact slots) |
| POST | `/api/actors/:id/itemUses` | `{ "itemId": "…", "value": 2 }` (uses remaining) |
| POST | `/api/actors/:id/itemQuantity` | `{ "itemId": "…", "value": 3 }` |
| POST | `/api/actors/:id/itemEquipped` | `{ "itemId": "…", "value": true }` |
| POST | `/api/actors/:id/spellPrepared` | `{ "itemId": "…", "value": true }` |
| POST | `/api/actors/:id/hitDice` | `{ "classId": "…", "value": 3 }` (dice remaining) |
| POST | `/api/actors/:id/currency` | any of `{ "pp", "gp", "ep", "sp", "cp" }` |
| POST | `/api/actors/:id/deathSaves` | `{ "success": 1, "failure": 0 }` |
| POST | `/api/actors/:id/inspiration` | `{ "value": true }` |
| POST | `/api/actors/:id/exhaustion` | `{ "value": 1 }` |
| POST | `/api/actors/:id/rest` | `{ "type": "short" }` or `{ "type": "long" }` |
| POST | `/api/actors/:id/setTracker` | `{ "trackerId": "…", "scope": "actor", "value": 3 }`; `scope` is `world` for party trackers |
| POST | `/api/actors/:id/createTracker` | `{ "name": "Luck", "type": "pips", "max": 3 }`; also `min`, `description`, and `bands` for banded counters |
| POST | `/api/actors/:id/deleteTracker` | `{ "trackerId": "…" }` (the player's own trackers only) |

Every POST returns the updated sheet; `roll` returns `{ roll, actor }`.

Sheets include `trackers: { character, party, canCreate }`, with each tracker's value and whether the user can change or delete it.

For live updates, open a WebSocket to `/api/events` and send `{"type":"auth","token":"…"}` first. You'll receive `{"type":"actorChanged","actorId":"…"}` whenever one of your characters changes, `{"type":"trackersChanged"}` when party trackers or templates change, and `{"type":"foundry","connected":false}` when the GM's browser goes offline.

To add an action, add a function to `ACTIONS` in `module/scripts/actions.js`. It is reachable at `POST /api/actors/:id/<name>` with no relay changes.

## Limits

- Needs a logged-in GM. If you want it always on, leave a GM browser open on a spare machine.
- Built against dnd5e 4.x/5.x data shapes. It has been tested against a mocked dnd5e actor, not yet a live world.
- No activity or attack use yet (dnd5e activities open dialogs that need a person in the GM's browser to answer).
- Short rests don't spend hit dice. Players lower the count after rolling at the table.

## Releasing

Bump `version` in `module/module.json`, commit, then publish a GitHub release tagged `vX.Y.Z`. The release workflow attaches `module.zip` and a matching `module.json` to the release, and pushes the relay image to `ghcr.io/hsergelstringer/foundryvtt-player-companion` tagged with the version and `latest`.

The first time the image is published, GHCR makes the package private. Make it public in the package settings, or give your cluster a pull secret.
