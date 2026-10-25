import { ACTIONS, RelayError } from "./actions.js";
import { sha256Hex } from "./sha256.js";
import { registerTrackerSettings, setupTrackers, TrackerWindow } from "./trackers.js";

const MODULE_ID = "player-companion";
const TOKEN_FLAG = "tokens";
const TEMPLATE = `modules/${MODULE_ID}/templates/settings.hbs`;
const NOTIFY_DELAY_MS = 300;

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/* -------------------------------------------- */
/*  Tokens                                      */
/*  A token is shown to the player once. Only   */
/*  its SHA-256 hash is stored, in a flag on    */
/*  the user it belongs to.                     */
/* -------------------------------------------- */

const Tokens = {
  /** hash -> user id, rebuilt whenever a user's tokens change. */
  _index: null,

  list(user) {
    return Object.entries(user.getFlag(MODULE_ID, TOKEN_FLAG) ?? {})
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.created - a.created);
  },

  async create(user, label) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = `pc_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    const id = foundry.utils.randomID();
    await user.setFlag(MODULE_ID, TOKEN_FLAG, {
      [id]: { hash: await sha256Hex(token), label: label || "Web app", created: Date.now() }
    });
    return token;
  },

  async revoke(user, id) {
    await user.unsetFlag(MODULE_ID, `${TOKEN_FLAG}.${id}`);
  },

  async userFor(token) {
    if (typeof token !== "string" || !token.startsWith("pc_") || token.length > 200) return null;
    if (!this._index) {
      this._index = new Map();
      for (const user of game.users) {
        for (const { hash } of this.list(user)) this._index.set(hash, user.id);
      }
    }
    const userId = this._index.get(await sha256Hex(token));
    return userId ? game.users.get(userId) ?? null : null;
  },

  invalidate() {
    this._index = null;
  }
};

/* -------------------------------------------- */
/*  Relay connection (GM browser only)          */
/* -------------------------------------------- */

/**
 * The relay's Foundry socket address from what the GM typed: accepts a bare
 * host ("relay.example.net"), http(s) or ws(s). Returns null if unusable.
 */
function relaySocketUrl(input) {
  let text = String(input ?? "").trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try { url = new URL(text); }
  catch { return null; }
  const protocol = { "http:": "ws:", "https:": "wss:", "ws:": "ws:", "wss:": "wss:" }[url.protocol];
  if (!protocol || !url.hostname) return null;
  url.protocol = protocol;
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/foundry`;
  url.search = "";
  url.hash = "";
  return url.href;
}

const Relay = {
  socket: null,
  status: "disconnected",
  error: null,
  retryDelay: 2000,
  retryTimer: null,
  wanted: false,

  get configured() {
    return !!(game.settings.get(MODULE_ID, "relayUrl") && game.settings.get(MODULE_ID, "relaySecret"));
  },

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    RelaySettings.refresh();
  },

  connect() {
    if (!game.user.isGM || !this.configured) return;
    this.disconnect();
    this.wanted = true;

    const url = relaySocketUrl(game.settings.get(MODULE_ID, "relayUrl"));
    if (!url) return this.setStatus("error", "The relay URL should look like https://player-companion.example.net");

    this.setStatus("connecting");
    let socket;
    try {
      socket = new WebSocket(url);
    }
    catch (err) {
      return this.setStatus("error", `Could not open ${url}: ${err.message}`);
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        type: "hello",
        secret: game.settings.get(MODULE_ID, "relaySecret"),
        world: game.world.id,
        title: game.world.title
      }));
    });

    socket.addEventListener("message", event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "welcome") {
        this.retryDelay = 2000;
        this.setStatus("connected");
      }
      else if (msg.type === "request") this.handle(msg);
    });

    socket.addEventListener("close", event => {
      if (this.socket !== socket) return;
      this.socket = null;
      // 4000: another Foundry client took over. 4001: bad secret. Neither is fixed by retrying.
      if (event.code === 4000) return this.setStatus("disconnected", "Another GM browser took over the relay connection");
      if (event.code === 4001) return this.setStatus("error", "The relay rejected the secret");
      this.setStatus(this.wanted ? "connecting" : "disconnected", this.wanted ? "Connection lost, retrying" : null);
      if (this.wanted) {
        this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
      }
    });
  },

  disconnect() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.close(1000);
    }
    this.setStatus("disconnected");
  },

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  },

  async handle({ id, token, action, params }) {
    const reply = data => this.send({ type: "response", id, ...data });
    try {
      const user = await Tokens.userFor(token);
      if (!user) return reply({ ok: false, status: 401, error: "Unknown or revoked token" });
      if (!Object.hasOwn(ACTIONS, action)) return reply({ ok: false, status: 404, error: `Unknown action: ${action}` });
      const data = await ACTIONS[action](user, params ?? {});
      reply({ ok: true, data });
    }
    catch (err) {
      if (err instanceof RelayError) return reply({ ok: false, status: err.status, error: err.message });
      console.error(`${MODULE_ID} | ${action} failed`, err);
      reply({ ok: false, status: 500, error: err?.message ?? "Foundry error" });
    }
  }
};

