/**
 * Sheet Relay server.
 *
 * Foundry modules run in the browser and cannot listen for HTTP requests, so
 * the module (running in the GM's browser) connects out to this server over a
 * WebSocket. Players and other apps talk to this server over REST and a
 * WebSocket event stream; each request is forwarded to the module, which
 * checks the player's token and permissions and does the work in Foundry.
 *
 * This server holds no character data and no token list. It only knows the
 * shared secret that lets the Foundry module connect.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8080);
const SECRET = process.env.RELAY_SECRET ?? "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "*").split(",").map(s => s.trim()).filter(Boolean);
const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR ?? join(fileURLToPath(new URL(".", import.meta.url)), "public"));
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 64 * 1024;

if (SECRET.length < 16) {
  console.error("RELAY_SECRET must be set to at least 16 characters.");
  process.exit(1);
}

const log = (...args) => console.log(new Date().toISOString(), ...args);

/* -------------------------------------------- */
/*  The Foundry connection                      */
/* -------------------------------------------- */

/** The currently connected Foundry module, if any. */
let world = null;
/** Requests waiting for a reply from Foundry, by id. */
const pending = new Map();

function secretMatches(candidate) {
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(String(candidate ?? "")).digest();
  const b = createHash("sha256").update(SECRET).digest();
  return timingSafeEqual(a, b);
}

function attachWorld(ws, hello) {
  if (world) world.socket.close(4000, "Replaced by a newer Foundry connection");
  world = { socket: ws, worldId: hello.world, worldTitle: hello.title, connectedAt: new Date().toISOString() };
  log(`Foundry connected: ${hello.title ?? hello.world ?? "unknown world"}`);

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "response") {
      const waiting = pending.get(msg.id);
      if (!waiting) return;
      pending.delete(msg.id);
      clearTimeout(waiting.timer);
      waiting.resolve(msg);
    }
    else if (msg.type === "event") broadcast(msg.userIds ?? [], msg.payload);
    else if (msg.type === "revoke") recheckUser(msg.userId);
  });

  ws.on("close", () => {
    if (world?.socket !== ws) return;
    world = null;
    log("Foundry disconnected");
    for (const [id, waiting] of pending) {
      clearTimeout(waiting.timer);
      waiting.resolve({ ok: false, status: 503, error: "Foundry disconnected" });
      pending.delete(id);
    }
    broadcastAll({ type: "foundry", connected: false });
  });

  broadcastAll({ type: "foundry", connected: true });
}

/** Send a request to Foundry and wait for its reply. */
function forward(token, action, params = {}) {
  if (!world) {
    return Promise.resolve({ ok: false, status: 503, error: "Foundry is not connected. The GM needs to be logged in with Sheet Relay enabled." });
  }
  const id = randomUUID();
  return new Promise(resolvePromise => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolvePromise({ ok: false, status: 504, error: "Foundry did not answer in time" });
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve: resolvePromise, timer });
    world.socket.send(JSON.stringify({ type: "request", id, token, action, params }));
  });
}

/* -------------------------------------------- */
/*  Event stream for players                    */
/* -------------------------------------------- */

/** Authenticated event subscribers: socket -> { token, userId }. */
const subscribers = new Map();

function broadcast(userIds, payload) {
  const ids = new Set(userIds);
  const data = JSON.stringify(payload);
  for (const [ws, sub] of subscribers) {
    if (ids.has(sub.userId)) ws.send(data);
  }
}

function broadcastAll(payload) {
  const data = JSON.stringify(payload);
  for (const ws of subscribers.keys()) ws.send(data);
}

/** A user's tokens changed: drop subscribers whose token no longer works. */
async function recheckUser(userId) {
  for (const [ws, sub] of subscribers) {
    if (sub.userId !== userId) continue;
    const reply = await forward(sub.token, "me");
    if (!reply.ok && reply.status === 401) ws.close(4001, "Token revoked");
  }
}

