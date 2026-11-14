"""STT engine: Fluid Speech Pro (ASR) and Silero VAD, loaded in the background.

The server answers /health immediately; `load()` runs in a thread and flips
`status` from "loading" to "ready" (or "error" with `error` set).
"""

from __future__ import annotations

import logging
import threading
import time

import numpy as np
import torch
from silero_vad import load_silero_vad
from transformers import pipeline

from .segmenter import SAMPLE_RATE
from .vad import SileroDetector

log = logging.getLogger(__name__)

ASR_MODEL_ID = "FluidVoice-Labs/fluid-speech-pro"


class Engine:
    def __init__(self, asr_model_id: str = ASR_MODEL_ID) -> None:
        self._asr_model_id = asr_model_id
        self._ready = threading.Event()
        self._vad_model: torch.nn.Module | None = None
        self._asr = None
        self.status = "loading"  # "loading" | "ready" | "error"
        self.error: str | None = None
        self.device = "unknown"

    def load(self) -> None:
        """Blocking. Call from a background thread."""
        try:
            on_cuda = torch.cuda.is_available()
            self.device = "cuda" if on_cuda else "cpu"
            dtype = torch.bfloat16 if on_cuda else torch.float32
            started = time.perf_counter()
            self._vad_model = load_silero_vad()
            self._asr = pipeline(
                "automatic-speech-recognition",
                model=self._asr_model_id,
                device=self.device,
                dtype=dtype,
            )
            # Warm-up: first call compiles kernels and allocates buffers.
            self._asr({"raw": np.zeros(SAMPLE_RATE, dtype=np.float32), "sampling_rate": SAMPLE_RATE})
            log.info("stt ready on %s in %.1fs", self.device, time.perf_counter() - started)
            self.status = "ready"
        except Exception as exc:  # any load failure is reported via health and error events
            self.error = f"{type(exc).__name__}: {exc}"
            self.status = "error"
            log.exception("stt load failed")
        finally:
            self._ready.set()

    def wait_ready(self, timeout: float | None = None) -> bool:
        self._ready.wait(timeout)
        return self.status == "ready"

    def transcribe(self, audio: np.ndarray) -> str:
        if self._asr is None:
            raise RuntimeError("stt model not loaded")
        out = self._asr({"raw": audio, "sampling_rate": SAMPLE_RATE})
        return str(out["text"]).strip()

    def new_detector(self) -> SileroDetector:
        if self._vad_model is None:
            raise RuntimeError("vad model not loaded")
        # The Silero model is stateful and shared; one connection at a time (enforced by the app).
        self._vad_model.reset_states()
        return SileroDetector(self._vad_model)
