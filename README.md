# LAN Remote — minimal local-only remote desktop

Control your main PC from a laptop over your home network. The screen is
H.264-encoded and streamed to the laptop's **browser**; your mouse and keyboard
go back. No account, no cloud, no internet — only the two machines talk.

## What you need (main PC only)

1. **Node.js** 20+ — https://nodejs.org
2. **ffmpeg** on your PATH — `winget install Gyan.FFmpeg`, then reopen the terminal.
   Check with `ffmpeg -version`.

## Run

On the **main PC** (the one you want to control), open the terminal with
**Run as administrator** (Start → type `PowerShell` → right-click → Run as
administrator), go to this folder, then:

```
npm install
npm start
```

Before the first start, create a file named `password.txt` in this folder
containing your login password (just the password, nothing else). It is listed
in `.gitignore`, so it never gets pushed.

Why administrator: Windows silently blocks mouse/keyboard input from a normal
program into admin windows (Task Manager, installers, admin terminals). Without
it, the remote stops responding whenever such a window is in front — and with
the lid closed you can't fix it locally. The server prints a NOTE if it isn't
running as administrator.

It prints the address to open, e.g. `https://192.168.1.9:8080`.

On the **laptop**, open that address in **Chrome or Edge** (typing `http://`
also works — it redirects to `https://`).

The **first time**, the browser warns "Your connection is not private". That is
expected: the server makes its own certificate (browsers only allow the video
decoder on `https://` pages). Click **Advanced → Proceed to 192.168.1.9**.
The connection is encrypted; the warning only means no public authority signed it.

Enter the password from `password.txt`, then click the screen
to capture mouse and keyboard. That's it.

## Keep it LAN-only (recommended)

- Don't forward any router ports. This binds to your LAN only.
- When Windows Firewall prompts, allow it on **Private** networks only.
- Set your Wi-Fi/Ethernet profile to **Private**.

## Lowest latency

A wired main PC (Ethernet) + 5 GHz Wi-Fi laptop gets ~15–30 ms on a clean LAN.

- **NVIDIA GPU?** Swap the encoder for near-zero CPU use. In `server.js`,
  replace the `libx264 … -x264-params …` block with:
  ```
  "-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ll",
  "-rc", "cbr", "-bf", "0", "-g", "60", "-forced-idr", "1",
  "-bsf:v", "h264_metadata=aud=insert",
  ```
- Prefer a 5 GHz / Wi-Fi 6 band, or plug both into the router by Ethernet.

## Notes

- Input control uses the optional `@nut-tree-fork/nut-js` package. If it fails to
  build (needs VS Build Tools on Windows), the app still runs **view-only**.
- Keys are sent as physical keys, so Ctrl/Shift/Alt combos and F-keys work.
  Shortcuts the laptop itself reserves stay on the laptop: Win, Alt+Tab,
  Ctrl+Alt+Del, and browser ones like Ctrl+W / Ctrl+T / Ctrl+N.
- Can't be controlled remotely even as administrator: UAC "Yes/No" prompts and
  the lock screen (Windows shows them on a separate secure desktop).
- `tls-key.pem` / `tls-cert.pem` are created on first start. Delete them to
  make a new certificate (the laptop will show the warning once more).
- Env overrides: `PORT`, `FPS`, `BITRATE`, `FFMPEG`. Example:
  `set BITRATE=35M && npm start`
- This is intentionally tiny. No file transfer, no audio, no multi-monitor
  picking — the screen stays on the main PC; only pixels and input cross the wire.