function attachSubscriber(ws) {
  const authTimer = setTimeout(() => ws.close(4001, "Authenticate first"), 10_000);
  ws.once("message", async raw => {
    clearTimeout(authTimer);
    let msg;
    try { msg = JSON.parse(raw); } catch { return ws.close(4002, "Bad message"); }
    if (msg.type !== "auth" || typeof msg.token !== "string") return ws.close(4001, "Authenticate first");
    const reply = await forward(msg.token, "me");
    if (!reply.ok) {
      ws.send(JSON.stringify({ type: "error", status: reply.status, error: reply.error }));
      return ws.close(reply.status === 401 ? 4001 : 4003, reply.error?.slice(0, 120));
    }
    subscribers.set(ws, { token: msg.token, userId: reply.data.user.id });
    ws.send(JSON.stringify({ type: "ready", user: reply.data.user, foundry: true }));
  });
  ws.on("close", () => {
    clearTimeout(authTimer);
    subscribers.delete(ws);
  });
}

/* -------------------------------------------- */
/*  HTTP                                        */
/* -------------------------------------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
};

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  const allowed = ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin);
  if (!allowed) return {};
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes("*") ? "*" : origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin"
  };
}

function sendJSON(req, res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(req) });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
      }
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolveBody({});
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("Body must be JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function bearerToken(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  return match?.[1] ?? null;
}

/**
 * REST routes:
 *   GET  /api/health                      relay and Foundry status (no auth)
 *   GET  /api/me                          the token's user and their characters
 *   GET  /api/actors/:id                  a character sheet
 *   POST /api/actors/:id/:action          change something; JSON body holds parameters
 */
async function handleApi(req, res, path) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }
  if (path === "/api/health") {
    return sendJSON(req, res, 200, { relay: true, foundry: !!world, world: world?.worldTitle ?? null });
  }

  const token = bearerToken(req);
  if (!token) return sendJSON(req, res, 401, { error: "Missing Authorization: Bearer <token> header" });

  let action, params = {};
  const parts = path.split("/").filter(Boolean); // ["api", ...]
  if (req.method === "GET" && parts.length === 2 && parts[1] === "me") action = "me";
  else if (req.method === "GET" && parts.length === 3 && parts[1] === "actors") {
    action = "getActor";
    params = { actorId: parts[2] };
  }
  else if (req.method === "POST" && parts.length === 4 && parts[1] === "actors" && /^[a-zA-Z]+$/.test(parts[3])) {
    let body;
    try { body = await readBody(req); }
    catch (err) { return sendJSON(req, res, err.status ?? 400, { error: err.message }); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return sendJSON(req, res, 400, { error: "Body must be a JSON object" });
    }
    action = parts[3];
    params = { ...body, actorId: parts[2] };
  }
  else return sendJSON(req, res, 404, { error: "Not found" });

  const reply = await forward(token, action, params);
  if (reply.ok) return sendJSON(req, res, 200, reply.data ?? {});
  return sendJSON(req, res, reply.status ?? 500, { error: reply.error ?? "Unknown error" });
}

async function serveStatic(req, res, path) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    return res.end();
  }
  const relative = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
  let file = join(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https: http:; connect-src 'self' ws: wss:; frame-ancestors 'none'"
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }
  catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    if (pathname.startsWith("/api/")) await handleApi(req, res, pathname);
    else await serveStatic(req, res, pathname);
  }
  catch (err) {
    log("Request failed", err);
    if (!res.headersSent) sendJSON(req, res, 500, { error: "Internal error" });
  }
});

/* -------------------------------------------- */
/*  WebSockets                                  */
/* -------------------------------------------- */

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname !== "/foundry" && pathname !== "/api/events") return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    if (pathname === "/api/events") return attachSubscriber(ws);

    // Foundry: the first message must carry the shared secret.
    const helloTimer = setTimeout(() => ws.close(4001, "Say hello first"), 10_000);
    ws.once("message", raw => {
      clearTimeout(helloTimer);
      let hello;
      try { hello = JSON.parse(raw); } catch { return ws.close(4002, "Bad message"); }
      if (hello.type !== "hello" || !secretMatches(hello.secret)) {
        log("Rejected a Foundry connection with a bad secret");
        return ws.close(4001, "Bad secret");
      }
      ws.send(JSON.stringify({ type: "welcome" }));
      attachWorld(ws, hello);
    });
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

server.listen(PORT, () => log(`Sheet Relay listening on :${PORT}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.close(1001, "Server shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
