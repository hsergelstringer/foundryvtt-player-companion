# Developing Player Companion

## How it fits together

```
 player's phone ──HTTPS / WSS──▶  relay (server/)  ◀──WSS──  GM's browser: Foundry + module (module/)
 web app (server/public)          forwards requests           checks the token and ownership,
 or any REST client               and events, stores nothing  makes the change with the dnd5e API
```

Foundry modules run in the browser and can't accept connections, so the module in the GM's browser connects **out** to the relay over a WebSocket and authenticates with a shared secret. The relay:

1. receives a REST request with a player token,
2. forwards `{ id, token, action, params }` to the connected module,
3. waits up to 15 seconds for `{ id, ok, data | status, error }`,
4. answers the HTTP request.

The relay never sees character data at rest and keeps no token list. Everything is decided in the module, with Foundry's own permission checks.

Changes made in Foundry reach phones the other way: the module listens to Foundry hooks and sends `{ type: "event", userIds, payload }`, which the relay passes to those users' event sockets.

## Files

| Path | What it does |
| --- | --- |
| `module/scripts/main.js` | Entry point. Tokens, the relay connection, request dispatch, change notifications and the settings window. |
| `module/scripts/actions.js` | Every API action, and the sheet serialiser. **The security boundary**: see [rules for actions](#adding-an-action). |
| `module/scripts/details.js` | Item and spell details (casting time, range, damage…) from dnd5e's prepared labels. |
| `module/scripts/text.js` | Turns Foundry descriptions into safe HTML: enrichment, 5etools tags, sanitising, caching. |
| `module/scripts/items.js` | Compendium search, adding and removing items, GM approval requests and their chat cards. |
| `module/scripts/trackers.js` | Custom trackers: storage, permissions, the Foundry window and the canvas panel. |
| `module/scripts/party.js` | The party inventory: finding a character's Group actor, moving items and coin, and the log. |
| `module/scripts/serial.js` | Runs world-setting read-modify-writes one at a time. |
| `module/scripts/sha256.js` | SHA-256, with a fallback for Foundry served over plain HTTP. |
| `module/scripts/errors.js` | `RelayError`, an error with an HTTP status. |
| `module/templates/` | Handlebars templates for the settings and trackers windows. |
| `server/server.js` | The relay: REST routes, the Foundry socket, the event stream and static files. One dependency (`ws`). |
| `server/public/` | The web app: plain JavaScript (`app.js`), no build step. |
| `test/` | Automated tests; see [Tests](#tests). |
| `.github/workflows/test.yml` | Runs the tests on every push and pull request. |
| `.github/workflows/release.yml` | Runs the tests, then builds `module.zip` and the relay image when a release is published. |

## Where data lives

| Data | Stored in | Who can read it |
| --- | --- | --- |
| Relay URL and secret | Client settings in the GM's browser | That browser only |
| Player tokens | `flags.player-companion.tokens` on each user, **as SHA-256 hashes** | Everyone in the world (hashes only) |
| Web app URL | World setting `appUrl` | Everyone |
| Character trackers | `flags.player-companion.trackers` on the actor | Everyone (Foundry sends every actor to every client) |
| Party trackers and templates | World settings `worldTrackers` and `trackerTemplates` | Everyone |
| Item requests | World setting `itemRequests` | Everyone |
| Item change mode | World setting `itemChanges` | Everyone |
| Party items and coin | The dnd5e Group actor itself | Everyone |
| Party log | `flags.player-companion.partyLog` on the Group actor | Everyone |
| Party inventory mode | World setting `partyInventory` | Everyone |

World settings and document flags reach every player's browser, which is why "hidden" trackers are hidden in the UI but not secret, and why the relay secret is a client setting.

## Security model

- **The relay secret** lets a Foundry client act as the world. Only the GM's browser should have it. If it leaks, change `RELAY_SECRET` and reconnect.
- **A player token** acts as its Foundry user. Tokens are 256 random bits, shown once, and stored only as hashes. Revoking one closes that user's event sockets.
- **Every action** checks that the token's user owns the actor (`ownedActor`) and only writes fields it names explicitly. Ownership failures return 404, so actor ids can't be probed.
- **The party** is a Group actor players don't own. Party actions start from the player's own character and then check that the character is a member (`partyOf`), so a token reaches only its own characters' party.
- **Images through the relay** (only with `FOUNDRY_URL`) need a working player token, checked with Foundry and trusted for a minute (one check per token, however many images arrive at once). Revoking a token, Foundry disconnecting or another world connecting forgets every cached answer at once, including checks still running. Responses are `no-cache`, so a browser can't show a revoked token a cached image without asking. Images are streamed, never held whole in memory. The relay only fetches from `FOUNDRY_URL`, only image extensions, and rejects empty, `.` and `..` path segments, so it can't be pointed at anything else on the network. The response type comes from the extension, never from Foundry, and SVGs are sent with a sandboxing Content-Security-Policy so opening one directly can't run a script on the relay's origin. Images hosted anywhere else still load straight from their own address.
- **Descriptions** are sanitised twice: in the module (`text.js`) and again in the web app, which rebuilds them from a short list of tags instead of inserting HTML. The web app's Content-Security-Policy blocks inline scripts as a third layer.
- **Compendium access** follows Foundry's compendium ownership. Players only search and add from compendiums they can open.
- **GM approval** happens in a GM's own browser through chat-card buttons that are removed for players.

## Concurrency and caching

- The relay handles requests in parallel, and a world setting returns its old value until the server confirms a save. Every read-modify-write of `itemRequests`, `worldTrackers` and `trackerTemplates` goes through a `serial()` queue so changes can't overwrite each other.
- Party changes (moving items and coin, quantities, the log) share one `serial()` queue too, so two players can't both take the last potion.
- A Group actor's changes are sent to the owners of its members as well as its own, with `memberIds` in the event.
- Item descriptions are enriched once and cached in the GM's browser, keyed by the item's and the character's modification times, so formulas like `1d8 + @mod` refresh when modifiers change.
- Sheets don't include descriptions; the web app fetches one when a row is opened and caches it by the item's `updated` time.
- Compendium indexes are cached per pack and cleared when an item in that pack changes.
- Change notifications are debounced per actor (300 ms), so a rest that updates many items sends one event.
- The relay gzips JSON over 1 KB.
- The web app updates the sheet as soon as you tap and queues the requests. The server's sheet replaces the local one when the queue empties, and a failed request reloads the sheet.

## Adding an action

Add a function to `ACTIONS` in `module/scripts/actions.js`. For example, for a made-up `system.charges` field:

```js
/** Body: { itemId, value }. */
async itemCharges(user, { actorId, itemId, value }) {
  const actor = ownedActor(user, actorId);          // 1. always: the user must own the actor
  const item = ownedItem(actor, itemId);            // 2. look things up through the actor
  const charges = requireInt(value, "value", { min: 0, max: 10 });  // 3. validate every input
  await item.update({ "system.charges": charges }); // 4. write named fields only
  return serializeActor(actor, user);               // 5. return the updated sheet
}
```

It's immediately available at `POST /api/actors/:id/itemCharges`. Never pass a client-supplied object straight to `update()`, and never build a field path from client input without checking it against a fixed list (see `spellSlot`).

Throw `RelayError(status, message)` for anything the player should see; the message is shown to them as written. Anything else becomes a 500 and is logged in the GM's console.

## Tests

```sh
npm ci                  # test dependencies (linkedom, a small DOM for Node)
npm ci --prefix server  # the relay's dependency (ws)
npm test
```

Needs Node 22 or later. The suite takes a couple of seconds and runs on every push and before every release.

- **`test/units.test.js`**: the description converter (rolls, roll data, 5etools tags, links, secret blocks, and hostile HTML), tracker rules (ranges, negative bounds, bands), the write queue, and SHA-256 including the plain-HTTP fallback.
- **`test/images.test.js`**: the relay serving Foundry's images, against a small stand-in file server: the image origin in the event stream, types and headers, revalidation, tokens and revoking, paths that must never reach Foundry, and size limits.
- **`test/relay.test.js`**: end to end. It starts the real relay, loads the real module code into a simulated Foundry world, connects them, and drives everything over HTTP and the event stream like the web app does: tokens and revoking, ownership (another player gets 404), input validation, hit points, uses, attunement, descriptions, compendium search and adding with approval, direct and off modes, trackers, live events, and the two concurrency cases that used to lose changes.
- **`test/support/foundry.js`**: the simulated world. It reproduces the parts of Foundry and dnd5e the module reads: documents whose `update` fires the same hooks, world settings whose new value only appears after a short delay (as with Foundry's server round trip), compendium packs, chat messages and dnd5e's prepared labels. It is not Foundry: anything that depends on real dnd5e behaviour (how a rest recovers uses, how an activity prepares its labels) still needs checking in a live world.

When you add an action, add a test for it in `relay.test.js`, including what happens with bad input and with another player's token.

## Running it locally

```sh
cd server
npm ci
RELAY_SECRET=dev-secret-at-least-16 PORT=8080 node server.js
```

Symlink `module/` into your Foundry data folder as `Data/modules/player-companion`, enable the module in a dnd5e world, and in **Player Companion** settings connect to `http://localhost:8080` with the same secret. Create a token for a player and open `http://localhost:8080/#token=…`.

The web app has no build step: edit `server/public/` and reload. Foundry needs a reload after module changes.

Things worth checking after a change:

- A player's token can't read or change another player's character (expect 404).
- Quick repeated taps on a counter end on the right number.
- The web app at phone width (about 390 px), in light and dark mode.
- The Foundry console stays free of errors while the web app is in use.

## Releasing

1. Bump `version` in `module/module.json` and add an entry to `CHANGELOG.md`.
2. Commit and push.
3. Publish a GitHub release tagged `vX.Y.Z`. The workflow stamps the version and download URL into `module.json`, attaches `module.zip` and `module.json` to the release, and pushes `ghcr.io/hsergelstringer/foundryvtt-player-companion:X.Y.Z` and `:latest`.
4. Point your relay deployment at the new image.

Foundry checks `releases/latest/download/module.json` for updates, so once the release is published, GMs can update the module from Foundry's module list.
