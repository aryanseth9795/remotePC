// Minimal LAN-only remote desktop server.
// Pipeline: ffmpeg (screen capture + H.264) -> this relay -> browser (WebCodecs).
// Nothing leaves your machine except to the laptop you connect from.

import https from "node:https";
import net from "node:net";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { generateKeyPairSync, randomBytes, sign, createHash, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOST = process.env.HOST || "0.0.0.0";      // 0.0.0.0 = reachable on the LAN
const PORT = Number(process.env.PORT || 8080);
const FFMPEG = process.env.FFMPEG || "ffmpeg";   // set if ffmpeg isn't on PATH
const FPS = process.env.FPS || "60";
const BITRATE = process.env.BITRATE || "20M";    // LAN has bandwidth to spare

// Login password: the text in password.txt next to this file (kept out of git).
const passwordFile = join(__dirname, "password.txt");
const PASSWORD = existsSync(passwordFile) ? readFileSync(passwordFile, "utf8").trim() : "";
if (!PASSWORD) {
  console.error("Missing password: create password.txt next to server.js containing the login password.");
  process.exit(1);
}

const sha = (s) => createHash("sha256").update(String(s)).digest();
const passwordOk = (p) => timingSafeEqual(sha(p), sha(PASSWORD));

const lanIPs = () => Object.values(networkInterfaces()).flat()
  .filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address);

// --- optional input injection (mouse/keyboard). View-only if this fails. ---
let input = null;
try {
  const nut = await import("@nut-tree-fork/nut-js");
  nut.mouse.config.autoDelayMs = 0;
  nut.keyboard.config.autoDelayMs = 0;
  // nut-js works in logical (DPI-scaled) pixels. The client sends 0..1, so scaling cancels out.
  const SW = await nut.screen.width();
  const SH = await nut.screen.height();
  const K = nut.Key;
  const BTN = { 0: nut.Button.LEFT, 1: nut.Button.MIDDLE, 2: nut.Button.RIGHT };
  // Browser KeyboardEvent.code (physical key) -> nut-js Key. Keys are pressed and
  // released as-is, so Ctrl/Shift/Alt combos behave like a local keyboard.
  const KEYS = {
    Backquote: K.Grave, Minus: K.Minus, Equal: K.Equal, BracketLeft: K.LeftBracket,
    BracketRight: K.RightBracket, Backslash: K.Backslash, Semicolon: K.Semicolon,
    Quote: K.Quote, Comma: K.Comma, Period: K.Period, Slash: K.Slash,
    Enter: K.Enter, Backspace: K.Backspace, Tab: K.Tab, Escape: K.Escape, Space: K.Space,
    Insert: K.Insert, Delete: K.Delete, Home: K.Home, End: K.End,
    PageUp: K.PageUp, PageDown: K.PageDown,
    ArrowUp: K.Up, ArrowDown: K.Down, ArrowLeft: K.Left, ArrowRight: K.Right,
    ShiftLeft: K.LeftShift, ShiftRight: K.RightShift, ControlLeft: K.LeftControl,
    ControlRight: K.RightControl, AltLeft: K.LeftAlt, AltRight: K.RightAlt,
    MetaLeft: K.LeftWin, MetaRight: K.RightWin, ContextMenu: K.Menu,
    CapsLock: K.CapsLock, NumLock: K.NumLock, ScrollLock: K.ScrollLock, PrintScreen: K.Print,
    NumpadAdd: K.Add, NumpadSubtract: K.Subtract, NumpadMultiply: K.Multiply,
    NumpadDivide: K.Divide, NumpadDecimal: K.Decimal, NumpadEnter: K.Enter,
  };
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") KEYS["Key" + c] = K[c];
  for (let i = 0; i <= 9; i++) { KEYS["Digit" + i] = K["Num" + i]; KEYS["Numpad" + i] = K["NumPad" + i]; }
  for (let i = 1; i <= 24; i++) KEYS["F" + i] = K["F" + i];
  input = { nut, SW, SH, BTN, KEYS };
  console.log(`Input control enabled (screen ${SW}x${SH}).`);
} catch {
  console.log("Input control disabled (nut-js not installed) — view-only mode.");
}

