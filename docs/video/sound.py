"""Sound design for the explainer: a quiet music bed and small effects, cut to the picture.

    python sound.py build        reads build/timeline.json, build/cues.json, build/voice.wav
                                 writes build/sound.wav (stereo, 48 kHz)

Everything is synthesised here from sine waves and noise, so there is no sample or music licence to
track, and the result is the same on every run. The bed steps back while the voice is speaking.
Needs numpy and scipy.
"""

import json
import sys
import wave
from pathlib import Path

import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt

SR = 48000
build = Path(sys.argv[1] if len(sys.argv) > 1 else "build")
timeline = json.loads((build / "timeline.json").read_text())
cues = json.loads((build / "cues.json").read_text())
TOTAL = timeline["total"]
N = int(TOTAL * SR) + SR  # one spare second for tails
rng = np.random.default_rng(7)

# Levels, as linear gain. Tuned by measurement (see the loudness figures printed at the end).
BED = 0.46       # music bed before ducking
DUCK = 0.62      # how far the bed steps back under the voice (0 = not at all)
FX = 0.80        # all effects together


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def tone(freq, dur, partials=((1, 1.0),), glide=None):
    """Sum of sine partials. glide=(ratio, seconds) starts the pitch off-note and settles onto it."""
    t = np.arange(int(dur * SR)) / SR
    f = np.full_like(t, freq)
    if glide:
        ratio, secs = glide
        f = freq * (1 + (ratio - 1) * np.exp(-t / secs))
    phase = 2 * np.pi * np.cumsum(f) / SR
    return sum(a * np.sin(k * phase) for k, a in partials), t


def band(x, lo=None, hi=None, order=2):
    if lo and hi:
        sos = butter(order, [lo, hi], btype="band", fs=SR, output="sos")
    elif lo:
        sos = butter(order, lo, btype="high", fs=SR, output="sos")
    else:
        sos = butter(order, hi, btype="low", fs=SR, output="sos")
    return sosfilt(sos, x)


def place(buf, mono, at, gain=1.0, pan=0.0):
    """Mix a mono sound into a stereo buffer at a time, with equal-power panning (-1 left, 1 right)."""
    i = int(round(at * SR))
    if i < 0:
        mono, i = mono[-i:], 0
    mono = mono[: max(0, len(buf) - i)]
    a = (pan + 1) * np.pi / 4
    buf[i : i + len(mono), 0] += mono * gain * np.cos(a)
    buf[i : i + len(mono), 1] += mono * gain * np.sin(a)


def fade(x, a=0.004, r=0.01):
    na, nr = int(a * SR), int(r * SR)
    x = x.copy()
    x[:na] *= np.linspace(0, 1, na)
    x[-nr:] *= np.linspace(1, 0, nr)
    return x


# ---------------------------------------------------------------- music bed
# D major, one chord per beat of the story: the chore sits on the minor chords, the answer lands on D.
CHORDS = {
    "Bm": {"bass": 47, "pad": [59, 62, 66, 69]},
    "G": {"bass": 43, "pad": [55, 59, 62, 66]},
    "D": {"bass": 38, "pad": [57, 62, 64, 66, 69]},
    "A": {"bass": 45, "pad": [57, 61, 64, 69]},
}
S = {s["id"]: s for s in timeline["scenes"]}
L = {}
for line in timeline["lines"]:
    L.setdefault(line["scene"], []).append(line["start"])


def mid(scene):
    return (S[scene]["start"] + S[scene]["end"]) / 2


