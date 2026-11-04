/* Browser host for the Term Arcade games.

   An xterm.js terminal runs a tiny fake shell. Starting a game spins up a
   Web Worker (worker.js) that runs the game's Go wasm binary and wires it to
   the terminal:

     stdout bytes -> term.write()
     keystrokes   -> worker, which answers the game's blocked stdin reads

   The games were written for a real terminal, so this file plays the part of
   the tty driver. "line" games (Wordle, Connect 4) read a line at a time, so
   input is echoed and edited here and sent on Enter, like a cooked tty.
   "raw" games (Tetris) get each key as it is pressed. */

(() => {
  "use strict";

  const PROMPT = "\x1b[1;32mguest@term-arcade\x1b[0m:\x1b[1;34m~\x1b[0m$ ";
  const GITHUB = "https://github.com/wwelden/Term-Arcade";

  const term = new Terminal({
    cursorBlink: true,
    convertEol: true, // the games print bare \n, like a cooked tty's ONLCR
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 15,
    theme: { background: "#000000" },
    allowProposedApi: true, // for term.unicode.activeVersion
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // The games draw with emoji (🟥 🔴); Unicode 11 widths make them two
  // columns, as in a real terminal, so the boards line up.
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.open(document.getElementById("terminal"));
  fit.fit();
  window.term = term; // for web/smoke.mjs, and the curious

  // ----------------------------------------------------------------- games

  // Each key is the program name, which is also the wasm file name.
  const GAMES = {
    tetris: {
      input: "raw",
      repo: "https://github.com/wwelden/TermTetris",
      about: "falling blocks — ←/→ or a/d move, ↑ or w rotates, ↓ or s drops, q quits",
      // Arrow keys arrive as escape sequences; the game reads single bytes.
      keymap: { "\x1b[A": "w", "\x1b[B": "s", "\x1b[C": "d", "\x1b[D": "a" },
      touch: [["←", "a"], ["↓", "s"], ["→", "d"], ["rotate", "w"], ["q", "q"]],
    },
    wordle: {
      input: "line",
      repo: "https://github.com/wwelden/TermWordle",
      about: "guess the word in six, then watch the solver AI take the same word",
      usage: "wordle [-mode vs|player|ai]",
      touch: [["⌫", "\x7f"], ["enter", "\r"]],
    },
    connect4: {
      input: "line",
      repo: "https://github.com/wwelden/TermConnect4",
      about: "connect four against a computer opponent — type a column and press Enter",
      touch: ["1", "2", "3", "4", "5", "6", "7", "8"].map((n) => [n, n + "\r"]),
    },
  };

  // ------------------------------------------------------------ the game

  let current = null; // { name, game, worker, line } while a game runs
  const encoder = new TextEncoder();

  function setTouchKeys(game) {
    const box = document.getElementById("touch-keys");
    box.replaceChildren();
    for (const [label, data] of game ? game.touch : []) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", () => {
        onData(data);
        term.focus();
      });
      box.append(b);
    }
  }

  function setActiveButton(name) {
    document.querySelectorAll("nav button[data-cmd]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.cmd === name));
    });
  }

  function send(data) {
    current.worker.postMessage({ type: "in", data: encoder.encode(data) });
  }

  function stopGame(note) {
    if (!current) return;
    current.worker.terminate();
    const { name } = current;
    current = null;
    setTouchKeys(null);
    setActiveButton(null);
    // Undo whatever state the game left the terminal in.
    term.write("\x1b[0m\x1b[?25h");
    if (note) term.write("\r\n\x1b[2m[" + name + " " + note + "]\x1b[0m");
    term.write("\r\n" + PROMPT);
    term.focus();
  }

  function runGame(name, args) {
    if (current) stopGame("stopped");
    const game = GAMES[name];
    term.clear();
    term.write("\x1b[2mloading " + name + "...\x1b[0m");

    const worker = new Worker("worker.js");
    current = { name, game, worker, line: "" };
    setTouchKeys(game);
    setActiveButton(name);

    worker.onmessage = (e) => {
      if (!current || current.worker !== worker) return;
      const msg = e.data;
      if (msg.type === "started") term.write("\r\x1b[2K");
      else if (msg.type === "out") term.write(msg.data);
      else if (msg.type === "exit") stopGame(msg.code ? "exited with status " + msg.code : "exited");
      else if (msg.type === "error") {
        term.write("\r\n\x1b[31m" + name + ": " + msg.message + "\x1b[0m");
        stopGame(null);
      }
    };
    worker.onerror = (e) => {
      if (current && current.worker === worker) {
        term.write("\r\n\x1b[31m" + name + ": " + e.message + "\x1b[0m");
        stopGame(null);
      }
    };
    worker.postMessage({ type: "start", url: "games/" + name + ".wasm", argv: [name, ...args] });
    term.focus();
  }

  // Raw games get keys as they come (Ctrl-C included: Tetris quits on it).
  function onGameRaw(data) {
    send(current.game.keymap?.[data] ?? data);
  }

  // Line games: echo, edit, and send a whole line on Enter.
  function onGameLine(data) {
    if (data.startsWith("\x1b")) return; // no line editing with arrows
    for (const ch of data) {
      if (ch === "\x03") {
        term.write("^C");
        stopGame("stopped");
        return;
      } else if (ch === "\r" || ch === "\n") {
        term.write("\r\n");
        send(current.line + "\n");
        current.line = "";
      } else if (ch === "\x7f" || ch === "\b") {
        if (current.line.length) {
          current.line = current.line.slice(0, -1);
          term.write("\b \b");
        }
      } else if (ch >= " ") {
        current.line += ch;
        term.write(ch);
      }
    }
  }

  // ------------------------------------------------------------------ shell

  let line = "";
  const history = [];
  let historyPos = 0;

  function help() {
    term.writeln("\x1b[1mgames\x1b[0m");
    for (const [name, g] of Object.entries(GAMES)) {
      term.writeln("  \x1b[32m" + name.padEnd(9) + "\x1b[0m " + g.about);
      if (g.usage) term.writeln("            \x1b[2musage: " + g.usage + "\x1b[0m");
    }
    term.writeln("\x1b[1mshell\x1b[0m");
    term.writeln("  \x1b[32mls\x1b[0m        list games        \x1b[32mabout\x1b[0m     what this is");
    term.writeln("  \x1b[32mclear\x1b[0m     clear screen      \x1b[32mhelp\x1b[0m      this message");
    term.writeln("Ctrl-C stops a running game. Tab completes, ↑ recalls history.");
  }

  function about() {
    term.writeln("Three terminal games I wrote in Go. What you are playing is the real");
    term.writeln("code from each game's repository, compiled unmodified with Go's js/wasm");
    term.writeln("target. Each runs in a Web Worker; its stdout feeds this xterm.js");
    term.writeln("terminal, and its stdin reads wait on your keystrokes.");
    term.writeln("");
    for (const [name, g] of Object.entries(GAMES)) {
      term.writeln("  " + name.padEnd(9) + " \x1b[4m" + g.repo + "\x1b[0m");
    }
    term.writeln("  " + "site".padEnd(9) + " \x1b[4m" + GITHUB + "\x1b[0m");
  }

  function execute(cmdline) {
    const [cmd, ...rest] = cmdline.trim().split(/\s+/).filter(Boolean);
    if (!cmd) return false;
    const name = cmd.replace(/^\.\//, "");
    if (Object.hasOwn(GAMES, name)) {
      runGame(name, rest);
      return true;
    }
    switch (cmd) {
      case "help": help(); break;
      case "about": about(); break;
      case "clear": term.clear(); break;
      case "ls": term.writeln(Object.keys(GAMES).map((n) => "\x1b[1;32m" + n + "\x1b[0m").join("  ")); break;
      case "whoami": term.writeln("guest"); break;
      case "exit": term.writeln("there is no exit. there are only more games."); break;
      case "sudo": term.writeln("guest is not in the sudoers file. This incident will be reported."); break;
      default: term.writeln(cmd + ": command not found (try 'help')");
    }
    return false;
  }

  function replaceLine(text) {
    term.write("\r\x1b[2K" + PROMPT + text);
    line = text;
  }

  function completeTab() {
    if (line.includes(" ")) return;
    const matches = [...Object.keys(GAMES), "help", "about", "clear", "ls"]
      .filter((c) => c.startsWith(line) && c !== line);
    if (matches.length === 1) {
      const extra = matches[0].slice(line.length) + " ";
      line += extra;
      term.write(extra);
    } else if (matches.length > 1) {
      term.write("\r\n" + matches.join("  ") + "\r\n" + PROMPT + line);
    }
  }

  function onShell(data) {
    if (data === "\x1b[A") {
      if (historyPos > 0) replaceLine(history[--historyPos]);
      return;
    }
    if (data === "\x1b[B") {
      if (historyPos < history.length - 1) replaceLine(history[++historyPos]);
      else { historyPos = history.length; replaceLine(""); }
      return;
    }
    if (data.startsWith("\x1b")) return;

    for (const ch of data) {
      if (ch === "\r") {
        term.write("\r\n");
        const cmdline = line;
        line = "";
        if (cmdline.trim()) history.push(cmdline);
        historyPos = history.length;
        if (execute(cmdline)) return; // a game took over the terminal
        term.write(PROMPT);
      } else if (ch === "\x7f" || ch === "\b") {
        if (line.length) {
          line = line.slice(0, -1);
          term.write("\b \b");
        }
      } else if (ch === "\t") {
        completeTab();
      } else if (ch === "\x03") {
        term.write("^C\r\n" + PROMPT);
        line = "";
      } else if (ch === "\x0c") {
        term.clear();
      } else if (ch >= " ") {
        line += ch;
        term.write(ch);
      }
    }
  }

  function onData(data) {
    if (!current) onShell(data);
    else if (current.game.input === "raw") onGameRaw(data);
    else onGameLine(data);
  }

  term.onData(onData);
  window.addEventListener("resize", () => fit.fit());
  new ResizeObserver(() => fit.fit()).observe(document.getElementById("terminal"));

  document.querySelectorAll("nav button[data-cmd]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.cmd;
      if (!current) term.write("\r\x1b[2K" + PROMPT + name + "\r\n");
      line = "";
      runGame(name, []);
    });
  });

  // ------------------------------------------------------------------- boot

  term.writeln("\x1b[1;32m+-------------+\r\n| term-arcade |\r\n+-------------+\x1b[0m");
  term.writeln("");
  term.writeln("Go terminal games, compiled to WebAssembly. Type \x1b[32mhelp\x1b[0m, or try \x1b[32mtetris\x1b[0m.");
  term.writeln("");
  term.write(PROMPT);
  term.focus();

  // Deep links: /#tetris starts that game straight away.
  const linked = location.hash.slice(1);
  if (Object.hasOwn(GAMES, linked)) {
    term.write(linked + "\r\n");
    runGame(linked, []);
  }
})();
