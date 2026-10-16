# LAN Remote — project context

Address the user as **Jarvis**.

## Goal
A minimal, **LAN-only** remote desktop: control the main PC from a laptop on the
same home network with the lowest practical latency.

Hard requirements from the user:
- **No internet, no cloud, no third-party servers.** Only the two machines talk.
- **No data sharing** — files stay on the main PC. Only screen pixels go to the
  laptop and mouse/keyboard input comes back. No file transfer, no clipboard sync.
- **Minimal** — no extra features. Run one command on the main PC (`npm start`),
  open a browser on the laptop. That's it.
- **On demand** — runs only while started; nothing listening otherwise.

## Environment
- Both machines: **Windows Home** (so built-in RDP hosting is not available).
- Project lives at `Desktop\remote` on the main PC. `npm install` has been run.
- Requires Node.js 20+ and `ffmpeg` on PATH (`winget install Gyan.FFmpeg`).
- Client must be Chrome or Edge (WebCodecs `VideoDecoder`).

## Architecture
```
main PC                                         laptop (browser)
ffmpeg gdigrab -> libx264 zerolatency  ->  server.js  ---wss://--->  index.html
(capture)         (encode, Annex-B)       (split AUs,                (WebCodecs decode
                                           relay, cache GOP)          -> canvas)
nut-js  <------------------ JSON input messages ------------------  mouse/keys
```

### Files
- `server.js` — HTTPS (serves index.html) + secure WebSocket on `0.0.0.0:8080`.
  A plain-TCP front sniffs the first byte: TLS goes to the HTTPS server, plain
  `http://` gets a 302 to `https://` on the same port.
  Self-signed ECDSA P-256 cert generated with `node:crypto` + a tiny DER encoder
  on first start, saved as `tls-key.pem` / `tls-cert.pem` (SAN: localhost + LAN IPs).
  Spawns ffmpeg, splits stdout into access units on AUD NALs (`aud=1`),
  prefixes each with a 1-byte key/delta flag, broadcasts to clients.
  Caches the current GOP (keyframe + deltas since) and replays it to new viewers.
  A client with > 512 KB `bufferedAmount` drops deltas until the next keyframe
  (bounded lag instead of growing lag). Restarts ffmpeg on exit.
  Injects input via optional `@nut-tree-fork/nut-js` (falls back to view-only),
  serialized through a promise chain; keys/buttons a client holds are released
  when it disconnects.