# (start, chord, how busy the plucked line is: 0 none, 1 on the beat, 2 twice a beat)
PLAN = [
    (0.0, "Bm", 0),
    (L["problem"][2], "G", 0),
    (S["ask"]["start"], "D", 2),
    (L["ask"][1] + 1.2, "A", 2),
    (S["apply"]["start"], "Bm", 1),
    (L["apply"][1], "G", 2),
    (L["apply"][2], "D", 0),
    (S["setup"]["start"], "D", 2),
    (L["setup"][2], "A", 2),
    (L["setup"][3], "Bm", 2),
    (S["terminal"]["start"], "G", 1),
    (L["terminal"][1] + 0.4, "D", 1),
    (S["coverage"]["start"], "A", 1),
    (mid("coverage"), "Bm", 1),
    (S["safety"]["start"], "G", 1),
    (mid("safety"), "A", 1),
    (S["cta"]["start"], "D", 2),
]
ENDS = [p[0] for p in PLAN[1:]] + [TOTAL + 1]


def chord_at(t):
    for (start, name, busy), end in zip(PLAN, ENDS):
        if start <= t < end:
            return name, busy
    return PLAN[-1][1], 0


def swell(n, t0, t1, attack=1.0, release=1.2):
    """Raised-cosine in and out, centred on the chord change so neighbours crossfade."""
    t = np.arange(n) / SR
    up = np.clip((t - (t0 - attack / 2)) / attack, 0, 1)
    down = np.clip(((t1 + release / 2) - t) / release, 0, 1)
    return (0.5 - 0.5 * np.cos(np.pi * up)) * (0.5 - 0.5 * np.cos(np.pi * down))


bed = np.zeros((N, 2))
tt = np.arange(N) / SR
for (start, name, _), end in zip(PLAN, ENDS):
    env = swell(N, start, min(end, TOTAL + 0.5))
    chord = CHORDS[name]
    for j, note in enumerate(chord["pad"]):
        for side, cents in ((0, -5), (1, 5)):  # two slightly detuned copies, one per ear
            f = hz(note) * 2 ** (cents / 1200)
            drift = 1 + 0.08 * np.sin(2 * np.pi * (0.11 + 0.03 * j) * tt + j + side)
            wave_ = np.sin(2 * np.pi * f * tt) + 0.30 * np.sin(4 * np.pi * f * tt) + 0.10 * np.sin(6 * np.pi * f * tt)
            bed[:, side] += 0.045 * env * drift * wave_
            # A faint octave above keeps the pad airy instead of sitting where the voice does.
            bed[:, side] += 0.011 * env * (2 - drift) * np.sin(4 * np.pi * f * 1.002 * tt + j)
    f = hz(chord["bass"])
    bass = 0.075 * env * (np.sin(2 * np.pi * f * tt) + 0.45 * np.sin(4 * np.pi * f * tt))
    bed[:, 0] += bass
    bed[:, 1] += bass
for c in (0, 1):
    bed[:, c] = band(band(bed[:, c], hi=3000), lo=70)

# Plucked line: chord tones an octave up, on a steady pulse.
BEAT = 0.625  # 96 beats per minute
PATTERN = [0, 2, 1, 3, 2, 4, 3, 1]
plucks = np.zeros((N, 2))
step = 0
t = 0.0
while t < L["cta"][0] + 3.4:
    name, busy = chord_at(t)
    on_beat = step % 2 == 0
    if busy == 2 or (busy == 1 and on_beat):
        tones = [p + 12 for p in CHORDS[name]["pad"]]
        note = tones[PATTERN[step % len(PATTERN)] % len(tones)]
        x, tx = tone(hz(note), 0.9, ((1, 1.0), (2, 0.28), (3, 0.06)))
        x = fade(x * np.exp(-tx / 0.20), 0.003, 0.05)
        vel = (1.0 if step % 4 == 0 else 0.62 if on_beat else 0.45) * (1.0 if busy == 2 else 0.8)
        place(plucks, x, t, 0.085 * vel, 0.38 if step % 2 else -0.38)
    step += 1
    t += BEAT / 2
# Dotted-eighth echo, crossing sides, so the line has some air around it.
echo = np.zeros_like(plucks)
d = int(BEAT * 0.75 * SR)
for k, g in ((1, 0.34), (2, 0.14)):
    echo[k * d :, 0] += plucks[: N - k * d, 1 if k % 2 else 0] * g
    echo[k * d :, 1] += plucks[: N - k * d, 0 if k % 2 else 1] * g
