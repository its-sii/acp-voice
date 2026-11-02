#!/usr/bin/env python3
"""Speak stdin with Kokoro (local neural TTS). Use as acp-voice's `tts` command.

Setup (once):
  uv venv --python 3.12 ~/.local/share/acp-voice/kokoro/venv
  uv pip install --python ~/.local/share/acp-voice/kokoro/venv/bin/python kokoro-onnx
  download kokoro-v1.0.onnx and voices-v1.0.bin from
  https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0
  into ~/.local/share/acp-voice/kokoro (or set KOKORO_DIR)

Then: "tts": "~/.local/share/acp-voice/kokoro/venv/bin/python /path/to/tts/kokoro.py --voice af_heart"
"""
import argparse, os, signal, subprocess, sys, tempfile, wave

import numpy as np
from kokoro_onnx import Kokoro

p = argparse.ArgumentParser()
p.add_argument('--voice', default='af_heart', help='e.g. af_heart, af_bella, am_michael, bf_emma, bm_george')
p.add_argument('--speed', type=float, default=1.1)
p.add_argument('--lang', default='en-us', help='en-us or en-gb')
args = p.parse_args()

text = sys.stdin.read().strip()
if not text:
    sys.exit(0)

# acp-voice interrupts with SIGTERM; exit through `finally` so the temp file is removed
signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))

model_dir = os.path.expanduser(os.environ.get('KOKORO_DIR', '~/.local/share/acp-voice/kokoro'))
kokoro = Kokoro(os.path.join(model_dir, 'kokoro-v1.0.onnx'), os.path.join(model_dir, 'voices-v1.0.bin'))
samples, rate = kokoro.create(text, voice=args.voice, speed=args.speed, lang=args.lang)

fd, path = tempfile.mkstemp(suffix='.wav')
try:
    with wave.open(os.fdopen(fd, 'wb'), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())
    subprocess.run(['afplay', path] if sys.platform == 'darwin' else ['aplay', '-q', path])
finally:
    os.remove(path)
