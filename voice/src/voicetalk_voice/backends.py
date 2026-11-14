"""Speech-to-text backends the user can pick from (Preferencias > Asistente).

Every backend takes 16 kHz mono float32 and returns text. Heavy imports stay inside `load()`, so
listing the catalog or running the tests never pulls a model runtime.

- phonon (default): Phonon-2.5, Parakeet TDT v3 distilled to 156 MB, CPU. Detects the language
  per segment; supports hotwords (glossary terms).
- canary: NVIDIA Canary-180m-flash, int8 ONNX through sherpa-onnx, CPU. Language forced to
  Spanish: it cannot drift to Portuguese or English on short words.
- fluid: Fluid Speech Pro through transformers, GPU when available. The previous default.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np

log = logging.getLogger(__name__)

SAMPLE_RATE = 16_000
DEFAULT_STT_MODEL = "phonon"
# Phonon-2 accepts at most 25 hotwords.
MAX_HOTWORDS = 25


class SttBackend(Protocol):
    def load(self) -> None: ...
    def transcribe(self, audio: np.ndarray) -> str: ...


@dataclass(frozen=True)
class SttModel:
    id: str
    name: str
    repo: str
    device: str  # "cpu" | "gpu"
    forced_language: bool


CATALOG: dict[str, SttModel] = {
    m.id: m
    for m in (
        SttModel("phonon", "Phonon-2.5", "FermionResearch/Phonon-2.5", "cpu", False),
        SttModel(
            "canary",
            "Canary 180M Flash",
            "csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8",
            "cpu",
            True,
        ),
        SttModel("fluid", "Fluid Speech Pro", "FluidVoice-Labs/fluid-speech-pro", "gpu", False),
    )
}


class PhononBackend:
    def __init__(self, hotwords: list[str] | None = None) -> None:
        self._hotwords = (hotwords or [])[:MAX_HOTWORDS]
        self._speech = None

    def load(self) -> None:
        import fermion

        self._speech = fermion.load_speech("phonon-2.5")
        if self._hotwords:
            self._speech.set_hotwords(self._hotwords)

    def transcribe(self, audio: np.ndarray) -> str:
        if self._speech is None:
            raise RuntimeError("stt model not loaded")
        text, _decode_s, _audio_s = self._speech.transcribe_array(audio)
        return str(text).strip()


class CanaryBackend:
    def __init__(self, language: str = "es") -> None:
        self._language = language
        self._rec = None

    def load(self) -> None:
        import sherpa_onnx
        from huggingface_hub import snapshot_download

        root = Path(snapshot_download(CATALOG["canary"].repo, allow_patterns=["*.onnx", "tokens.txt"]))
        self._rec = sherpa_onnx.OfflineRecognizer.from_nemo_canary(
            encoder=str(root / "encoder.int8.onnx"),
            decoder=str(root / "decoder.int8.onnx"),
            tokens=str(root / "tokens.txt"),
            src_lang=self._language,
            tgt_lang=self._language,
            num_threads=4,
        )

    def transcribe(self, audio: np.ndarray) -> str:
        if self._rec is None:
            raise RuntimeError("stt model not loaded")
        stream = self._rec.create_stream()
        stream.accept_waveform(SAMPLE_RATE, audio)
        self._rec.decode_stream(stream)
        return str(stream.result.text).strip()


class FluidBackend:
    def __init__(self) -> None:
        self._asr = None

    def load(self) -> None:
        import torch
        from transformers import pipeline

        on_cuda = torch.cuda.is_available()
        self._asr = pipeline(
            "automatic-speech-recognition",
            model=CATALOG["fluid"].repo,
            device="cuda" if on_cuda else "cpu",
            dtype=torch.bfloat16 if on_cuda else torch.float32,
        )

    def transcribe(self, audio: np.ndarray) -> str:
        if self._asr is None:
            raise RuntimeError("stt model not loaded")
        out = self._asr({"raw": audio, "sampling_rate": SAMPLE_RATE})
        return str(out["text"]).strip()


def create_backend(model_id: str, hotwords: list[str] | None = None) -> SttBackend:
    if model_id == "phonon":
        return PhononBackend(hotwords)
    if model_id == "canary":
        return CanaryBackend()
    if model_id == "fluid":
        return FluidBackend()
    raise ValueError(f"unknown stt model {model_id!r}")


def resolve_model_id(raw: str | None) -> str:
    value = (raw or "").strip().lower()
    return value if value in CATALOG else DEFAULT_STT_MODEL
