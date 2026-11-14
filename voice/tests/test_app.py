import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from fakes import FakeEngine, read_pcm, write_synthetic_wav
from voicetalk_voice.app import MAX_STT_CONNECTIONS, Settings, create_app

GLOSSARY_PATH = Path(__file__).resolve().parents[1] / "glossary.toml"
CHUNK_MS = 20


def _settings() -> Settings:
    return Settings(glossary_path=GLOSSARY_PATH, llm_url=None)


@pytest.fixture
def wav(tmp_path: Path) -> Path:
    return write_synthetic_wav(tmp_path / "synthetic.wav")


def _stream(ws, pcm: bytes, chunk_bytes: int) -> None:
    for offset in range(0, len(pcm), chunk_bytes):
        ws.send_bytes(pcm[offset : offset + chunk_bytes])


def _collect(ws, n: int) -> list[dict]:
    return [ws.receive_json() for _ in range(n)]


def test_health_reports_loading_then_ready() -> None:
    engine = FakeEngine(ready=False)
    app = create_app(_settings(), engine=engine)
    with TestClient(app) as client:
        assert client.get("/health").json() == {"ok": True, "stt": "loading"}
        engine.gate.set()
        deadline = time.monotonic() + 5
        body = client.get("/health").json()
        while body["stt"] != "ready" and time.monotonic() < deadline:
            time.sleep(0.02)
            body = client.get("/health").json()
        assert body == {"ok": True, "stt": "ready"}


def test_ws_segments_and_finals(wav: Path) -> None:
    engine = FakeEngine(text="hola VoiceTalk desde cartecia")
    app = create_app(_settings(), engine=engine)
    pcm = read_pcm(wav)
    with TestClient(app) as client, client.websocket_connect("/stt") as ws:
        _stream(ws, pcm, chunk_bytes=int(16_000 * 2 * CHUNK_MS / 1000))
        events = _collect(ws, 6)

    # Finals are produced by a sequential worker, so their position relative to the
    # next segment's speech_start is not fixed. Check the per-segment contract instead.
    starts = [e for e in events if e["type"] == "speech_start"]
    ends = [e for e in events if e["type"] == "speech_end"]
    finals = [e for e in events if e["type"] == "final"]
    assert len(starts) == len(ends) == len(finals) == 2
    # first burst starts at 1.0 s; the VAD reports it at the frame boundary just before (±32 ms)
    assert abs(starts[0]["t"] - 1.0) < 0.05
    assert ends[0]["t"] > 1.8  # 0.8 s burst + end-of-speech silence
    for i, final in enumerate(finals):
        assert final["t_start"] == starts[i]["t"]
        assert final["t_end"] == ends[i]["t"]
        assert final["raw"] == "hola VoiceTalk desde cartecia"
        assert final["text"] == "hola VoiceTalk desde Cartesia"
        assert isinstance(final["stt_ms"], int) and final["stt_ms"] >= 0
        assert events.index(final) > events.index(ends[i])
    # the engine saw only the two segments' audio, never the silence
    assert len(engine.transcribed_samples) == 2
    assert engine.transcribed_samples[0] >= int(0.8 * 16_000)


@pytest.mark.parametrize("chunk_bytes", [333, 640, 4096])
def test_ws_accepts_arbitrary_frame_sizes(wav: Path, chunk_bytes: int) -> None:
    app = create_app(_settings(), engine=FakeEngine())
    pcm = read_pcm(wav)
    with TestClient(app) as client, client.websocket_connect("/stt") as ws:
        _stream(ws, pcm, chunk_bytes=chunk_bytes)
        events = _collect(ws, 6)
    assert [e["type"] for e in events].count("final") == 2


def test_ws_not_ready_sends_error_and_closes() -> None:
    app = create_app(_settings(), engine=FakeEngine(ready=False))
    with TestClient(app) as client:
        with client.websocket_connect("/stt") as ws:
            event = ws.receive_json()
            assert event["type"] == "error"
            assert "loading" in event["message"]
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()


def test_ws_allows_concurrent_connections_up_to_the_limit(wav: Path) -> None:
    """Call capture opens two links (remote + mic) next to a possible voice call."""
    app = create_app(_settings(), engine=FakeEngine(text="hola"))
    pcm = read_pcm(wav)
    chunk = int(16_000 * 2 * CHUNK_MS / 1000)
    with TestClient(app) as client:
        with client.websocket_connect("/stt") as a, client.websocket_connect("/stt") as b:
            # Each connection keeps its own segmenter: both see both bursts.
            _stream(a, pcm, chunk_bytes=chunk)
            _stream(b, pcm, chunk_bytes=chunk)
            for ws in (a, b):
                events = _collect(ws, 6)
                assert len([e for e in events if e["type"] == "final"]) == 2


def test_ws_connection_over_the_limit_is_refused() -> None:
    app = create_app(_settings(), engine=FakeEngine())
    with TestClient(app) as client:
        with (
            client.websocket_connect("/stt"),
            client.websocket_connect("/stt"),
            client.websocket_connect("/stt"),
        ):
            with pytest.raises(WebSocketDisconnect) as refused:
                with client.websocket_connect("/stt") as extra:
                    extra.receive_json()
            assert refused.value.code == 1013


def test_ws_slot_is_freed_when_a_connection_closes() -> None:
    app = create_app(_settings(), engine=FakeEngine())
    with TestClient(app) as client:
        for _ in range(MAX_STT_CONNECTIONS + 2):
            with client.websocket_connect("/stt"):
                pass
