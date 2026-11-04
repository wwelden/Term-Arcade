/* Runs one Go game (compiled with GOOS=js GOARCH=wasm) inside a Web Worker.

   Go's js/wasm port does all file I/O through a global `fs` object that
   wasm_exec.js stubs out. This worker fills in the three calls the games use:

     stdout/stderr writes -> postMessage({ type: "out" }) -> xterm.js
     stdin reads          -> wait for postMessage({ type: "in" }) from the page

   A read callback can fire long after the call. Go parks the goroutine until
   it does, so a game blocked on stdin simply waits, exactly like a real tty.

   Running in a worker means the page stops a game with worker.terminate():
   Go's wasm runtime has no other way to cancel a program that is still
   looping, such as Tetris's game loop. */

importScripts("wasm_exec.js");

const enosys = () => {
  const err = new Error("not implemented");
  err.code = "ENOSYS";
  return err;
};

// ------------------------------------------------------------------ stdout

globalThis.fs.writeSync = (fd, buf) => {
  if (fd === 1 || fd === 2) {
    // Copy: buf may be a view into wasm memory that Go reuses.
    postMessage({ type: "out", data: buf.slice() });
    return buf.length;
  }
  throw enosys();
};

globalThis.fs.write = (fd, buf, offset, length, position, callback) => {
  if (position !== null || (fd !== 1 && fd !== 2)) {
    callback(enosys());
    return;
  }
  postMessage({ type: "out", data: buf.slice(offset, offset + length) });
  callback(null, length);
};

// ------------------------------------------------------------------- stdin

const pending = []; // input bytes not yet handed to Go
let waiting = null; // the one outstanding read, if Go is blocked on stdin

// Hand over at most `length` bytes, stopping after a newline. Line-mode games
// get exactly one line per read, as from a cooked tty; key-at-a-time games
// read one byte at a time anyway.
function fulfil({ buffer, offset, length, callback }) {
  let n = 0;
  while (n < length && pending.length) {
    const b = pending.shift();
    buffer[offset + n++] = b;
    if (b === 10) break;
  }
  callback(null, n);
}

globalThis.fs.read = (fd, buffer, offset, length, position, callback) => {
  if (fd !== 0) {
    callback(enosys());
    return;
  }
  const req = { buffer, offset, length, callback };
  if (pending.length) fulfil(req);
  else waiting = req;
};

onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "in") {
    for (const b of msg.data) pending.push(b);
    if (waiting && pending.length) {
      const req = waiting;
      waiting = null;
      fulfil(req);
    }
  } else if (msg.type === "start") {
    start(msg.url, msg.argv);
  }
};

// ------------------------------------------------------------------- start

async function start(url, argv) {
  const go = new Go();
  go.argv = argv;
  go.env = { TERM: "xterm-256color" };
  let exitCode = 0;
  go.exit = (code) => { exitCode = code; };
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(url + ": HTTP " + res.status);
    const { instance } = await WebAssembly.instantiateStreaming(res, go.importObject);
    postMessage({ type: "started" });
    await go.run(instance);
    postMessage({ type: "exit", code: exitCode });
  } catch (err) {
    postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
  }
}
