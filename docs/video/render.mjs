#!/usr/bin/env node
// Films page.html frame by frame and adds the voice-over.
//
//   python tts.py <kokoro.onnx> <voices.bin> build      voice.wav + timeline.json
//   node render.mjs build                                 ../explainer.mp4 and ../images/explainer.gif
//   node render.mjs build --stills 4.2,16.5               a few frames as JPEGs, to check before a full render
//
// page.html draws any moment on request (seek(t)), so each frame is exact and the result is repeatable.
// One file is encoded per scene, then the files are joined without re-encoding.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const here = new URL(".", import.meta.url).pathname;
const build = resolve(process.argv[2] ?? join(here, "build"));
const stillsAt = process.argv.includes("--stills") ? process.argv[process.argv.indexOf("--stills") + 1].split(",").map(Number) : null;
const FPS = 30;
const chrome = process.env.CHROME ?? "/usr/bin/google-chrome";

const data = {
  timeline: JSON.parse(readFileSync(join(build, "timeline.json"), "utf8")),
  cli: JSON.parse(readFileSync(join(here, "..", "demo-cli.json"), "utf8")).quick,
};

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--font-render-hinting=none"] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.goto(`file://${join(here, "page.html")}`);
const total = await page.evaluate((d) => window.setup(d), data);
const shot = async (t) => {
  await page.evaluate((x) => window.seek(x), t);
  return page.screenshot({ type: "jpeg", quality: 92 });
};

if (stillsAt) {
  mkdirSync(join(build, "stills"), { recursive: true });
  for (const t of stillsAt) {
    const file = join(build, "stills", `t${t.toFixed(1)}.jpg`);
    writeFileSync(file, await shot(t));
    console.log(file);
  }
  await browser.close();
  process.exit(0);
}

const ENCODE = ["-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-r", String(FPS)];
const parts = [];
let frame = 0;
for (const [i, scene] of data.timeline.scenes.entries()) {
  const last = Math.round((i === data.timeline.scenes.length - 1 ? total : scene.end) * FPS);
  const tmp = join(build, `scene${i}.part.mp4`);
  const done = join(build, `scene${i}.mp4`);
  const ffmpeg = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-", ...ENCODE, tmp], { stdio: ["pipe", "inherit", "inherit"] });
  const closed = new Promise((ok, fail) => ffmpeg.on("close", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited with ${code}`)))));
  const from = frame;
  for (; frame < last; frame++) {
    const jpg = await shot(frame / FPS);
    if (!ffmpeg.stdin.write(jpg)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
  }
  ffmpeg.stdin.end();
  await closed;
  renameSync(tmp, done);
  parts.push(done);
  console.log(`${scene.id}: frames ${from} to ${last - 1}`);
}
await browser.close();

const list = join(build, "scenes.txt");
writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
const silent = join(build, "silent.mp4");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent]);
const mp4 = join(here, "..", "explainer.mp4");
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", "-i", silent, "-i", join(build, "voice.wav"), "-map", "0:v", "-map", "1:a",
  "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", "-shortest", mp4,
]);
console.log(`${mp4} (${total.toFixed(1)}s)`);

// The README shows a short silent cut: the "ask" and "apply" scenes.
const ask = data.timeline.scenes.find((s) => s.id === "ask");
const apply = data.timeline.scenes.find((s) => s.id === "apply");
const gif = join(here, "..", "images", "explainer.gif");
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", "-ss", String(ask.start), "-t", String(apply.end - ask.start), "-i", mp4,
  "-vf", "fps=10,scale=840:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
  "-loop", "0", gif,
]);
console.log(gif);