// `held` tracks what this client has pressed, so it can be released if the client drops.
async function handleInput(m, held) {
  if (!input) return;
  const { nut, SW, SH, BTN, KEYS } = input;
  try {
    switch (m.t) {
      case "m": await nut.mouse.setPosition(new nut.Point(Math.round(m.x * SW), Math.round(m.y * SH))); break;
      case "d": held.buttons.add(m.b); await nut.mouse.pressButton(BTN[m.b] ?? BTN[0]); break;
      case "u": held.buttons.delete(m.b); await nut.mouse.releaseButton(BTN[m.b] ?? BTN[0]); break;
      case "w": {
        // nut-js sends raw wheel units (120 = one notch); Chrome reports ~100 px per notch.
        const units = Math.round(m.dy * 1.2);
        if (units > 0) await nut.mouse.scrollDown(units);
        else if (units < 0) await nut.mouse.scrollUp(-units);
        break;
      }
      case "k": {
        const key = KEYS[m.k];
        if (key === undefined) break;
        if (m.down) { held.keys.add(m.k); await nut.keyboard.pressKey(key); }
        else { held.keys.delete(m.k); await nut.keyboard.releaseKey(key); }
        break;
      }
    }
  } catch { /* ignore transient injection errors to keep latency low */ }
}

// Run injections strictly in arrival order (a click must not overtake its move).
let inputChain = Promise.resolve();
const queueInput = (m, held) => { inputChain = inputChain.then(() => handleInput(m, held)); };

// Windows silently drops input sent from a normal process into an admin window
// (Task Manager, installers, admin terminals). Elevated, this server can reach them too.
const elevated = spawnSync("fltmc").status === 0; // fltmc only succeeds as administrator

// --- ffmpeg: capture the desktop and emit a raw H.264 Annex-B stream on stdout ---
// gdigrab works on any Windows GPU. For NVIDIA, see README for the NVENC swap.
function ffmpegArgs() {
  return [
    "-hide_banner", "-loglevel", "error",
    "-f", "gdigrab", "-framerate", FPS, "-draw_mouse", "1", "-i", "desktop",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-profile:v", "baseline", "-pix_fmt", "yuv420p",
    "-x264-params",
      "aud=1:keyint=60:min-keyint=60:scenecut=0:bframes=0:rc-lookahead=0:repeat-headers=1",
    "-b:v", BITRATE, "-maxrate", BITRATE, "-bufsize", "2M",
    "-f", "h264", "pipe:1",
  ];
}

const clients = new Set();   // connected browser sockets
let gop = [];                // current keyframe + deltas since, so new viewers start instantly
const MAX_BUFFERED = 512 * 1024; // a client this far behind skips to the next keyframe

let ff;
function startFFmpeg() {
  ff = spawn(FFMPEG, ffmpegArgs());
  ff.stderr.on("data", (d) => process.stderr.write(d));
  ff.on("error", (e) => {
    console.error(`Could not run ffmpeg (${e.message}). Install it: winget install Gyan.FFmpeg`);
    process.exit(1);
  });
  ff.on("exit", (code) => {
    console.log(`ffmpeg exited (${code}); restarting in 1s...`);
    gop = [];
    setTimeout(startFFmpeg, 1000);
  });

  // Split the byte stream into access units on AUD (access-unit delimiter) NALs.
  let buf = Buffer.alloc(0);
  ff.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const pos = [];
    let i = 0;
    while (i <= buf.length - 5) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1 && buf[i + 4] === 9) { pos.push(i); i += 5; continue; }
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1 && buf[i + 3] === 9) { pos.push(i); i += 4; continue; }
      i++;
    }
    if (pos.length < 2) return;
    for (let k = 0; k < pos.length - 1; k++) emitAU(buf.subarray(pos[k], pos[k + 1]));
    buf = buf.subarray(pos[pos.length - 1]);
  });
}

function isKeyframe(au) {
  for (let i = 0; i <= au.length - 4; i++) {
    if (au[i] === 0 && au[i + 1] === 0) {
      const p = au[i + 2] === 1 ? i + 3 : (au[i + 2] === 0 && au[i + 3] === 1 ? i + 4 : -1);
      if (p > 0) { const t = au[p] & 0x1f; if (t === 5 || t === 7) return true; }
    }
  }
  return false;
}

function emitAU(au) {
  const key = isKeyframe(au);
  const frame = Buffer.concat([Buffer.from([key ? 1 : 0]), au]); // 1-byte header: key/delta
  if (key) gop = [];
  gop.push(frame);
  for (const ws of clients) {
    if (ws.readyState !== 1 || (ws.skipping && !key)) continue;
    ws.skipping = ws.bufferedAmount > MAX_BUFFERED; // behind (e.g. Wi-Fi hiccup): drop, don't lag
    if (!ws.skipping) ws.send(frame);
  }
}

