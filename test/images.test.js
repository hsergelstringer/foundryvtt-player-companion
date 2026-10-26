/**
 * The relay serving Foundry's images (FOUNDRY_URL): the real relay as a child
 * process, the real module in a simulated world, and a small HTTP server
 * standing in for Foundry's file server.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, get } from "node:http";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { installFoundry, startFoundry } from "./support/foundry.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SECRET = "test-secret-0123456789";
const SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\"/>";

let relay;
let files;
let base;
let world;
let api;
let token;
/** Paths the stand-in Foundry was asked for. */
const asked = [];

const freePort = () => new Promise(resolve => {
  const server = createNetServer().listen(0, () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const waitFor = async (check, what, timeout = 5000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
};

const image = (path, headers = {}, auth = token) =>
  fetch(`${base}/api/images/${path}`, { headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers } });

before(async () => {
  files = createServer((req, res) => {
    asked.push(req.url);
    if (req.url === "/icons/svg/d20.svg") {
      if (req.headers["if-none-match"] === "\"v1\"") {
        res.writeHead(304, { ETag: "\"v1\"" });
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "text/html", ETag: "\"v1\"" });
      return res.end(SVG);
    }
    if (req.url === "/worlds/test/My%20Portrait.webp") {
      res.writeHead(200, { "Content-Type": "image/webp" });
      return res.end("webp-bytes");
    }
    if (req.url === "/huge.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(25 * 1024 * 1024) });
      return res.write("x");
    }
    res.writeHead(404);
    res.end();
  });
  const filesPort = await listen(files);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  relay = spawn(process.execPath, ["server.js"], {
    cwd: `${ROOT}/server`,
    env: { ...process.env, PORT: String(port), RELAY_SECRET: SECRET, FOUNDRY_URL: `http://127.0.0.1:${filesPort}/` },
    stdio: ["ignore", "pipe", "inherit"]
  });
  await new Promise((resolve, reject) => {
    relay.stdout.on("data", chunk => { if (String(chunk).includes("listening")) resolve(); });
    relay.on("exit", code => reject(new Error(`Relay exited with ${code}`)));
  });

  world = installFoundry({ relayUrl: base, relaySecret: SECRET });
  await import("../module/scripts/main.js");
  startFoundry();
  api = game.modules.get("player-companion").api;
  await waitFor(() => api.Relay.status === "connected", "the module to connect to the relay");
  token = await api.Tokens.create(world.ursula, "Phone");
});

after(() => {
  api?.Relay.disconnect();
  relay?.kill();
  files?.close();
});

describe("images through the relay", () => {
  test("health says the relay serves images", async () => {
    assert.equal((await (await fetch(`${base}/api/health`)).json()).images, true);
  });

  test("the event stream tells the app which image URLs are Foundry's", async () => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/events`);
    const messages = [];
    socket.addEventListener("message", e => messages.push(JSON.parse(e.data)));
    await new Promise(resolve => socket.addEventListener("open", resolve));
    socket.send(JSON.stringify({ type: "auth", token }));
    await waitFor(() => messages.some(m => m.type === "ready"), "ready");
    assert.equal(messages.find(m => m.type === "ready").imageOrigin, "https://foundry.test");
    socket.close();
  });

  test("serves an image with the type from its extension, and can't run scripts", async () => {
    const res = await image("icons/svg/d20.svg");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/svg+xml");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy"), /sandbox/);
    assert.match(res.headers.get("cache-control"), /private/);
    assert.equal(await res.text(), SVG);
  });

  test("passes revalidation through", async () => {
    const res = await image("icons/svg/d20.svg", { "If-None-Match": "\"v1\"" });
    assert.equal(res.status, 304);
    assert.equal(res.headers.get("etag"), "\"v1\"");
  });

  test("keeps encoded names intact", async () => {
    const res = await image("worlds/test/My%20Portrait.webp");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "webp-bytes");
  });

  test("needs a working token", async () => {
    assert.equal((await image("icons/svg/d20.svg", {}, null)).status, 401);
    assert.equal((await image("icons/svg/d20.svg", {}, "pc_not-a-real-token")).status, 401);
  });

  test("a revoked token stops getting images at once", async () => {
    const old = await api.Tokens.create(world.ursula, "Old phone");
    assert.equal((await image("icons/svg/d20.svg", {}, old)).status, 200);
    const id = api.Tokens.list(world.ursula).find(t => t.label === "Old phone").id;
    await api.Tokens.revoke(world.ursula, id);
    // The module tells the relay about the revocation over its socket.
    await new Promise(r => setTimeout(r, 200));
    assert.equal((await image("icons/svg/d20.svg", {}, old)).status, 401);
  });

  test("only image files, and nothing outside Foundry", async () => {
    asked.length = 0;
    assert.equal((await image("worlds/test/data.json")).status, 404);
    // Sent raw: fetch() would tidy the dots away before sending.
    const raw = await new Promise((resolve, reject) => get(`${base}/api/images/%2e%2e/%2e%2e/etc/passwd.png`,
      { headers: { Authorization: `Bearer ${token}` } }, res => { res.resume(); resolve(res.statusCode); }).on("error", reject));
    assert.notEqual(raw, 200);
    assert.equal((await image("icons/..%2F..%2Fsecret.png")).status, 400);
    assert.equal((await image("icons//d20.svg")).status, 400);
    assert.deepEqual(asked, [], "none of these reached Foundry");
  });

  test("missing and oversized images", async () => {
    assert.equal((await image("icons/missing.png")).status, 404);
    assert.equal((await image("huge.png")).status, 413);
  });

  test("other requests still work", async () => {
    const res = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
  });
});