- `index.html` — single page. `VideoDecoder` with `optimizeForLatency: true`,
  configured *before* the socket opens (so the replayed GOP isn't dropped),
  waits for first keyframe, draws to canvas, closes frames immediately,
  rebuilds the decoder on error.
  Sends mouse (normalized 0..1, letterbox-aware, coalesced per rAF), buttons,
  wheel, keys as JSON. Pending move is flushed before clicks/wheel. On window
  blur, sends releases for held keys/buttons.
- `package.json` — `ws` dependency, nut-js optional. ES modules.
- `README.md` — user-facing run instructions.

### Wire protocol
- Login: client's first message is `{t:"auth",p}`. Server compares SHA-256 digests
  with `timingSafeEqual` against `PASSWORD`, read from `password.txt` next to
  server.js (gitignored; server exits if missing/empty). It was hardcoded until the
  repo went to public GitHub — never commit it. OK -> text `"ok"`, then GOP replay + live video, input
  accepted. Wrong -> 1 s delay, close code 4001. Before auth: no video, input ignored.
  Page shows a password form and opens the socket only on submit.
- Server -> client (binary): `[1 byte: 1=key, 0=delta][H.264 Annex-B access unit]`
- Client -> server (JSON text): `{t:"m",x,y}` move, `{t:"d"|"u",b}` button,
  `{t:"w",dy}` wheel (browser px; server sends `dy*1.2` raw wheel units, 120 = notch),
  `{t:"k",k,down}` key where `k` is `KeyboardEvent.code` (physical key), mapped
  to nut-js `Key` in `KEYS` and pressed/released as-is.

### Env overrides
`PORT` (8080), `FPS` (60), `BITRATE` (20M), `FFMPEG` (path), `HOST` (0.0.0.0).

## Decisions and rationale
- **WebSocket (TCP) for now** because browsers can't open raw UDP. Fine on a clean
  wired / 5 GHz LAN. Known trade-off: head-of-line blocking can cause hitches on
  lossy Wi-Fi. **Upgrade path:** WebRTC (UDP) for the video path, keeping the same
  capture and input code.
- Encoder tuned for latency: ultrafast, zerolatency, baseline, no B-frames,
  no lookahead, keyint 60, repeat-headers, small bufsize.
- **NVIDIA swap** (documented in README): `h264_nvenc -preset p1 -tune ll -rc cbr
  -bf 0 -g 60 -forced-idr 1 -bsf:v h264_metadata=aud=insert`.
- Native alternative considered: Sunshine + Moonlight (UDP + FEC, lowest latency).
  User chose to build this minimal version instead.

## Security / LAN-only
- No router port forwarding; Windows Firewall rule allowed on **Private** only.
- npm audit: `phin` deprecation and 7 moderate advisories come from nut-js's
  image dependency (`jimp`), which this project doesn't use. **Do not run
  `npm audit fix --force`** — it can break nut-js.
- **HTTPS is required, not optional:** WebCodecs is SecureContext-only, so on
  `http://<LAN-IP>` `VideoDecoder` is undefined (verified). Self-signed cert means
  a one-time "Advanced -> Proceed" on the laptop. Traffic is encrypted.
- Password login (see Wire protocol). No lockout beyond the 1 s delay per attempt.

## Verified on the main PC (2026-10-16)
- **DPI scaling (125%):** nut-js is 1536x864 logical, gdigrab 1920x1080 physical.
  Normalized coords map correctly (libnut converts to 0..65535 absolute with the
  same logical size); measured within 1 px.
- End to end in headless Edge (`--ignore-certificate-errors`): secure context,
  1920x1080 painted, first picture ~300-500 ms after page open.
- Input over wss://: move lands exactly; F24 press via `code` mapping; server
  releases held keys on client drop.
- nut-js gotchas: `scrollDown(n)` is *raw* wheel units (not notches); `Key.*`
  values can be 0, so test `=== undefined`, not truthiness.

## Known limits
- Browser/OS-reserved shortcuts stay on the laptop (Win, Alt+Tab, Ctrl+Alt+Del,
  Ctrl+W/T/N). Keyboard Lock API would need fullscreen; not added.
- **UIPI:** a non-elevated server's injected input is silently dropped while an
  elevated window is foreground (SendInput still returns success, last-input time
  doesn't update). Task Manager auto-elevates (user is admin, UAC level 5) and is
  the usual trigger. Fix = run `npm start` from an admin terminal; server checks
  with `fltmc` and prints a NOTE if not elevated. UAC secure-desktop prompts and
  the lock screen still can't be controlled (would need a SYSTEM service).

## Lid-close investigation (2026-10-16)
- Lid action on AC = "Do nothing" (DC = Sleep). With lid shut: display state stays
  "on", input desktop stays Default, capture live, 60 fps, injection keeps working.
- User's "input dies ~2 min after closing lid" was Task Manager opened via Start
  search (UIPI above), not the lid. Reopening the lid didn't restore input; closing
  Task Manager locally did. On battery the lid sleeps the PC (DC lid action = Sleep).
- Secure desktop (UAC prompts, lock screen) can't be captured by gdigrab.
- Only the primary monitor ("desktop" = all monitors combined with gdigrab).
- WebCodecs timestamps are synthetic (fixed 60 fps step) — harmless for display.

## Working style
- Keep it minimal; don't add features the user didn't ask for.
- Preserve the core pipeline; prefer small, targeted changes.