plucks += echo

# ---------------------------------------------------------------- effects
fx = np.zeros((N, 2))
PENTA = [74, 76, 78, 81, 83, 86, 88, 90]  # D major pentatonic: sits well on every chord above


def pop_sound(note, amp=1.0):
    x, tx = tone(hz(note), 0.22, ((1, 1.0), (2, 0.18)), glide=(0.72, 0.012))
    return fade(x * np.exp(-tx / 0.050)) * 0.16 * amp


def bell(note, decay=0.55, amp=1.0):
    x, tx = tone(hz(note), decay * 4, ((1, 1.0), (2, 0.32), (3, 0.10), (4.2, 0.05)))
    return fade(x * np.exp(-tx / decay), 0.002, 0.05) * 0.12 * amp


def whoosh(dur, lo, hi, amp):
    n = int(dur * SR)
    noise = rng.standard_normal(n)
    k = np.linspace(0, 1, n)
    low, high = band(noise, lo, (lo * hi) ** 0.5), band(noise, (lo * hi) ** 0.5, hi)
    shape = np.sin(np.pi * k**0.8) ** 2  # peaks a little after the middle
    return (low * (1 - k) + high * k) * shape * amp


def key_click():
    n = int(0.022 * SR)
    tx = np.arange(n) / SR
    click = band(rng.standard_normal(n), 1800, 5200) * np.exp(-tx / 0.0035)
    thock = np.sin(2 * np.pi * rng.uniform(130, 170) * tx) * np.exp(-tx / 0.008)
    return fade(click * 0.9 + thock * 0.5, 0.0005, 0.004)


groups = {}  # kind -> (index in the current run, time of the last one)
for c in cues:
    kind, at = c["kind"], c["at"]
    idx, last = groups.get(kind, (0, -9))
    idx = idx + 1 if at - last < 1.3 else 0
    groups[kind] = (idx, at)

    if kind == "pop":
        place(fx, pop_sound(PENTA[idx % len(PENTA)]), at, 1.0, -0.3 + 0.6 * (idx % 4) / 3)
    elif kind == "blip":
        place(fx, pop_sound(PENTA[idx % len(PENTA)], 0.55), at, 1.0, 0.35)
    elif kind == "tick":
        place(fx, bell(PENTA[(idx + 3) % len(PENTA)], 0.16, 0.8), at, 1.0, -0.1)
    elif kind == "card":
        place(fx, pop_sound(PENTA[idx % 3] - 12, 1.1), at, 1.0, -0.4 + 0.4 * idx)
        place(fx, whoosh(0.28, 500, 3000, 0.035), at - 0.12, 1.0, -0.4 + 0.4 * idx)
    elif kind == "swish":
        place(fx, whoosh(0.36, 500, 3500, 0.040), at - 0.05, 1.0, rng.uniform(-0.4, 0.4))
    elif kind == "whoosh":
        w = whoosh(0.70, 250, 4200, 0.085)
        sweep = np.linspace(-0.6, 0.6, len(w))
        i = int((at - 0.42) * SR)
        fx[i : i + len(w), 0] += w * np.cos((sweep + 1) * np.pi / 4)
        fx[i : i + len(w), 1] += w * np.sin((sweep + 1) * np.pi / 4)
    elif kind == "swell":  # air rising into the last scene
        n = int(1.5 * SR)
        k = np.linspace(0, 1, n)
        place(fx, band(rng.standard_normal(n), 1500, 7000) * k**2.4 * np.clip((1 - k) * 30, 0, 1) * 0.06, at - 1.45)
        for j, note in enumerate((62, 69, 74, 78)):
            place(fx, bell(note, 1.3, 0.75), at + 0.03 * j, 1.0, -0.45 + 0.3 * j)
    elif kind == "dialog":  # a soft knock: the tool stops and asks
        for j, note in enumerate((59, 66)):
            place(fx, bell(note, 0.38, 1.0), at + 0.11 * j, 1.0, 0.0)
        place(fx, whoosh(0.3, 300, 1800, 0.04), at - 0.1)
    elif kind == "press":
        x, tx = tone(120, 0.12, ((1, 1.0),), glide=(1.6, 0.02))
        place(fx, fade(x * np.exp(-tx / 0.030)) * 0.22, at)
        place(fx, key_click() * 0.10, at)
    elif kind == "ok":
        for j, note in enumerate((81, 86)):
            place(fx, bell(note, 0.30, 0.7), at + 0.09 * j, 1.0, 0.2)
    elif kind == "success":
        for j, note in enumerate((74, 78, 81, 86)):
            place(fx, bell(note, 0.85, 1.0), at + 0.075 * j, 1.0, -0.5 + j / 3)
    elif kind == "type":
        every = max(1, round(c["cps"] / 13))  # no more than about 13 clicks a second
        chars = int(c["dur"] * c["cps"])
        for n in range(0, chars, every):
            place(fx, key_click(), at + n / c["cps"] + rng.uniform(-0.008, 0.008), rng.uniform(0.028, 0.050), rng.uniform(-0.15, 0.15))

