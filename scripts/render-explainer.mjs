#!/usr/bin/env node
// Builds the one-minute "install it and use it" explainer:
//
//   docs/explainer.mp4          1920x1080, H.264 (LinkedIn, Reddit, or drag into a GitHub page)
//   docs/images/explainer.gif   960x540 (plays inline in the README on GitHub and on npm)
//
//   npx tsx scripts/demo-cli.ts > docs/demo-cli.json
//   node scripts/render-explainer.mjs          (needs Google Chrome or Chromium, and ffmpeg)
//
// Every command output in it is the real output of the CLI on two sample stores (docs/demo-cli.json).
// The video is a list of still frames, each shown for a set time; typing is a run of short frames.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const cli = JSON.parse(readFileSync(join(root, "docs/demo-cli.json"), "utf8")).quick;
const has = (c) => {
  try {
    execFileSync("which", [c], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const chrome = process.env.CHROME ?? ["google-chrome", "chromium", "chromium-browser"].find(has);
if (!chrome) throw new Error("Chrome or Chromium is required (or set CHROME=/path/to/chrome)");
if (!has("ffmpeg")) throw new Error("ffmpeg is required");

const W = 1280;
const H = 720;
const REPO = "github.com/ussefidder/shopify-store-sync-mcp";
const BIN = "npx shopify-store-sync-mcp";
const DEV = "my-brand-dev";
const EU = "my-brand-eu";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0b0f14; width: ${W}px; height: ${H}px; overflow: hidden; }
  body { font-family: Inter, system-ui, sans-serif; color: #e6edf3; -webkit-font-smoothing: antialiased; }
  .mono { font-family: "DejaVu Sans Mono", ui-monospace, monospace; }
  .muted { color: #8b98a8; }
  .g { color: #57c26e; } .a { color: #e3b341; } .r { color: #f47067; } .b { color: #6cb6ff; }
  .wrap { position: relative; width: ${W}px; height: ${H}px; padding: 34px 44px 0;
          background: radial-gradient(1000px 520px at 0% 0%, #13202a 0%, #0b0f14 62%); }
  .head { display: flex; align-items: center; gap: 18px; height: 74px; }
  .num { width: 46px; height: 46px; border-radius: 50%; background: #57c26e; color: #0b0f14; font-weight: 800; font-size: 22px;
         display: flex; align-items: center; justify-content: center; flex: none; }
  .head h2 { font-size: 30px; font-weight: 800; letter-spacing: -0.02em; }
  .head p { font-size: 17.5px; color: #aab6c4; margin-top: 3px; }
  .panel { margin-top: 16px; height: 520px; background: #0e1319; border: 1px solid #222c38; border-radius: 14px; overflow: hidden; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #1c2530; background: #0c1116; }
  .d { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .bar .t { margin-left: 10px; font-size: 13px; color: #8b98a8; }
  .body { padding: 18px 22px; font-size: 17px; line-height: 1.52; white-space: pre-wrap; color: #c9d4df; }
  .body.small { font-size: 15px; line-height: 1.5; }
  .ps { color: #57c26e; }
  .cmd { color: #e6edf3; }
  .cur { display: inline-block; width: 10px; height: 20px; background: #e6edf3; vertical-align: -3px; margin-left: 2px; }
  .foot { position: absolute; left: 44px; right: 44px; bottom: 16px; display: flex; align-items: center; gap: 16px; font-size: 13px; color: #6b7785; }
  .track { flex: 1; height: 4px; border-radius: 2px; background: #1a222c; overflow: hidden; }
  .fill { height: 100%; background: #57c26e; }
  .key { color: #6cb6ff; } .str { color: #a5d6a7; } .bool { color: #e3b341; }
  .note { position: absolute; right: 60px; font-size: 15px; color: #0b0f14; font-weight: 700; padding: 6px 12px; border-radius: 8px; }
  .split { display: grid; grid-template-columns: 1fr 1.15fr; gap: 16px; margin-top: 16px; height: 520px; }
  .split .panel { margin-top: 0; height: 520px; }
  .chat { padding: 20px 22px; display: flex; flex-direction: column; gap: 12px; }
  .bubble { align-self: flex-end; max-width: 86%; background: #1b2a3a; border: 1px solid #2a4058; border-radius: 16px 16px 4px 16px; padding: 12px 16px; font-size: 18px; line-height: 1.45; }
  .tool { background: #11161d; border: 1px solid #222c38; border-radius: 10px; padding: 10px 14px; font-size: 15.5px; display: flex; justify-content: space-between; gap: 12px; }
  .ask { background: #2a2413; border: 1px solid #5a4a17; border-radius: 10px; padding: 10px 14px; font-size: 15.5px; color: #f0d98a; line-height: 1.45; }
  .center { height: 100%; display: flex; flex-direction: column; justify-content: center; padding: 0 40px 60px; }
  .eyebrow { font-size: 16px; letter-spacing: .14em; color: #57c26e; margin-bottom: 18px; }
  h1 { font-size: 70px; font-weight: 800; letter-spacing: -0.025em; line-height: 1.05; }
  .tag { margin-top: 20px; font-size: 28px; color: #b5c2cf; line-height: 1.35; max-width: 1000px; }
  .chips { margin-top: 28px; display: flex; gap: 12px; flex-wrap: wrap; }
  .pill { display: inline-flex; align-items: center; gap: 9px; padding: 9px 16px; border-radius: 999px; background: #16202b; border: 1px solid #263342; font-size: 18px; color: #c9d4df; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .big { margin-top: 30px; display: inline-block; background: #0d1319; border: 1px solid #222c38; border-radius: 12px; padding: 14px 20px; font-size: 24px; }
`;

/** One still frame: `html` is the page body, `ms` how long it stays on screen. */
const frames = [];
const push = (html, ms) => frames.push({ html, ms });

const footer = (progress) =>
  `<div class="foot"><span class="mono">${REPO}</span><div class="track"><div class="fill" style="width:${Math.round(progress * 100)}%"></div></div><span>MIT</span></div>`;
const header = (n, title, caption) => `<div class="head"><div class="num">${n}</div><div><h2>${esc(title)}</h2><p>${caption}</p></div></div>`;
const bar = (title) =>
  `<div class="bar"><span class="d" style="background:#f47067"></span><span class="d" style="background:#e3b341"></span><span class="d" style="background:#57c26e"></span><span class="t mono">${title}</span></div>`;

const colorLine = (line) => {
  const l = esc(line);
  if (/^\s+(\d+ )?\+ /.test(line) || /^✓/.test(line)) return `<span class="g">${l}</span>`;
  if (/^\s+(\d+ )?~ /.test(line) || /^! /.test(line)) return `<span class="a">${l}</span>`;
  if (/^(Plan|applied|Connected) /.test(line)) return `<b style="color:#e6edf3">${l}</b>`;
  if (/^#/.test(line)) return `<span class="muted">${l}</span>`;
  return l;
};

/**
 * A terminal scene: each entry is a command that gets typed, then its output appears.
 * `done` lines stay on screen from the previous commands of the same scene.
 */
function terminal({ n, title, caption, steps, small = false, from, to }) {
  const total = steps.length;
  let shown = "";
  const page = (inner, p) =>
    `<div class="wrap">${header(n, title, caption)}<div class="panel">${bar("terminal")}<div class="body mono${small ? " small" : ""}">${inner}</div></div>${footer(p)}</div>`;
  steps.forEach((step, i) => {
    const at = (f) => from + ((i + f) / total) * (to - from);
    const prompt = `<span class="ps">$</span> `;
    for (let c = 0; c <= step.cmd.length; c += 3) {
      push(page(`${shown}${prompt}<span class="cmd">${esc(step.cmd.slice(0, c))}</span><span class="cur"></span>`, at(0.2)), c === 0 ? 450 : 55);
    }
    const typed = `${shown}${prompt}<span class="cmd">${esc(step.cmd)}</span>`;
    push(page(`${typed}<span class="cur"></span>`, at(0.3)), 350);
    const lines = step.output ? step.output.split("\n") : [];
    // Output arrives in a few bursts, like a real command.
    const bursts = Math.min(lines.length, step.bursts ?? 3);
    for (let b = 1; b <= bursts; b++) {
      const part = lines.slice(0, Math.ceil((lines.length * b) / bursts)).map(colorLine).join("\n");
      push(page(`${typed}\n${part}`, at(0.3 + (0.6 * b) / bursts)), b === bursts ? (step.hold ?? 2600) : (step.pause ?? 280));
    }
    if (!lines.length) push(page(typed, at(0.9)), step.hold ?? 1200);
    shown = `${typed}\n${lines.map(colorLine).join("\n")}${lines.length ? "\n\n" : "\n"}`;
  });
}

const chips = `
  <span class="pill"><span class="dot" style="background:#57c26e"></span>Read-only by default</span>
  <span class="pill"><span class="dot" style="background:#e3b341"></span>Dry-run plan first</span>
  <span class="pill"><span class="dot" style="background:#f47067"></span>Never deletes</span>
  <span class="pill"><span class="dot" style="background:#6cb6ff"></span>A person confirms production</span>`;

// ------------------------------------------------------------------ title
push(
  `<div class="wrap"><div class="center"><div class="eyebrow mono">OPEN SOURCE · MCP SERVER + CLI</div><h1>shopify-store-sync-mcp</h1>
   <p class="tag">Install it and sync two Shopify stores in about a minute.</p></div>${footer(0)}</div>`,
  2600,
);

// ------------------------------------------------------------------ 1. install
terminal({
  n: 1,
  title: "Install Shopify CLI",
  caption: "Once. It handles the sign-in, so there is no app to create.",
  from: 0.03,
  to: 0.1,
  steps: [{ cmd: "npm install -g @shopify/cli", output: "# needs Node 22 or newer", bursts: 1, hold: 1700 }],
});

// ------------------------------------------------------------------ 2. connect
// These are the messages `connect` prints (src/cli.ts); the store names are examples.
terminal({
  n: 2,
  title: "Connect your stores",
  caption: "Approve in the browser. Read-only unless you add <span class=\"mono\">--writes</span>.",
  from: 0.1,
  to: 0.3,
  steps: [
    {
      cmd: `${BIN} connect ${DEV}`,
      output: `Opening Shopify in your browser to approve access to ${DEV}.myshopify.com (read-only)...\nConnected to My Brand Dev (${DEV}.myshopify.com).`,
      bursts: 2,
      pause: 1100,
      hold: 1500,
    },
    {
      cmd: `${BIN} connect ${EU} --writes`,
      output: `Opening Shopify in your browser to approve access to ${EU}.myshopify.com (read and write)...\nConnected to My Brand EU (${EU}.myshopify.com).`,
      bursts: 2,
      pause: 1100,
      hold: 2200,
    },
  ],
});

// ------------------------------------------------------------------ 3. stores.json
{
  const k = (s) => `<span class="key">"${s}"</span>`;
  const v = (s) => `<span class="str">"${s}"</span>`;
  const t = `<span class="bool">true</span>`;
  const lines = [
    `{`,
    `  ${k("stores")}: {`,
    `    ${k("dev")}: { ${k("domain")}: ${v(`${DEV}.myshopify.com`)}, ${k("auth")}: ${v("shopify-cli")} },`,
    `    ${k("eu")}:  { ${k("domain")}: ${v(`${EU}.myshopify.com`)}, ${k("auth")}: ${v("shopify-cli")},`,
    `             ${k("allowWrites")}: ${t}, ${k("protected")}: ${t} }`,
    `  }`,
    `}`,
  ];
  const notes = [
    `<div class="note" style="top:284px;background:#57c26e">allowWrites: writing is off until you turn it on</div>`,
    `<div class="note" style="top:328px;background:#6cb6ff">protected: a person confirms every apply</div>`,
  ];
  const page = (count, noteCount, p) =>
    `<div class="wrap">${header(3, "Describe your stores", "One small file. No tokens in it: the sign-in stays with Shopify CLI.")}
     <div class="panel">${bar("stores.json")}<div class="body mono">${lines.slice(0, count).join("\n")}</div></div>${notes.slice(0, noteCount).join("")}${footer(p)}</div>`;
  for (let i = 1; i <= lines.length; i++) push(page(i, 0, 0.3 + 0.01 * i), i === lines.length ? 700 : 240);
  push(page(lines.length, 1, 0.38), 1600);
  push(page(lines.length, 2, 0.4), 2600);
}

// ------------------------------------------------------------------ 4. compare, plan, apply
const real = (c) => ({ cmd: `npx ${c.cmd}`, output: c.output });
terminal({
  n: 4,
  title: "Compare",
  caption: "Read-only. <span class=\"g\">+</span> is missing in eu, <span class=\"a\">~</span> is different, field by field.",
  from: 0.4,
  to: 0.52,
  steps: [{ ...real(cli.diff), hold: 3600 }],
});
terminal({
  n: 5,
  title: "Plan",
  caption: "A dry run. Nothing is written yet, and it tells you what would go live.",
  small: true,
  from: 0.52,
  to: 0.66,
  steps: [{ ...real(cli.plan), hold: 4400 }],
});
terminal({
  n: 6,
  title: "Apply",
  caption: "eu is protected, so you confirm with its domain. Nothing is ever deleted.",
  small: true,
  from: 0.66,
  to: 0.8,
  steps: [
    { ...real(cli.apply), bursts: 6, pause: 260, hold: 2400 },
    { ...real(cli.again), cmd: "npx shopify-store-sync-mcp diff dev eu --exit-code", bursts: 2, hold: 2600 },
  ],
});

// ------------------------------------------------------------------ 7. from an AI client
{
  const k = (s) => `<span class="key">"${s}"</span>`;
  const v = (s) => `<span class="str">"${s}"</span>`;
  const config = [
    `{`,
    `  ${k("mcpServers")}: {`,
    `    ${k("shopify-store-sync")}: {`,
    `      ${k("command")}: ${v("npx")},`,
    `      ${k("args")}: [${v("-y")}, ${v("shopify-store-sync-mcp")}]`,
    `    }`,
    `  }`,
    `}`,
  ].join("\n");
  const plan = /(\d+) create · (\d+) update · (\d+) conflict/.exec(cli.plan.output);
  const written = /(\d+) written/.exec(cli.apply.output)?.[1];
  const parts = [
    `<div class="bubble">Compare dev with eu, then sync what's missing.</div>`,
    `<div class="tool"><span class="mono b">diff_stores</span><span class="muted">read-only</span></div>`,
    `<div class="tool"><span class="mono b">plan_sync</span><span><span class="g">${plan[1]} create</span> · <span class="a">${plan[2]} update</span> · ${plan[3]} conflict</span></div>`,
    `<div class="ask">Your client asks <b>you</b>: type ${EU}.myshopify.com to confirm. The assistant can't answer for you.</div>`,
    `<div class="tool"><span class="mono b">apply_plan</span><span class="g">${written} written · 0 deleted</span></div>`,
  ];
  const page = (count, p) =>
    `<div class="wrap">${header(7, "Or just ask your AI assistant", "Add the server to Claude, Cursor or any MCP client. Same engine, same safety checks.")}
     <div class="split"><div class="panel">${bar("mcp config")}<div class="body mono small">${config}</div></div>
     <div class="panel">${bar("chat")}<div class="chat">${parts.slice(0, count).join("")}</div></div></div>${footer(p)}</div>`;
  push(page(0, 0.81), 1500);
  [1700, 1100, 1700, 2600, 2800].forEach((ms, i) => push(page(i + 1, 0.82 + 0.03 * i), ms));
}

// ------------------------------------------------------------------ end card
push(
  `<div class="wrap"><div class="center"><div class="eyebrow mono">FREE · MIT LICENSED</div><h1>Try it on a dev store.</h1>
   <div class="chips">${chips}</div><div class="big mono"><span class="g">$</span> npx shopify-store-sync-mcp connect my-store</div>
   <p class="tag mono" style="font-size:22px">${REPO}</p></div>${footer(1)}</div>`,
  4200,
);

// ------------------------------------------------------------------ render and encode
const dir = mkdtempSync(join(tmpdir(), "explainer-"));
const shoot = async (frame, i) => {
  const html = join(dir, `f${i}.html`);
  writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${frame.html}</body></html>`);
  frame.png = join(dir, `f${String(i).padStart(4, "0")}.png`);
  await run(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1.5",
    `--user-data-dir=${join(dir, `p${i}`)}`, `--window-size=${W},${H}`, `--screenshot=${frame.png}`, `file://${html}`,
  ]);
};
const queue = frames.map((f, i) => [f, i]);
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (queue.length) await shoot(...queue.shift());
  }),
);

const list = join(dir, "frames.txt");
writeFileSync(list, `${frames.map((f) => `file '${f.png}'\nduration ${(f.ms / 1000).toFixed(3)}`).join("\n")}\nfile '${frames.at(-1).png}'\n`);
const seconds = Math.round(frames.reduce((s, f) => s + f.ms, 0) / 1000);

const mp4 = join(root, "docs/explainer.mp4");
const gif = join(root, "docs/images/explainer.gif");
const input = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list];
execFileSync("ffmpeg", [...input, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", mp4]);
execFileSync("ffmpeg", [
  ...input,
  "-vf", "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
  "-loop", "0", gif,
]);
console.log(`${frames.length} frames, ${seconds}s\ndocs/explainer.mp4\ndocs/images/explainer.gif`);
