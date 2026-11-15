#!/usr/bin/env node
// Voice-over with ElevenLabs: one request per line of narration.json, so every line has an exact length.
//
//   ELEVENLABS_API_KEY=... node tts-elevenlabs.mjs --voices          the voices this account can use
//   ELEVENLABS_API_KEY=... node tts-elevenlabs.mjs <lines-dir>       01.mp3, 02.mp3, ... one per line
//   python tts.py --lines <lines-dir> build                          voice.wav + timeline.json from them
//
// The key is read from the environment and is never printed or written anywhere.
// Voice and model come from "elevenlabs" in narration.json: { "voice": "<name or id>", "model": "<model id>" }.
// Licence: audio made on ElevenLabs' free plan is for non-commercial use and must credit elevenlabs.io.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error("ELEVENLABS_API_KEY is not set.");
  process.exit(1);
}
const API = "https://api.elevenlabs.io";
const call = async (path, init = {}) => {
  const res = await fetch(API + path, { ...init, headers: { "xi-api-key": key, ...(init.headers ?? {}) } });
  if (!res.ok) {
    const body = await res.text();
    let message = body.slice(0, 300);
    try {
      const detail = JSON.parse(body).detail;
      message = typeof detail === "string" ? detail : (detail?.message ?? message);
    } catch {}
    throw new Error(`ElevenLabs ${res.status} on ${path.split("?")[0]}: ${message}`);
  }
  return res;
};

const { voices } = await (await call("/v1/voices")).json();
if (process.argv.includes("--voices")) {
  for (const v of voices) {
    const l = v.labels ?? {};
    console.log([v.name.padEnd(34), v.voice_id, v.category, l.gender, l.accent, l.age, l.descriptive ?? l.description, l.use_case].filter(Boolean).join("  "));
  }
  process.exit(0);
}

const out = process.argv[2];
if (!out) {
  console.error("Usage: node tts-elevenlabs.mjs <lines-dir> | --voices");
  process.exit(1);
}
const script = JSON.parse(readFileSync(join(here, "narration.json"), "utf8"));
const want = script.elevenlabs ?? {};
const voice = voices.find((v) => v.voice_id === want.voice) ?? voices.find((v) => v.name.toLowerCase().startsWith(String(want.voice ?? "").toLowerCase()));
if (!want.voice || !voice) {
  console.error(`Voice "${want.voice ?? ""}" not found in this account. Run with --voices to see the choices.`);
  process.exit(1);
}
const models = (await (await call("/v1/models")).json()).filter((m) => m.can_do_text_to_speech);
const model = models.find((m) => m.model_id === want.model);
if (!model) {
  console.error(`Model "${want.model ?? ""}" is not available. Choices: ${models.map((m) => m.model_id).join(", ")}`);
  process.exit(1);
}

// Kokoro needs initials spelled out ("C L I"); ElevenLabs reads them correctly when joined again.
const spoken = (say) => say.replace(/\b[A-Z](?: [A-Z])+\b/g, (m) => m.replaceAll(" ", ""));
const lines = script.scenes.flatMap((s) => s.lines.map((l) => spoken(l.say)));
mkdirSync(out, { recursive: true });
let chars = 0;
for (const [i, text] of lines.entries()) {
  const body = {
    text,
    model_id: model.model_id,
    // The neighbouring lines let the voice carry its tone across the cut.
    ...(model.model_id.includes("v3") ? {} : { previous_text: lines[i - 1], next_text: lines[i + 1] }),
    voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true, ...(want.settings ?? {}) },
  };
  const res = await call(`/v1/text-to-speech/${voice.voice_id}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const file = join(out, `${String(i + 1).padStart(2, "0")}.mp3`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  chars += text.length;
  console.log(`${String(i + 1).padStart(2, "0")}  ${text}`);
}
console.log(`${lines.length} lines, ${chars} characters, voice ${voice.name}, model ${model.model_id}`);