# ---------------------------------------------------------------- space, ducking, mix
# A small synthetic room for the plucked line and the effects.
n_ir = int(1.5 * SR)
t_ir = np.arange(n_ir) / SR
ir = np.stack([band(rng.standard_normal(n_ir), 300, 5000) * np.exp(-t_ir / 0.32) for _ in (0, 1)], axis=1)
ir[: int(0.012 * SR)] = 0
ir /= np.sqrt((ir**2).sum(axis=0))
dry = plucks * 1.0 + fx * 0.8
wet = np.stack([fftconvolve(dry[:, c], ir[:, c])[:N] for c in (0, 1)], axis=1)
plucks += 0.20 * np.stack([fftconvolve(plucks[:, c], ir[:, c])[:N] for c in (0, 1)], axis=1)
fx_wet = np.stack([fftconvolve(fx[:, c], ir[:, c])[:N] for c in (0, 1)], axis=1)
fx += 0.16 * fx_wet
del dry, wet

# The bed follows the voice: down quickly when a line starts, back up gently when it ends.
with wave.open(str(build / "voice.wav")) as w:
    vsr = w.getframerate()
    voice = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768
    if w.getnchannels() == 2:
        voice = voice.reshape(-1, 2).mean(axis=1)
hop = vsr // 100
level = np.sqrt(np.array([np.mean(voice[i : i + hop * 4] ** 2) for i in range(0, len(voice), hop)]))
speaking = (level > 0.1 * np.percentile(level, 95)).astype(float)
follow = np.zeros_like(speaking)
g = 0.0
for i, s_ in enumerate(speaking):
    g += (s_ - g) * (0.22 if s_ > g else 0.035)  # about 40 ms down, 300 ms back
    follow[i] = g
duck = 1 - DUCK * np.interp(tt, np.arange(len(follow)) / 100, follow, right=0.0)

music = (bed + plucks) * BED * duck[:, None]
out = music + fx * FX
master = np.ones(N)
master[: int(0.5 * SR)] = np.linspace(0, 1, int(0.5 * SR))
end = int(TOTAL * SR)
tail = int(1.6 * SR)
master[end - tail : end] = np.cos(np.linspace(0, np.pi / 2, tail)) ** 2
master[end:] = 0
out = (out * master[:, None])[:end]

peak = np.abs(out).max()
if peak > 0.7:
    out *= 0.7 / peak


def db(x):
    return 20 * np.log10(np.sqrt(np.mean(x**2)) + 1e-12)


print(f"bed {db(music[:end]):.1f} dB RMS, effects {db(fx[:end] * FX):.1f} dB RMS, peak {20 * np.log10(np.abs(out).max()):.1f} dB")
with wave.open(str(build / "sound.wav"), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((np.clip(out, -1, 1) * 32767).astype("<i2").tobytes())
print(build / "sound.wav")
