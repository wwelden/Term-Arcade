<img src="web/public/favicon.svg" width="64" height="64" alt="">

# Term Arcade

Three terminal games I wrote in Go, playable in the browser. Each game is
compiled **unmodified** from its own repository with Go's `js/wasm` target and
runs inside an [xterm.js](https://xtermjs.org) terminal.

| Game | Source | How it reads input |
| --- | --- | --- |
| Tetris | [TermTetris](https://github.com/wwelden/TermTetris) | one key at a time (raw) |
| Wordle, with a solver AI | [TermWordle](https://github.com/wwelden/TermWordle) | a line at a time |
| Connect 4 vs. the computer | [TermConnect4](https://github.com/wwelden/TermConnect4) | a line at a time |

Deep links start a game directly: `/#tetris`, `/#wordle`, `/#connect4`.

## How it works

The games only use stdout, stdin and ANSI escape codes, so the browser just has
to act as the terminal:

- **Output.** Go's wasm runtime sends every write to a global `fs` object that
  `wasm_exec.js` leaves as a stub. `web/public/worker.js` fills it in and posts
  stdout and stderr bytes to the page, which writes them to xterm.js.
- **Input.** `fs.read` on stdin is asynchronous in Go's js/wasm port: the
  goroutine parks until the callback fires. The worker holds that callback
  until the page sends keystrokes, so a game blocked on stdin waits just like
  it would on a real tty.
- **The tty driver.** `web/public/main.js` handles what the kernel normally
  would. For line-mode games (Wordle, Connect 4) it echoes and edits input and
  sends it on Enter, like a cooked tty. For Tetris it passes keys straight
  through, and maps the arrow keys to the game's `wasd`.
- **Stopping a game.** Each game runs in its own Web Worker, because Go's wasm
  runtime has no way to cancel a program that is still looping. Ctrl-C, or
  starting another game, terminates the worker.

xterm.js uses Unicode 11 character widths, so the emoji the games draw with
(🟥 🔴) take two columns, as in a real terminal, and the boards line up.

## Build and run

```sh
bash web/build.sh                 # fetch the games at pinned commits, build wasm
python3 -m http.server -d web/public 8000
```

`web/build.sh` uses `go` from `PATH` if it is 1.25 or newer, and otherwise
downloads a pinned Go toolchain into `.go/`; Vercel's build image takes that
path. The game commits are pinned at the top of the script. To pick up changes
to a game, update its commit hash there.

## Test

```sh
bun install
bunx playwright install chromium
bun run smoke                     # plays each game in headless Chromium
```

The smoke test starts every game, sends it input, checks what reaches the
terminal (including that emoji are two columns wide), and saves a screenshot of
each game to `web/smoke-*.png`.

## Deploy

`vercel.json` runs `web/build.sh` and serves `web/public` as a static site.
There is no server code.
