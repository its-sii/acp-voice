#!/usr/bin/env python3
"""Speak stdin with Kokoro (local neural TTS). Use as acp-voice's `tts` command.

Set up and run it through acp-voice, which knows where everything lives:
  npx -y acp-voice setup kokoro:af_heart
  (saves "voice": "kokoro:af_heart" to the config)
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

# acp-voice interrupts with SIGTERM: stop the player too, and exit through `finally` so the temp file is removed
player = None
def stop(*_):
    if player:
        player.terminate()
    sys.exit(143)
signal.signal(signal.SIGTERM, stop)

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
    player = subprocess.Popen(['afplay', path] if sys.platform == 'darwin' else ['aplay', '-q', path])
    player.wait()
finally:
    os.remove(path)