/* -------------------------------------------- */
/*  Change notifications                        */
/* -------------------------------------------- */

const queued = new Map();

function notifyActor(actor) {
  if (!(actor instanceof Actor) || Relay.status !== "connected") return;
  clearTimeout(queued.get(actor.id));
  queued.set(actor.id, setTimeout(() => {
    queued.delete(actor.id);
    const userIds = game.users.filter(u => actor.testUserPermission(u, "OWNER")).map(u => u.id);
    Relay.send({ type: "event", userIds, payload: { type: "actorChanged", actorId: actor.id } });
  }, NOTIFY_DELAY_MS));
}

function actorOf(document) {
  let doc = document;
  while (doc && !(doc instanceof Actor)) doc = doc.parent;
  return doc;
}

Hooks.on("updateActor", actor => notifyActor(actor));
for (const hook of ["createItem", "updateItem", "deleteItem", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
  Hooks.on(hook, doc => notifyActor(actorOf(doc)));
}

// Party trackers and templates live in world settings, which can change any character's trackers.
Hooks.on(`${MODULE_ID}.trackersChanged`, () => {
  if (Relay.status !== "connected") return;
  Relay.send({ type: "event", userIds: game.users.map(u => u.id), payload: { type: "trackersChanged" } });
});

setupTrackers();

Hooks.on("updateUser", (user, changes) => {
  if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) return;
  Tokens.invalidate();
  Relay.send({ type: "revoke", userId: user.id });
  RelaySettings.refresh();
});

/* -------------------------------------------- */
/*  Settings window                             */
/* -------------------------------------------- */

