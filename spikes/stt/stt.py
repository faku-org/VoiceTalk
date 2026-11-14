"""Spike: transcribe a wav with Fluid Speech Pro (Transformers, GPU). Usage: uv run python stt.py file.wav"""
import sys, time
import torch
from transformers import pipeline

t = time.perf_counter()
asr = pipeline("automatic-speech-recognition", model="FluidVoice-Labs/fluid-speech-pro", device="cuda", dtype=torch.bfloat16)
load = time.perf_counter() - t
for path in sys.argv[1:]:
    asr(path)  # warmup
    t = time.perf_counter()
    text = asr(path)["text"]
    print(f"[fluid-speech-pro load {load:.1f}s, {1000*(time.perf_counter()-t):.0f} ms] {path}\n{text}\n")
