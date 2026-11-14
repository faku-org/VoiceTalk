"""Engine.switch with a fake backend factory. No models are loaded."""

from __future__ import annotations

import numpy as np
import pytest

from voicetalk_voice import engine as engine_module
from voicetalk_voice.engine import Engine


class FakeBackend:
    def __init__(self, model_id: str, fail: bool = False) -> None:
        self.model_id = model_id
        self.fail = fail
        self.loaded = False

    def load(self) -> None:
        if self.fail:
            raise RuntimeError("boom")
        self.loaded = True

    def transcribe(self, audio: np.ndarray) -> str:
        return f"text from {self.model_id}"


class Factory:
    def __init__(self, failing: set[str] | None = None) -> None:
        self.failing = failing or set()
        self.calls: list[str] = []

    def __call__(self, model_id: str) -> FakeBackend:
        self.calls.append(model_id)
        return FakeBackend(model_id, fail=model_id in self.failing)


@pytest.fixture(autouse=True)
def no_vad(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(engine_module, "load_silero_vad", lambda: object())


AUDIO = np.zeros(16_000, dtype=np.float32)


def _ready_engine(factory: Factory) -> Engine:
    engine = Engine("phonon", factory=factory)
    engine.load()
    assert engine.status == "ready"
    return engine


def test_switch_swaps_model() -> None:
    factory = Factory()
    engine = _ready_engine(factory)
    assert engine.transcribe(AUDIO) == "text from phonon"
    engine.switch("canary")
    assert engine.model == "canary"
    assert engine.status == "ready"
    assert engine.error is None
    assert engine.pending is None
    assert engine.transcribe(AUDIO) == "text from canary"


def test_failed_switch_keeps_old_model() -> None:
    factory = Factory(failing={"canary"})
    engine = _ready_engine(factory)
    engine.switch("canary")
    assert engine.model == "phonon"
    assert engine.status == "ready"
    assert engine.error is not None and "canary" in engine.error and "boom" in engine.error
    assert engine.pending is None
    assert engine.transcribe(AUDIO) == "text from phonon"


def test_successful_switch_clears_previous_error() -> None:
    factory = Factory(failing={"canary"})
    engine = _ready_engine(factory)
    engine.switch("canary")
    assert engine.error is not None
    engine.switch("fluid")
    assert engine.model == "fluid"
    assert engine.error is None


def test_switch_to_current_model_is_noop() -> None:
    factory = Factory()
    engine = _ready_engine(factory)
    engine.switch("phonon")
    assert factory.calls == ["phonon"]  # only the initial load
    assert engine.model == "phonon"
    assert engine.status == "ready"
