// Headless browser smoke test: serves web/public, then plays a little of each
// game in Chromium and checks what lands in the terminal.
//
//   bash web/build.sh && node web/smoke.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("./public/", import.meta.url));
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".wasm": "application/wasm",
};

const server = createServer(async (req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (path.endsWith("/")) path += "index.html";
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

// Whole terminal buffer (scrollback included) as plain text.
const screen = () => page.evaluate(() => {
  const buf = window.term.buffer.active;
  const lines = [];
  for (let y = 0; y < buf.length; y++) lines.push(buf.getLine(y).translateToString(true));
  return lines.join("\n");
});

async function waitFor(what, test, timeout = 15000) {
  const end = Date.now() + timeout;
  let text = "";
  while (Date.now() < end) {
    text = await screen();
    if (test(text)) return text;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for ${what}. Terminal:\n${text}`);
}
const contains = (s) => (t) => t.includes(s);
const shot = (name) => page.screenshot({ path: fileURLToPath(new URL(`./smoke-${name}.png`, import.meta.url)) });
const type = (s) => page.keyboard.type(s, { delay: 20 });

let failed = false;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}\n${e.message}\n`);
  }
}

await page.goto(url);
await check("shell boots", () => waitFor("prompt", contains("guest@term-arcade")));

await check("tetris runs, moves, and quits", async () => {
  await page.click('nav button[data-cmd="tetris"]');
  await waitFor("score line", contains("Score: 0"));
  // Emoji must be two columns wide or the board falls apart: each board row
  // is wall + 10 cells + wall = 24 columns, the last cell is the wall "[]".
  const width = await page.evaluate(() => {
    const buf = window.term.buffer.active;
    for (let y = 0; y < buf.length; y++) {
      const s = buf.getLine(y).translateToString(true);
      if (s.startsWith("[][][]")) return s.length; // the floor
    }
    return -1;
  });
  if (width !== 24) throw new Error(`floor row is ${width} columns, expected 24`);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  await shot("tetris");
  await type("q");
  await waitFor("exit", contains("[tetris exited]"));
});

await check("wordle takes a guess", async () => {
  await type("wordle -mode player\r");
  await waitFor("banner", contains("-----------------------------------"));
  // The game rewrites each echoed guess in color, upper-cased. Three guesses
  // cover 15 different letters, so at least one is all but certain to score.
  for (const guess of ["crane", "split", "mouth"]) {
    await type(guess + "\r");
    await waitFor("scored " + guess, contains(guess.toUpperCase()));
  }
  const coloredCells = await page.evaluate(() => {
    const buf = window.term.buffer.active;
    let n = 0;
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      for (let x = 0; x < line.length; x++) if (!line.getCell(x).isBgDefault()) n++;
    }
    return n;
  });
  if (coloredCells === 0) throw new Error("no green/yellow tiles after three guesses");
  await shot("wordle");
  await type("zzzzz\r");
  await waitFor("rejection", contains("Not a valid word"));
  await page.keyboard.press("Control+C");
  await waitFor("stop", contains("[wordle stopped]"));
});

await check("connect4 plays a move", async () => {
  await page.click('nav button[data-cmd="connect4"]');
  await waitFor("board", contains(" 1  2  3  4  5  6  7  8"));
  await type("4\r");
  // Our red chip plus the computer's yellow reply.
  await waitFor("both moves", (t) => t.includes("🔴") && t.includes("🟡"));
  await shot("connect4");
});

await check("switching games stops the current one", async () => {
  await page.click('nav button[data-cmd="tetris"]');
  await waitFor("tetris", contains("Score: 0"));
  await type("q");
  await waitFor("exit", contains("[tetris exited]"));
});

await check("no page errors", async () => {
  if (errors.length) throw new Error(errors.join("\n"));
});

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
