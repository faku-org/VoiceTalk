"""Test doubles: an energy-based detector and a fake ASR engine. No models are loaded."""

from __future__ import annotations

import threading
import wave
from pathlib import Path

import numpy as np

from voicetalk_voice.segmenter import FRAME_SAMPLES, SAMPLE_RATE


class EnergyDetector:
    """RMS gate with hysteresis: start on the first loud frame, end after `end_frames` quiet frames."""

    def __init__(self, threshold: float = 0.02, end_frames: int = 10) -> None:
        self._threshold = threshold
        self._end_frames = end_frames
        self._seen = 0
        self._active = False
        self._quiet = 0

    def feed(self, frame: np.ndarray) -> list[tuple[str, int]]:
        index = self._seen
        self._seen += FRAME_SAMPLES
        loud = float(np.sqrt(np.mean(frame.astype(np.float64) ** 2))) > self._threshold
        if loud and not self._active:
            self._active, self._quiet = True, 0
            return [("start", index)]
        if self._active:
            if loud:
                self._quiet = 0
                return []
            self._quiet += 1
            if self._quiet >= self._end_frames:
                self._active = False
                return [("end", index)]
        return []


class FakeEngine:
    def __init__(self, text: str = "hola VoiceTalk desde cartecia", ready: bool = True) -> None:
        self.text = text
        self.status = "loading"
        self.error: str | None = None
        self.gate = threading.Event()  # set() lets load() finish
        self.transcribed_samples: list[int] = []
        self.model = "phonon"
        self.pending: str | None = None
        self.switched: list[str] = []
        if ready:
            self.gate.set()

    def load(self) -> None:
        self.gate.wait(10)
        self.status = "ready"

    def switch(self, model_id: str) -> None:
        self.switched.append(model_id)
        self.model = model_id

    def wait_ready(self, timeout: float | None = None) -> bool:
        self.gate.wait(timeout)
        return self.status == "ready"

    def transcribe(self, audio: np.ndarray) -> str:
        self.transcribed_samples.append(len(audio))
        return self.text

    def new_detector(self) -> EnergyDetector:
        return EnergyDetector()


def write_synthetic_wav(path: Path) -> Path:
    """16 kHz mono 16-bit: silence, two tone bursts separated by silence. Pure stdlib + numpy."""
    rate = SAMPLE_RATE
    parts = [
        np.zeros(int(1.0 * rate)),
        0.3 * np.sin(2 * np.pi * 220 * np.arange(int(0.8 * rate)) / rate),
        np.zeros(int(1.0 * rate)),
        0.3 * np.sin(2 * np.pi * 330 * np.arange(int(0.6 * rate)) / rate),
        np.zeros(int(1.0 * rate)),
    ]
    samples = (np.concatenate(parts) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(samples.tobytes())
    return path


def read_pcm(path: Path) -> bytes:
    with wave.open(str(path), "rb") as wav:
        assert wav.getnchannels() == 1 and wav.getsampwidth() == 2 and wav.getframerate() == SAMPLE_RATE
        return wav.readframes(wav.getnframes())