class RelaySettings extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "player-companion-settings",
    classes: ["player-companion"],
    tag: "form",
    window: { title: "Player Companion", icon: "fa-solid fa-mobile-screen", resizable: true },
    position: { width: 560, height: "auto" },
    form: { handler: RelaySettings.#onSubmit, submitOnChange: false, closeOnSubmit: false },
    actions: {
      connect: RelaySettings.#onConnect,
      disconnect: () => Relay.disconnect(),
      createToken: RelaySettings.#onCreateToken,
      revokeToken: RelaySettings.#onRevokeToken
    }
  };

  static PARTS = { main: { template: TEMPLATE } };

  static refresh() {
    const app = foundry.applications.instances.get(RelaySettings.DEFAULT_OPTIONS.id);
    if (app?.rendered) app.render();
  }

  async _prepareContext() {
    const isGM = game.user.isGM;
    const users = isGM ? game.users.contents : [game.user];
    return {
      isGM,
      relayUrl: game.settings.get(MODULE_ID, "relayUrl"),
      hasSecret: !!game.settings.get(MODULE_ID, "relaySecret"),
      appUrl: game.settings.get(MODULE_ID, "appUrl"),
      status: Relay.status,
      statusLabel: { connected: "Connected", connecting: "Connecting…", disconnected: "Not connected", error: "Error" }[Relay.status],
      error: Relay.error,
      users: users.map(user => ({
        id: user.id,
        name: user.name,
        isGM: user.isGM,
        tokens: Tokens.list(user).map(t => ({ ...t, createdLabel: new Date(t.created).toLocaleDateString() }))
      }))
    };
  }

  static async #onSubmit(event, form, formData) {
    if (!game.user.isGM) return;
    const data = formData.object;
    await game.settings.set(MODULE_ID, "relayUrl", String(data.relayUrl ?? "").trim());
    if (data.relaySecret) await game.settings.set(MODULE_ID, "relaySecret", String(data.relaySecret).trim());
    await game.settings.set(MODULE_ID, "appUrl", String(data.appUrl ?? "").trim());
    ui.notifications.info("Player Companion settings saved.");
    Relay.connect();
    this.render();
  }

  static #onConnect() {
    if (!Relay.configured) return ui.notifications.warn("Enter the relay URL and secret, then save.");
    Relay.connect();
  }

  static async #onCreateToken(event, target) {
    const user = game.users.get(target.dataset.userId);
    if (!user || (!game.user.isGM && user !== game.user)) return;
    const label = await DialogV2.prompt({
      window: { title: `New access token for ${user.name}` },
      content: `<label>Name this token (e.g. "Phone")<input type="text" name="label" value="Phone" autofocus></label>`,
      ok: { label: "Create", callback: (event, button) => button.form.elements.label.value.trim() },
      rejectClose: false
    });
    if (label === null || label === undefined) return;

    const token = await Tokens.create(user, label);
    const appUrl = game.settings.get(MODULE_ID, "appUrl");
    const link = appUrl ? `${appUrl.replace(/\/+$/, "")}/#token=${token}` : null;
    await DialogV2.prompt({
      window: { title: "Copy this token now" },
      content: `
        <p>This is shown only once. Anyone with it can manage ${Handlebars.escapeExpression(user.name)}'s characters, so keep it private.</p>
        <label>Token<input type="text" readonly value="${token}" onclick="this.select()"></label>
        ${link ? `<label>Sign-in link<input type="text" readonly value="${Handlebars.escapeExpression(link)}" onclick="this.select()"></label>` : ""}`,
      ok: { label: "Done" },
      rejectClose: false
    });
  }

  static async #onRevokeToken(event, target) {
    const user = game.users.get(target.dataset.userId);
    if (!user || (!game.user.isGM && user !== game.user)) return;
    const confirmed = await DialogV2.confirm({
      window: { title: "Revoke token" },
      content: "<p>Apps using this token will stop working immediately.</p>"
    });
    if (confirmed) await Tokens.revoke(user, target.dataset.tokenId);
  }
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  // Client scope: stays in the GM's browser. World settings are sent to every
  // player, so the secret must never be one.
  game.settings.register(MODULE_ID, "relayUrl", { scope: "client", config: false, type: String, default: "" });
  game.settings.register(MODULE_ID, "relaySecret", { scope: "client", config: false, type: String, default: "" });
  game.settings.register(MODULE_ID, "appUrl", { scope: "world", config: false, type: String, default: "" });

  registerTrackerSettings();

  game.settings.registerMenu(MODULE_ID, "menu", {
    name: "Player Companion",
    label: "Open Player Companion",
    hint: "GM: connect Foundry to the relay. Players: create a token to use your character from the web app.",
    icon: "fa-solid fa-mobile-screen",
    type: RelaySettings,
    restricted: false
  });

  game.modules.get(MODULE_ID).api = { Relay, Tokens, actions: ACTIONS, openSettings: () => new RelaySettings().render({ force: true }),
    openTrackers: view => TrackerWindow.open(view) };
});

Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") {
    console.warn(`${MODULE_ID} | Built for the dnd5e system; ${game.system.id} is not supported.`);
    return;
  }
  if (game.user.isGM && Relay.configured) Relay.connect();
});
