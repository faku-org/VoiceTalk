"""STT engine: Silero VAD plus the selected STT backend, loaded in the background.

The server answers /health immediately; `load()` runs in a thread and flips `status` from
"loading" to "ready" (or "error" with `error` set). `switch()` loads another backend in the
background while the current one keeps serving, then swaps them; a failed switch keeps the old
backend and reports `error` without leaving "ready".
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

import numpy as np
import torch
from silero_vad import load_silero_vad

from .backends import SAMPLE_RATE, SttBackend, create_backend
from .vad import SileroDetector

log = logging.getLogger(__name__)

BackendFactory = Callable[[str], SttBackend]


class Engine:
    def __init__(self, model_id: str, factory: BackendFactory | None = None) -> None:
        self.model = model_id
        self._factory: BackendFactory = factory or create_backend
        self._ready = threading.Event()
        self._lock = threading.Lock()
        self._vad_model: torch.nn.Module | None = None
        self._backend: SttBackend | None = None
        self.status = "loading"  # "loading" | "ready" | "error"
        self.error: str | None = None
        self.pending: str | None = None  # model being loaded by switch()

    def load(self) -> None:
        """Blocking. Call from a background thread. A switch() posted meanwhile waits for it."""
        with self._lock:
            try:
                started = time.perf_counter()
                self._vad_model = load_silero_vad()
                self._backend = self._load_backend(self.model)
                log.info("stt %s ready in %.1fs", self.model, time.perf_counter() - started)
                self.status = "ready"
            except Exception as exc:  # any load failure is reported via health and error events
                self.error = f"{type(exc).__name__}: {exc}"
                self.status = "error"
                log.exception("stt load failed")
            finally:
                self._ready.set()

    def _load_backend(self, model_id: str) -> SttBackend:
        backend = self._factory(model_id)
        backend.load()
        # Warm-up: the first call compiles kernels and allocates buffers.
        backend.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))
        return backend

    def switch(self, model_id: str) -> None:
        """Blocking. Loads `model_id`, then swaps it in. Call from a background thread."""
        with self._lock:
            if model_id == self.model and self.status == "ready":
                return
            self.pending = model_id
            try:
                started = time.perf_counter()
                backend = self._load_backend(model_id)
                if self._vad_model is None:
                    self._vad_model = load_silero_vad()
                self._backend, self.model = backend, model_id
                self.status, self.error = "ready", None
                log.info("stt switched to %s in %.1fs", model_id, time.perf_counter() - started)
            except Exception as exc:
                self.error = f"{model_id}: {type(exc).__name__}: {exc}"
                log.exception("stt switch to %s failed", model_id)
            finally:
                self.pending = None
                self._ready.set()

    def wait_ready(self, timeout: float | None = None) -> bool:
        self._ready.wait(timeout)
        return self.status == "ready"

    def transcribe(self, audio: np.ndarray) -> str:
        backend = self._backend
        if backend is None:
            raise RuntimeError("stt model not loaded")
        return backend.transcribe(audio)

    def new_detector(self) -> SileroDetector:
        if self._vad_model is None:
            raise RuntimeError("vad model not loaded")
        # The Silero model is stateful and shared; links take turns (one ASR worker).
        self._vad_model.reset_states()
        return SileroDetector(self._vad_model)
