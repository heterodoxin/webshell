# webshell

## What is this project

webshell is a terminal that runs in a browser: every WebSocket connection gets its own real PTY attached to a shell on the server, the shell's raw byte stream (characters plus ANSI escape sequences) travels as JSON text frames, and a hand-written HTML/CSS terminal emulator in the client renders it. Nothing but text crosses the network — no canvas frames, no screenshots, no remote desktop.

## Install

```bash
npm install
npm start
```

`npm install` builds the two runtime dependencies (`node-pty`, `ws`); `node-pty` compiles a small native module, so a C/C++ toolchain (gcc, make) must be present. `npm start` runs `server.js`, which serves the three static client files and listens on the first free port starting at 8080 — the startup banner prints the exact URL and a ready-made SSH tunnel command for the machine it runs on. Open that URL in a browser.

## Why it's better

Compared with web terminals that stream screenshots or remote-desktop frames:

- The wire carries the PTY byte stream as text, so traffic scales with the characters the shell emits rather than with the size of the window.
- The screen is real DOM text: output is selectable, searchable, copyable, and zoomable, rendered by the browser's own font engine.
- The server does no cell rendering or compositing — it spawns a PTY and forwards strings, while all emulation runs in the client.
- The client is three static files with no build step, and the server has exactly two runtime dependencies.

## Why should I care

- Any device with a modern browser becomes a terminal for this machine: no client to install, no VPN, no extra daemon.
- The default bind is loopback only, so exposure is exactly what you choose — the startup banner prints a ready-made SSH tunnel command, and `HOST`/`WEBSHELL_TOKEN` control wider access.
- Each browser tab is an isolated shell process; closing the tab ends that shell.
- Color, wide characters, and full-screen programs (vim, less, htop) work because the client implements the terminal protocol instead of displaying plain text.

## Advanced

Wire protocol — JSON messages on `/ws`:

- server → client: `{type:'data', data}` (raw bytes as text, split into frames of at most 64 KB with surrogate pairs kept intact) and `{type:'exit', code}`
- client → server: `{type:'input', data}` and `{type:'resize', cols, rows}`

Environment variables:

| Variable          | Default     | Effect                                                  |
|-------------------|-------------|---------------------------------------------------------|
| `PORT`            | `8080`      | Listen port; busy ports step upward until one is free   |
| `HOST`            | `127.0.0.1` | Bind address; `0.0.0.0` exposes the shell to the network |
| `WEBSHELL_TOKEN`  | unset       | When set, `/ws` requires `?token=<value>`               |
| `WEBSHELL_SHELL`  | `$SHELL`    | Shell to spawn                                          |

Emulator behavior:

- Supports SGR 16/256/truecolor, bold/dim/italic/underline/inverse/strike, double-width and combining characters, the alternate screen, scroll regions, DSR/DA replies, bracketed paste, and deferred line wrapping; scrollback holds 5000 lines.
- Grapheme clusters — combining accents, ZWJ emoji sequences, flag pairs, and skin-tone modifiers — occupy one cell so columns stay aligned with the shell.
- URLs in output render as links that open in a new tab; `Ctrl`+`=` and `Ctrl`+`-` adjust font size (`Ctrl`+`0` restores the default), persisted per browser.
- Lines a full-screen program (alternate screen) scrolls off the top are archived to scrollback, so history above a running TUI stays reachable; when such a program also enables mouse reporting (`?1000`, `?1002`, `?1003`, `?9`), wheel events are encoded as SGR mouse reports and delivered to it instead of scrolling the page, which is how TUIs that redraw in place scroll their own view.
- Shrinking the window in rows anchors content to the last used line and pushes overflow into scrollback; shrinking in columns keeps past-edge cells (reachable by horizontal scrolling) so text reappears when the window grows.
- `window.webshell` exposes `{term, write, send, fit}` for scripted use.

The shell runs with the user and permissions of the server process; anyone who reaches the port can use it, which is why the default bind is loopback.

---

> **Disclosure:** This project was made with the assistance of AI.
