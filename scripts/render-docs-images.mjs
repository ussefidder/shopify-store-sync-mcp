#!/usr/bin/env node
// Builds the README images from real server output.
//
//   npx tsx scripts/demo-data.ts > docs/demo-output.json
//   node scripts/render-docs-images.mjs            (needs Google Chrome or Chromium)
//
// Every number and label in demo.png comes from docs/demo-output.json.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = JSON.parse(readFileSync(join(root, "docs/demo-output.json"), "utf8"));
const chrome = process.env.CHROME ?? ["google-chrome", "chromium", "chromium-browser"].find((c) => {
  try {
    execFileSync("which", [c], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});
if (!chrome) throw new Error("Chrome or Chromium is required (or set CHROME=/path/to/chrome)");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0b0f14; }
  body { font-family: Inter, system-ui, sans-serif; color: #e6edf3; -webkit-font-smoothing: antialiased; }
  .mono { font-family: "DejaVu Sans Mono", ui-monospace, monospace; }
  .muted { color: #8b98a8; }
  .card { background: #11161d; border: 1px solid #222c38; border-radius: 14px; }
  .pill { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px;
          background: #16202b; border: 1px solid #263342; font-size: 14px; color: #c9d4df; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .g { color: #57c26e; } .a { color: #e3b341; } .r { color: #f47067; } .b { color: #6cb6ff; }
  .bg-g { background: #57c26e; } .bg-a { background: #e3b341; } .bg-r { background: #f47067; } .bg-b { background: #6cb6ff; }
`;

function render(name, width, height, body, css = "") {
  const dir = mkdtempSync(join(tmpdir(), "docimg-"));
  const html = join(dir, `${name}.html`);
  writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`);
  const png = join(root, "docs/images", `${name}.png`);
  execFileSync(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
    `--window-size=${width},${height}`, `--screenshot=${png}`, `file://${html}`,
  ], { stdio: "ignore" });
  console.log(`docs/images/${name}.png`);
}

// ---------------------------------------------------------------- hero
render("hero", 1280, 360, `
<div class="wrap">
  <div class="glow"></div>
  <div class="left">
    <div class="eyebrow mono">MCP SERVER · SHOPIFY ADMIN API</div>
    <h1>shopify-store-sync-mcp</h1>
    <p class="tag">Diff and sync configuration between Shopify stores, straight from your AI assistant.</p>
    <div class="pills">
      <span class="pill"><span class="dot bg-g"></span>Dry-run plans</span>
      <span class="pill"><span class="dot bg-b"></span>Cross-store ID remapping</span>
      <span class="pill"><span class="dot bg-a"></span>Drift-checked writes</span>
      <span class="pill"><span class="dot bg-r"></span>Never deletes</span>
    </div>
  </div>
  <div class="stores">
    <div class="store card"><div class="muted small">source</div><div class="sname">dev</div><div class="mono small muted">dev.myshopify.com</div></div>
    <div class="arrow"><div class="line"></div><div class="mono small">plan → apply</div></div>
    <div class="store card prot"><div class="muted small">target · protected</div><div class="sname">eu</div><div class="mono small muted">eu.myshopify.com</div></div>
  </div>
</div>`, `
  .wrap { position: relative; width: 1280px; height: 360px; padding: 56px 64px; display: flex; align-items: center; gap: 48px; overflow: hidden;
          background: radial-gradient(1200px 400px at 0% 0%, #13202a 0%, #0b0f14 60%); }
  .glow { position: absolute; right: -120px; top: -160px; width: 520px; height: 520px; border-radius: 50%;
          background: radial-gradient(circle, rgba(87,194,110,.18), transparent 65%); }
  .left { flex: 1; position: relative; }
  .eyebrow { font-size: 13px; letter-spacing: .12em; color: #57c26e; margin-bottom: 14px; }
  h1 { font-size: 52px; font-weight: 800; letter-spacing: -0.02em; }
  .tag { margin-top: 12px; font-size: 21px; color: #b5c2cf; max-width: 640px; line-height: 1.4; }
  .pills { margin-top: 26px; display: flex; flex-wrap: wrap; gap: 10px; }
  .stores { position: relative; display: flex; flex-direction: column; align-items: center; gap: 10px; width: 300px; }
  .store { width: 300px; padding: 16px 20px; }
  .store.prot { border-color: #3a2a2a; }
  .sname { font-size: 26px; font-weight: 700; margin: 2px 0 2px; }
  .small { font-size: 13px; }
  .arrow { display: flex; align-items: center; gap: 12px; color: #57c26e; height: 34px; }
  .line { width: 2px; height: 34px; background: linear-gradient(#57c26e, #2a6b3a); }
`);

// ---------------------------------------------------------------- demo (real output)
const LABEL = {
  metafield_definitions: "Metafield definitions",
  metaobject_definitions: "Metaobject definitions",
  pages: "Pages",
  metaobjects: "Metaobjects",
  menus: "Menus",
  redirects: "Redirects",
};
const diffRows = out.diff.resources
  .map((r) => `<tr><td>${LABEL[r.kind]}</td>
    <td class="num ${r.counts.onlyInSource ? "g" : "muted"}">${r.counts.onlyInSource}</td>
    <td class="num ${r.counts.changed ? "a" : "muted"}">${r.counts.changed}</td>
    <td class="num ${r.counts.onlyInTarget ? "b" : "muted"}">${r.counts.onlyInTarget}</td></tr>`)
  .join("");

const ICON = { create: ["+", "g"], update: ["~", "a"], conflict: ["!", "r"] };
const opRows = out.plan.ops
  .map((o) => {
    const [sym, cls] = ICON[o.action];
    const detail =
      o.action === "conflict"
        ? `<span class="r">type differs, skipped</span>`
        : o.changes?.length
          ? `<span class="muted">${o.changes.map((c) => esc(c.path)).join(", ")}</span>`
          : "";
    return `<div class="op"><span class="sym ${cls}">${sym}</span><span class="kind muted">${esc(o.kind.replace(/_/g, " "))}</span><span class="key mono">${esc(o.key)}</span>${detail}</div>`;
  })
  .join("");

const t = out.applied.totals;
render("demo", 1280, 700, `
<div class="wrap">
  <div class="chat">
    <div class="msg user">Compare <b>dev</b> with <b>eu</b>, plan a sync and apply it.</div>

    <div class="tool card">
      <div class="th"><span class="mono b">diff_stores</span><span class="muted mono">source: dev → target: eu</span></div>
      <table>
        <thead><tr><th></th><th>only in dev</th><th>changed</th><th>only in eu</th></tr></thead>
        <tbody>${diffRows}</tbody>
      </table>
    </div>

    <div class="tool card">
      <div class="th"><span class="mono b">plan_sync</span><span class="muted mono">nothing written yet</span>
        <span class="tot"><span class="g">${out.plan.totals.create} create</span> · <span class="a">${out.plan.totals.update} update</span> · <span class="r">${out.plan.totals.conflict} conflict</span></span></div>
      <div class="ops">${opRows}</div>
    </div>
  </div>

  <div class="side">
    <div class="tool card">
      <div class="th"><span class="mono b">apply_plan</span></div>
      <div class="refused"><span class="r">✕</span> ${esc(out.refused.error.replace(/^Refused: /, ""))}</div>
    </div>
    <div class="tool card">
      <div class="th"><span class="mono b">apply_plan</span><span class="muted mono">confirm: eu.myshopify.com</span></div>
      <div class="stats">
        <div><div class="big g">${t.created}</div><div class="muted">created</div></div>
        <div><div class="big a">${t.updated}</div><div class="muted">updated</div></div>
        <div><div class="big muted">${t.skipped}</div><div class="muted">skipped</div></div>
        <div><div class="big ${t.failed ? "r" : "muted"}">${t.failed}</div><div class="muted">failed</div></div>
      </div>
    </div>
    <div class="tool card">
      <div class="th"><span class="mono b">menu links after sync</span></div>
      ${out.menuAfter.map(([title, id]) => `<div class="remap"><span>${esc(title)}</span><span class="mono g">${esc(id.replace("gid://shopify/", ""))}</span></div>`).join("")}
      <div class="muted note">Remapped to eu's own IDs by handle.</div>
    </div>
    <div class="tool card">
      <div class="th"><span class="mono b">plan_sync</span><span class="muted mono">run again</span></div>
      <div class="again"><span class="g">${out.replan.create} create</span> · <span class="g">${out.replan.update} update</span> · <span class="r">${out.replan.conflict} conflict</span></div>
      <div class="muted note">Already in sync. The conflict stays reported until fixed by hand.</div>
    </div>
  </div>
</div>
<div class="foot muted">Real output of the server's tools on two sample stores (scripts/demo-data.ts).</div>`, `
  .wrap { display: flex; gap: 22px; padding: 32px 32px 12px; width: 1280px; }
  .chat { flex: 1.45; display: flex; flex-direction: column; gap: 14px; }
  .side { flex: 1; display: flex; flex-direction: column; gap: 14px; padding-top: 58px; }
  .msg.user { align-self: flex-end; background: #1f2a37; border: 1px solid #2c3a4b; padding: 11px 16px; border-radius: 14px 14px 4px 14px; font-size: 15px; }
  .tool { padding: 14px 16px; }
  .th { display: flex; gap: 12px; align-items: baseline; font-size: 13px; margin-bottom: 10px; }
  .th .tot { margin-left: auto; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: right; font-weight: 500; color: #8b98a8; font-size: 12px; padding: 0 6px 6px; }
  td { padding: 5px 6px; border-top: 1px solid #1c2530; }
  td.num { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; width: 110px; }
  .ops { display: flex; flex-direction: column; gap: 3px; font-size: 13.5px; }
  .op { display: grid; grid-template-columns: 22px 170px 220px 1fr; align-items: center; padding: 4px 6px; border-radius: 6px; }
  .op:nth-child(odd) { background: #0e1319; }
  .sym { font-weight: 800; font-family: "DejaVu Sans Mono", monospace; }
  .kind { font-size: 12.5px; }
  .key { font-size: 12.5px; }
  .refused { font-size: 13.5px; line-height: 1.45; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); text-align: center; font-size: 12.5px; }
  .big { font-size: 30px; font-weight: 800; }
  .remap { display: flex; justify-content: space-between; font-size: 13.5px; padding: 3px 0; }
  .note { font-size: 12px; margin-top: 6px; }
  .again { font-size: 15px; font-weight: 600; }
  .foot { padding: 0 32px 24px; font-size: 12px; text-align: right; }
`);

// ---------------------------------------------------------------- how it works
const step = (n, title, text, cls) =>
  `<div class="step card"><div class="n ${cls}">${n}</div><div class="st">${title}</div><div class="sd muted">${text}</div></div>`;
render("how-it-works", 1280, 370, `
<div class="wrap">
  <div class="row">
    <div class="store card"><div class="muted small">source store</div><div class="sname">dev</div></div>
    <div class="arr">→</div>
    ${step(1, "Snapshot", "Reads both stores and swaps every ID for a portable ref:<br><span class='mono b nw'>shopify://Product/shirt</span>", "b")}
    <div class="arr">→</div>
    ${step(2, "Diff", "Field by field: only in source, changed, only in target.", "b")}
    <div class="arr">→</div>
    ${step(3, "Plan", "Dry run: creates, updates, conflicts and missing references. Nothing written.", "a")}
    <div class="arr">→</div>
    ${step(4, "Apply", "Resolves refs to the target's own IDs and writes in dependency order.", "g")}
    <div class="arr">→</div>
    <div class="store card"><div class="muted small">target store</div><div class="sname">eu</div></div>
  </div>
  <div class="gates">
    <div class="gt mono muted">safety</div>
    <div class="gate card"><span class="dot bg-g"></span>Writes off unless <span class="mono">allowWrites</span></div>
    <div class="gate card"><span class="dot bg-a"></span>Protected stores need typed confirmation</div>
    <div class="gate card"><span class="dot bg-b"></span>Drifted items skipped</div>
    <div class="gate card"><span class="dot bg-r"></span>Never deletes</div>
    <div class="gate card"><span class="dot" style="background:#a371f7"></span>Audit log</div>
  </div>
</div>`, `
  .wrap { width: 1280px; height: 370px; padding: 36px 36px; background: radial-gradient(900px 300px at 50% 0%, #121b24, #0b0f14 70%); }
  .row { display: flex; align-items: center; gap: 10px; }
  .store { width: 110px; padding: 18px 14px; text-align: center; }
  .sname { font-size: 22px; font-weight: 800; margin-top: 4px; }
  .small { font-size: 12px; }
  .arr { color: #4a5868; font-size: 22px; }
  .step { flex: 1; padding: 18px 16px; min-height: 180px; }
  .n { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-weight: 800; background: #16202b; border: 1px solid #263342; margin-bottom: 12px; }
  .st { font-size: 19px; font-weight: 700; margin-bottom: 8px; }
  .sd { font-size: 14px; line-height: 1.5; }
  .gates { margin-top: 28px; display: flex; gap: 8px; align-items: center; flex-wrap: nowrap; }
  .nw { white-space: nowrap; }
  .gt { font-size: 12px; letter-spacing: .08em; margin-right: 6px; }
  .gate { display: flex; align-items: center; gap: 8px; padding: 9px 12px; font-size: 12.5px; white-space: nowrap; }
`);

// ---------------------------------------------------------------- field-level diff (real output)
const changed = Object.fromEntries(
  out.diff.resources.flatMap((r) => r.changed.map((c) => [`${r.kind}:${c.key}`, c.changes])),
);
const ch = (k) => changed[k] ?? [];
const name = ch("metafield_definitions:PRODUCT.custom.care_guide")[0];
const type = ch("metafield_definitions:PRODUCT.custom.size_chart")[0];
const body = ch("pages:shipping")[0];
const menu = ch("menus:main-menu")[0];
const menuLines = (() => {
  const t = new Set(menu.target.map((i) => i.title));
  return menu.source.map((i) => `<div class="ln ${t.has(i.title) ? "" : "add"}"><span class="sg">${t.has(i.title) ? " " : "+"}</span>${esc(i.title)} <span class="ref">${esc(i.resourceId ?? i.url ?? "")}</span></div>`).join("");
})();
const dline = (sign, cls, text) => `<div class="ln ${cls}"><span class="sg">${sign}</span>${esc(text)}</div>`;
const dcard = (title, kind, path, inner, badge = "") =>
  `<div class="dc card"><div class="dh"><span class="mono">${esc(title)}</span><span class="muted">${esc(kind)}</span><span class="path mono">${esc(path)}</span>${badge}</div><div class="code mono">${inner}</div></div>`;
render("field-diff", 1280, 352, `
<div class="wrap">
  <div class="hd"><span class="mono b">diff_stores</span><span class="muted">field by field · <span class="r">−</span> eu (target) · <span class="g">+</span> dev (source)</span></div>
  <div class="grid">
    ${dcard("shipping", "page", "body", dline("−", "del", body.target) + dline("+", "add", body.source))}
    ${dcard("main-menu", "menu", "items", menuLines)}
    ${dcard("PRODUCT.custom.care_guide", "definition", "name", dline("−", "del", name.target) + dline("+", "add", name.source))}
    ${dcard("PRODUCT.custom.size_chart", "definition", "type", dline("−", "del", type.target) + dline("+", "add", type.source), '<span class="badge">conflict, not forced</span>')}
  </div>
</div>`, `
  .wrap { width: 1280px; padding: 30px 32px; }
  .hd { display: flex; gap: 14px; align-items: baseline; font-size: 14px; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .dc { padding: 14px 16px; }
  .dh { display: flex; gap: 10px; align-items: baseline; font-size: 13.5px; margin-bottom: 10px; white-space: nowrap; }
  .dh .path { margin-left: auto; color: #8b98a8; font-size: 12px; background: #16202b; padding: 2px 8px; border-radius: 6px; }
  .badge { white-space: nowrap; font-size: 11.5px; color: #f47067; border: 1px solid #5a2a2a; border-radius: 999px; padding: 2px 8px; }
  .code { font-size: 13px; border-radius: 8px; overflow: hidden; border: 1px solid #1c2530; }
  .ln { padding: 7px 10px; white-space: pre-wrap; word-break: break-word; }
  .ln + .ln { border-top: 1px solid #161e27; }
  .del { background: rgba(244,112,103,.10); color: #f6a39d; }
  .add { background: rgba(87,194,110,.10); color: #8fdc9f; }
  .sg { display: inline-block; width: 18px; opacity: .8; }
  .ref { color: #6cb6ff; font-size: 12px; margin-left: 6px; }
`);

// ---------------------------------------------------------------- remapping trace (real output)
const traceRow = (t) => `
  <div class="tr">
    <div class="what">${esc(t.what)}</div>
    <div class="cells">
      <div class="cell card"><div class="lab muted">in dev</div><div class="mono v">${esc(t.source)}</div></div>
      <div class="ar">→</div>
      <div class="cell card port"><div class="lab b">portable, compared and planned</div><div class="mono v b">${esc(t.portable)}</div></div>
      <div class="ar">→</div>
      <div class="cell card"><div class="lab muted">written to eu</div><div class="mono v g">${esc(t.target)}</div></div>
    </div>
  </div>`;
render("remapping", 1280, 300, `
<div class="wrap">
  <div class="hd"><span class="b mono">ID remapping</span><span class="muted">every ID is store-specific, so references travel by handle</span></div>
  ${out.trace.map(traceRow).join("")}
</div>`, `
  .wrap { width: 1280px; padding: 30px 32px; }
  .hd { display: flex; gap: 14px; align-items: baseline; font-size: 14px; margin-bottom: 18px; }
  .tr { margin-bottom: 20px; }
  .what { font-size: 14px; color: #c9d4df; margin-bottom: 8px; }
  .cells { display: flex; align-items: center; gap: 12px; }
  .cell { flex: 1; padding: 14px 16px; }
  .cell.port { border-color: #24425e; background: #101b26; }
  .lab { font-size: 11.5px; letter-spacing: .04em; margin-bottom: 6px; }
  .v { font-size: 14.5px; }
  .ar { color: #4a5868; font-size: 22px; }
`);

// ---------------------------------------------------------------- social preview (GitHub: 1280x640)
render("social-preview", 1280, 640, `
<div class="wrap">
  <div class="glow"></div>
  <div class="eyebrow mono">OPEN SOURCE · MCP SERVER</div>
  <h1>shopify-store-sync-mcp</h1>
  <p class="tag">Diff and sync configuration between Shopify stores from Claude, Cursor or any MCP client.</p>
  <div class="row">
    <div class="pill"><span class="dot bg-g"></span>Metafield &amp; metaobject definitions</div>
    <div class="pill"><span class="dot bg-g"></span>Metaobjects</div>
    <div class="pill"><span class="dot bg-g"></span>Pages · Menus · Redirects</div>
  </div>
  <div class="row">
    <div class="pill"><span class="dot bg-b"></span>Field-level diffs</div>
    <div class="pill"><span class="dot bg-a"></span>Dry-run plans</div>
    <div class="pill"><span class="dot bg-b"></span>ID remapping by handle</div>
    <div class="pill"><span class="dot bg-r"></span>Never deletes</div>
  </div>
  <div class="foot mono muted">github.com/ussefidder/shopify-store-sync-mcp · MIT</div>
</div>`, `
  .wrap { position: relative; width: 1280px; height: 640px; padding: 88px 96px; overflow: hidden;
          background: radial-gradient(1000px 500px at 0% 0%, #13202a 0%, #0b0f14 60%); }
  .glow { position: absolute; right: -160px; bottom: -200px; width: 700px; height: 700px; border-radius: 50%;
          background: radial-gradient(circle, rgba(87,194,110,.16), transparent 65%); }
  .eyebrow { font-size: 16px; letter-spacing: .14em; color: #57c26e; margin-bottom: 18px; }
  h1 { font-size: 76px; font-weight: 800; letter-spacing: -0.025em; }
  .tag { margin-top: 18px; font-size: 28px; color: #b5c2cf; max-width: 960px; line-height: 1.35; }
  .row { margin-top: 22px; display: flex; gap: 12px; flex-wrap: wrap; }
  .row + .row { margin-top: 12px; }
  .pill { font-size: 18px; padding: 9px 16px; }
  .foot { position: absolute; bottom: 52px; left: 96px; font-size: 16px; }
`);

// ---------------------------------------------------------------- CLI (real output of scripts/demo-cli.ts)
const cli = JSON.parse(readFileSync(join(root, "docs/demo-cli.json"), "utf8"));
const colorLine = (line) => {
  const l = esc(line);
  if (/^\s+(\d+ )?\+ /.test(line)) return `<span class="g">${l}</span>`;
  if (/^\s+(\d+ )?~ /.test(line)) return `<span class="a">${l}</span>`;
  if (/^\s+(\d+ )?! /.test(line)) return `<span class="r">${l}</span>`;
  if (/^(Plan|Themes) /.test(line)) return `<b>${l}</b>`;
  if (/^Nothing written|identical$/.test(line)) return `<span class="muted">${l}</span>`;
  return l;
};
const block = (c) => `<div class="cmd"><span class="ps">$</span> ${esc(c.cmd)}</div><pre>${c.output.split("\n").map(colorLine).join("\n")}</pre>`;
render("cli", 1280, 860, `
<div class="wrap"><div class="term card">
  <div class="bar"><span class="d" style="background:#f47067"></span><span class="d" style="background:#e3b341"></span><span class="d" style="background:#57c26e"></span><span class="title mono muted">terminal</span></div>
  <div class="body mono">${block(cli.diff)}${block(cli.plan)}${block(cli.themes)}</div>
</div>
<div class="foot muted">Real output of the CLI on two sample stores (scripts/demo-cli.ts). No AI client needed.</div></div>`, `
  .wrap { width: 1280px; padding: 28px 32px 16px; }
  .term { overflow: hidden; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #1c2530; background: #0e1319; }
  .d { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .bar .title { margin-left: 10px; font-size: 12px; }
  .body { padding: 18px 22px; font-size: 13.5px; line-height: 1.55; }
  .cmd { color: #e6edf3; margin-top: 6px; }
  .ps { color: #57c26e; }
  pre { font-family: inherit; color: #c9d4df; margin: 4px 0 16px; white-space: pre; }
  .foot { font-size: 12px; text-align: right; padding-top: 10px; }
`);

// ---------------------------------------------------------------- config as code (real export)
const groups = {};
for (const f of cli.tree) {
  const [dir, file] = f.includes("/") ? f.split("/") : ["", f];
  (groups[dir] ??= []).push(file);
}
const treeHtml = Object.entries(groups)
  .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
  .map(([dir, files]) =>
    dir
      ? `<div class="dir">▾ ${esc(dir)}/</div>${files.map((f) => `<div class="file${f === "fr_Page_shipping.json" ? " sel" : ""}">${esc(f)}</div>`).join("")}`
      : files.map((f) => `<div class="file root">${esc(f)}</div>`).join(""),
  )
  .join("");
render("config-as-code", 1280, 490, `
<div class="wrap">
  <div class="hd mono"><span class="ps">$</span> ${esc(cli.export.cmd)}</div>
  <div class="cols">
    <div class="tree card mono"><div class="muted lab">store-config/</div>${treeHtml}</div>
    <div class="file-view card">
      <div class="fh mono"><span>translations/fr_Page_shipping.json</span><span class="muted">sorted keys · no store IDs · diff-friendly</span></div>
      <pre class="mono">${esc(cli.sample)}</pre>
    </div>
  </div>
  <div class="notes">
    <span class="pill"><span class="dot bg-g"></span>Commit it to git</span>
    <span class="pill"><span class="dot bg-a"></span>Review store changes in a pull request</span>
    <span class="pill"><span class="dot bg-b"></span>diff dir:./store-config prod to spot drift</span>
    <span class="pill"><span class="dot bg-r"></span>plan dir:./store-config prod to restore</span>
  </div>
</div>`, `
  .wrap { width: 1280px; padding: 26px 32px; }
  .hd { font-size: 14px; margin-bottom: 14px; color: #e6edf3; }
  .ps { color: #57c26e; }
  .cols { display: grid; grid-template-columns: 330px 1fr; gap: 14px; }
  .tree { padding: 14px 16px; font-size: 13px; line-height: 1.75; }
  .lab { margin-bottom: 4px; }
  .dir { color: #c9d4df; }
  .file { padding-left: 18px; color: #8b98a8; }
  .file.root { padding-left: 0; color: #c9d4df; }
  .file.sel { color: #6cb6ff; background: #101b26; border-radius: 4px; }
  .file-view { overflow: hidden; }
  .fh { display: flex; justify-content: space-between; padding: 10px 16px; font-size: 12.5px; border-bottom: 1px solid #1c2530; background: #0e1319; }
  .file-view pre { padding: 14px 16px; font-size: 13px; line-height: 1.6; color: #c9d4df; white-space: pre-wrap; }
  .notes { margin-top: 16px; display: flex; gap: 10px; flex-wrap: wrap; }
`);

// ---------------------------------------------------------------- connect without an app
// Output of `connect` as printed on a live store (Windows, Shopify CLI 4.9.4); store and email made generic.
const connectLines = [
  ["$", "npx shopify-store-sync-mcp connect my-staging-store --writes"],
  ["", "Opening Shopify in your browser to approve access to my-staging-store.myshopify.com (read and write)..."],
  ["", "Shopify CLI will open the app authorization page in your browser."],
  ["g", "✔ Logged in."],
  ["g", "✔ Authenticated as you@example.com against my-staging-store.myshopify.com."],
  ["g", "Connected to My Staging Store (my-staging-store.myshopify.com)."],
  ["", ""],
  ["", "Add it to stores.json:"],
  ["b", '  "my-staging-store": { "domain": "my-staging-store.myshopify.com", "auth": "shopify-cli", "allowWrites": true }'],
];
const opt = (title, tag, cls, rows) => `<div class="opt card"><div class="ot"><span class="b2">${title}</span><span class="tag ${cls}">${tag}</span></div>${rows.map(([k, v]) => `<div class="row"><span class="muted">${k}</span><span>${v}</span></div>`).join("")}</div>`;
render("connect", 1280, 500, `
<div class="wrap">
  <div class="hd"><span class="b2">Connect a store in one click, no app to create</span><span class="muted">uses Shopify CLI's own sign-in</span></div>
  <div class="term card mono">
    ${connectLines.map(([c, t]) => (c === "$" ? `<div><span class="g">$</span> ${esc(t)}</div>` : `<div class="${c}">${esc(t) || "&nbsp;"}</div>`)).join("")}
  </div>
  <div class="opts">
    ${opt("Shopify CLI sign-in", "no app", "bg-g", [["Setup", "<span class='mono'>connect</span>, click Install"], ["Works on", "any store you can approve apps on"], ["Speed", "a full diff in tens of seconds"], ["Best for", "working at your keyboard"]])}
    ${opt("Dev Dashboard app", "client ID + secret", "bg-b", [["Setup", "create one app, install per store"], ["Works on", "stores in your own organization"], ["Speed", "a full diff in about 2 seconds"], ["Best for", "scheduled and unattended runs"]])}
    ${opt("Custom app token", "shpat_...", "bg-a", [["Setup", "store owner creates it and shares the token"], ["Works on", "any store whose owner shares a token"], ["Speed", "a full diff in about 2 seconds"], ["Best for", "automation on a client's store"]])}
  </div>
</div>`, `
  .wrap { width: 1280px; padding: 26px 32px; }
  .hd { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; font-size: 15px; }
  .b2 { font-weight: 700; }
  .term { padding: 16px 20px; font-size: 13.5px; line-height: 1.65; color: #c9d4df; }
  .term div { white-space: pre; }
  .opts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 16px; }
  .opt { padding: 14px 16px; font-size: 13.5px; }
  .ot { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .tag { font-size: 11.5px; color: #0b0f14; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
  .row { display: grid; grid-template-columns: 78px 1fr; gap: 8px; padding: 4px 0; border-top: 1px solid #1c2530; }
`);

// ---------------------------------------------------------------- Shopify CLI alone vs this tool
render("vs-shopify-cli", 1280, 362, `
<div class="wrap">
  <div class="cols">
    <div class="col card">
      <div class="ch"><span class="b2">Shopify CLI alone</span><span class="muted">one raw query, one store</span></div>
      <pre class="mono">$ shopify store execute --store dev.myshopify.com \\
    --query 'query { metaobjects(type: "size_guide", first: 50) { nodes { id handle fields { key value } } } }'
$ shopify store execute --store prod.myshopify.com --query '...'
<span class="muted"># now compare the two JSON blobs by hand</span>
<span class="muted"># find gid://shopify/Product/101 in dev, look up its handle,</span>
<span class="muted"># find that handle's ID in prod, rewrite every reference</span>
$ shopify store execute --store prod.myshopify.com --allow-mutations \\
    --query 'mutation { metaobjectCreate(...) }'
<span class="muted"># repeat for each definition, entry, page, menu, redirect...</span>
<span class="r"># no plan, no drift check, no record of what changed</span></pre>
    </div>
    <div class="col card">
      <div class="ch"><span class="b2">shopify-store-sync-mcp</span><span class="muted">uses that same sign-in</span></div>
      <pre class="mono"><span class="muted">You:</span> Compare dev with prod and sync the size guides.

<span class="g">diff_stores</span>  field-level differences, both stores
<span class="g">plan_sync</span>    dry-run plan you review first
<span class="g">apply_plan</span>   writes in dependency order:
             definitions before entries,
             two passes for self-references
             IDs remapped by handle
             images uploaded when missing
             target re-read, drifted items skipped
             never deletes, every write logged</pre>
    </div>
  </div>
</div>`, `
  .wrap { width: 1280px; padding: 26px 32px; }
  .cols { display: grid; grid-template-columns: 1.25fr 1fr; gap: 16px; }
  .col { overflow: hidden; }
  .ch { display: flex; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #1c2530; background: #0e1319; font-size: 14px; }
  .b2 { font-weight: 700; }
  pre { padding: 16px; font-size: 13px; line-height: 1.65; color: #c9d4df; white-space: pre-wrap; }
`);
