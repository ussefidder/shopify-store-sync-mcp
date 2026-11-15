"""Voice-over for the explainer, made locally with Kokoro (open-source text to speech).

    pip install kokoro-onnx soundfile numpy
    python tts.py <model.onnx> <voices.bin> <out-dir>

Writes voice.wav and timeline.json. The timeline (when each line and scene starts and ends) is
what the animation is timed to, so picture and voice can't drift apart.
"""
import json
import os
import sys

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
model, voices, out = sys.argv[1], sys.argv[2], sys.argv[3]
script = json.load(open(os.path.join(HERE, "narration.json"), encoding="utf-8"))
kokoro = Kokoro(model, voices)

LEAD_IN = 0.6      # silence before the first word
LINE_GAP = 0.30    # between lines of a scene
SCENE_GAP = 0.70   # between scenes
TAIL = 0.4

def trim(samples, sr, floor=0.012, pad=0.03):
    """Cut the silence around a line so the gaps are the ones chosen here."""
    loud = np.where(np.abs(samples) > floor)[0]
    if not len(loud):
        return samples
    a = max(0, loud[0] - int(pad * sr))
    b = min(len(samples), loud[-1] + int(pad * sr))
    return samples[a:b]

sr = 24000
t = LEAD_IN
pieces = []          # (start_sample, samples)
scenes, lines = [], []
for scene in script["scenes"]:
    start = t - (LEAD_IN if not scenes else SCENE_GAP / 2)
    for i, line in enumerate(scene["lines"]):
        samples, sr = kokoro.create(line["say"], voice=script["voice"], speed=script["speed"], lang="en-us")
        samples = trim(np.asarray(samples, dtype=np.float32), sr)
        dur = len(samples) / sr
        pieces.append((int(t * sr), samples))
        lines.append({"scene": scene["id"], "caption": line["caption"], "start": round(t, 3), "end": round(t + dur, 3)})
        t += dur + (LINE_GAP if i < len(scene["lines"]) - 1 else 0)
    t += scene.get("hold", 0)
    end = t + SCENE_GAP / 2
    scenes.append({"id": scene["id"], "start": round(max(0, start), 3), "end": round(end, 3)})
    t += SCENE_GAP
total = scenes[-1]["end"] + TAIL
scenes[-1]["end"] = round(total, 3)

mix = np.zeros(int(total * sr) + sr, dtype=np.float32)
for at, samples in pieces:
    mix[at:at + len(samples)] += samples
mix = mix[: int(total * sr)]
peak = float(np.max(np.abs(mix))) or 1.0
mix = mix * (0.89 / peak)

os.makedirs(out, exist_ok=True)
sf.write(os.path.join(out, "voice.wav"), mix, sr)
json.dump({"total": round(total, 3), "scenes": scenes, "lines": lines}, open(os.path.join(out, "timeline.json"), "w"), indent=1)
for s in scenes:
    print(f'{s["id"]:10} {s["start"]:6.2f} -> {s["end"]:6.2f}')
print("total", round(total, 2), "s")
