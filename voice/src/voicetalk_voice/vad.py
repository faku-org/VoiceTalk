"""Silero VAD adapter. One detector per WebSocket connection (it holds stream state)."""

from __future__ import annotations

import numpy as np
import torch
from silero_vad import VADIterator

SAMPLE_RATE = 16_000
THRESHOLD = 0.5  # speech probability that opens a segment
MIN_SILENCE_MS = 500  # silence that closes a segment
SPEECH_PAD_MS = 30  # onset is reported this much earlier


class SileroDetector:
    def __init__(self, model: torch.nn.Module) -> None:
        self._iterator = VADIterator(
            model,
            threshold=THRESHOLD,
            sampling_rate=SAMPLE_RATE,
            min_silence_duration_ms=MIN_SILENCE_MS,
            speech_pad_ms=SPEECH_PAD_MS,
        )

    def feed(self, frame: np.ndarray) -> list[tuple[str, int]]:
        result = self._iterator(torch.from_numpy(frame), return_seconds=False)
        if not result:
            return []
        if "start" in result:
            return [("start", int(result["start"]))]
        return [("end", int(result["end"]))]