// --- TLS: browsers only expose WebCodecs on secure pages, so serve HTTPS with a
// self-signed certificate generated once and kept next to this file. ---
function makeSelfSignedCert() {
  const der = (tag, ...parts) => {
    const body = Buffer.concat(parts), n = body.length;
    const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
    return Buffer.concat([Buffer.from([tag, ...len]), body]);
  };
  const seq = (...p) => der(0x30, ...p);
  const oid = (s) => {
    const [a, b, ...rest] = s.split(".").map(Number), out = [40 * a + b];
    for (const v of rest) { const enc = [v & 127]; for (let x = v >> 7; x; x >>= 7) enc.unshift(128 | (x & 127)); out.push(...enc); }
    return der(0x06, Buffer.from(out));
  };
  const time = (d) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
  const name = seq(der(0x31, seq(oid("2.5.4.3"), der(0x0c, Buffer.from("LAN Remote")))));
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const serial = randomBytes(16); serial[0] = (serial[0] & 0x7f) | 0x40;
  const now = Date.now();
  const altNames = seq(der(0x82, Buffer.from("localhost")),
    ...lanIPs().map((ip) => der(0x87, Buffer.from(ip.split(".").map(Number)))));

  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),                  // v3
    der(0x02, serial), ecdsaSha256, name,
    seq(time(new Date(now - 864e5)), time(new Date(now + 5 * 365 * 864e5))),
    name, publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, seq(seq(oid("2.5.29.17"), der(0x04, altNames)))), // subjectAltName
  );
  const certDer = seq(tbs, ecdsaSha256, der(0x03, Buffer.from([0]), sign("sha256", tbs, privateKey)));
  const b64 = certDer.toString("base64").match(/.{1,64}/g).join("\n");
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
  };
}

const keyFile = join(__dirname, "tls-key.pem"), certFile = join(__dirname, "tls-cert.pem");
if (!existsSync(keyFile) || !existsSync(certFile)) {
  const { key, cert } = makeSelfSignedCert();
  writeFileSync(keyFile, key);
  writeFileSync(certFile, cert);
}

// --- HTTPS: serve the one-page client ---
const page = readFileSync(join(__dirname, "index.html"));
const server = https.createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  const held = { keys: new Set(), buttons: new Set() };
  let authed = false;              // no video and no input until the password is right
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (authed) return queueInput(m, held);
    if (m.t !== "auth") return;
    if (!passwordOk(m.p)) return void setTimeout(() => ws.close(4001, "wrong password"), 1000); // slow down guessing
    authed = true;
    ws.send("ok");
    clients.add(ws);
    for (const f of gop) ws.send(f); // start this viewer on the current picture, not the next keyframe
  });
  ws.on("close", () => {
    clients.delete(ws);
    // Never leave Ctrl/Shift/a mouse button stuck down on the main PC.
    for (const k of held.keys) queueInput({ t: "k", k, down: false }, held);
    for (const b of held.buttons) queueInput({ t: "u", b }, held);
  });
});

// One port for both: TLS goes to the server above, a plain http:// visit is redirected to https://.
const front = net.createServer((sock) => {
  sock.on("error", () => {});
  sock.once("readable", () => {
    const head = sock.read();
    if (!head) return sock.destroy();
    sock.unshift(head);
    if (head[0] === 0x16) return server.emit("connection", sock); // TLS handshake
    const host = /\r\nhost:\s*([^\r\n]+)/i.exec(head.toString("latin1"))?.[1] ?? `${lanIPs()[0]}:${PORT}`;
    sock.end(`HTTP/1.1 302 Found\r\nLocation: https://${host}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  });
});

front.listen(PORT, HOST, () => {
  const ips = HOST === "0.0.0.0" ? lanIPs() : [HOST];
  console.log("\nLAN remote ready. On the LAPTOP (Chrome/Edge) open:");
  for (const ip of ips) console.log(`  https://${ip}:${PORT}`);
  console.log("First visit shows a certificate warning (self-signed): Advanced -> Proceed.\n");
  if (input && !elevated) {
    console.log("NOTE: not running as administrator. Mouse/keys won't work while an admin window");
    console.log("      (e.g. Task Manager) is in front. Fix: open the terminal with \"Run as administrator\".\n");
  }
  startFFmpeg();
});
