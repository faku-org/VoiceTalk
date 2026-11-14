"""FastAPI app: GET /health, the STT model endpoints and WS /stt (see docs/adr/0002-audio-websocket.md).

STT model (ADR 0011)
- GET  /stt/models -> {"current":id,"pending":id|null,"models":[{id,name,repo,device,forced_language}]}
- POST /stt/model {"id":str} -> 202; loads it in the background, the current model keeps serving
  until the new one is ready. /health reports progress (`model`, `pending`, `error`).

WS /stt protocol
- client -> server: binary frames, pcm_s16le mono 16 kHz, any frame size.
- server -> client (JSON text):
  - {"type":"speech_start","t":sec}
  - {"type":"speech_end","t":sec}
  - {"type":"final","text":str,"raw":str,"t_start":sec,"t_end":sec,"stt_ms":int}
  - {"type":"error","message":str}   (ASR failure or model not loaded; connection stays open)
- one connection at a time; a second one is closed with 1013 (try again later).
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from .backends import CATALOG, create_backend, resolve_model_id

from .glossary import Glossary
from .llm import LlmCorrector
from .segmenter import Detector, Segmenter, SpeechEnd, SpeechStart

log = logging.getLogger(__name__)

DEFAULT_GLOSSARY = Path(__file__).resolve().parents[2] / "glossary.toml"
TRY_AGAIN_LATER = 1013
DEFAULT_MAX_CLIENTS = 8


@dataclass(frozen=True)
class Settings:
    glossary_path: Path = DEFAULT_GLOSSARY
    llm_url: str | None = None  # VT_LLM_URL, OpenAI-compatible base incl. /v1
    llm_model: str = "local"  # VT_LLM_MODEL
    # VT_STT_MAX_CLIENTS: concurrent /stt links. The mic call uses one; a Discord session opens one per speaker.
    # Each link has its own VAD state; transcription stays serialized on one ASR worker.
    max_clients: int = DEFAULT_MAX_CLIENTS
    # VT_STT_MODEL: model loaded at start (phonon | canary | fluid). Core switches it from preferences.
    stt_model: str = "phonon"

    @classmethod
    def from_env(cls, glossary_path: Path | None = None) -> Settings:
        return cls(
            glossary_path=glossary_path or Path(os.environ.get("VT_GLOSSARY", DEFAULT_GLOSSARY)),
            llm_url=os.environ.get("VT_LLM_URL") or None,
            llm_model=os.environ.get("VT_LLM_MODEL", "local"),
            max_clients=_max_clients(os.environ.get("VT_STT_MAX_CLIENTS")),
            stt_model=resolve_model_id(os.environ.get("VT_STT_MODEL")),
        )


def _max_clients(raw: str | None) -> int:
    try:
        value = int(raw) if raw else DEFAULT_MAX_CLIENTS
    except ValueError:
        return DEFAULT_MAX_CLIENTS
    return value if value >= 1 else DEFAULT_MAX_CLIENTS


class EngineLike(Protocol):
    status: str
    error: str | None
    model: str
    pending: str | None

    def load(self) -> None: ...
    def switch(self, model_id: str) -> None: ...
    def wait_ready(self, timeout: float | None = None) -> bool: ...
    def transcribe(self, audio: Any) -> str: ...
    def new_detector(self) -> Detector: ...


class ModelChoice(BaseModel):
    id: str


def create_app(settings: Settings | None = None, engine: EngineLike | None = None) -> FastAPI:
    if settings is None:
        settings = Settings.from_env()
    glossary = Glossary.from_toml(settings.glossary_path)
    glossary_terms = sorted({entry.canonical for entry in glossary.entries.values()})
    if engine is None:
        from .engine import Engine

        # Glossary terms double as hotwords for backends that support them (Phonon).
        engine = Engine(settings.stt_model, factory=lambda model_id: create_backend(model_id, glossary_terms))
    llm = (
        LlmCorrector(settings.llm_url, model=settings.llm_model, terms=glossary_terms)
        if settings.llm_url
        else None
    )
    asr_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr")
    clients = 0

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        threading.Thread(target=engine.load, name="stt-load", daemon=True).start()
        yield
        if llm is not None:
            await llm.aclose()
        asr_pool.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(title="voicetalk-voice", lifespan=lifespan)

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "stt": engine.status,
            "model": engine.model,
            "pending": engine.pending,
            "error": engine.error,
        }

    @app.get("/stt/models")
    async def stt_models() -> dict[str, Any]:
        return {
            "current": engine.model,
            "pending": engine.pending,
            "models": [vars(m) for m in CATALOG.values()],
        }

    @app.post("/stt/model", status_code=202)
    async def stt_model(body: ModelChoice) -> dict[str, Any]:
        if body.id not in CATALOG:
            raise HTTPException(status_code=422, detail=f"unknown stt model {body.id!r}")
        if body.id != engine.model or engine.status != "ready":
            threading.Thread(target=engine.switch, args=(body.id,), name="stt-switch", daemon=True).start()
        return {"current": engine.model, "pending": body.id if body.id != engine.model else None}

    @app.websocket("/stt")
    async def stt_socket(ws: WebSocket) -> None:
        nonlocal clients
        if clients >= settings.max_clients:
            await ws.close(code=TRY_AGAIN_LATER)
            return
        if engine.status != "ready":
            # VAD is not loaded yet: refuse instead of queueing audio. Client retries after /health says ready.
            await ws.accept()
            await ws.send_json({"type": "error", "message": f"stt not ready: {engine.status}"})
            await ws.close(code=TRY_AGAIN_LATER)
            return
        clients += 1
        await ws.accept()

        out: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        segments: asyncio.Queue[SpeechEnd] = asyncio.Queue()
        segmenter = Segmenter(engine.new_detector())
        loop = asyncio.get_running_loop()

        async def transcribe_one(segment: SpeechEnd) -> None:
            started = time.perf_counter()
            try:
                raw = await loop.run_in_executor(asr_pool, engine.transcribe, segment.audio)
            except Exception as exc:
                log.exception("transcription failed")
                out.put_nowait({"type": "error", "message": f"transcription failed: {type(exc).__name__}"})
                return
            stt_ms = int((time.perf_counter() - started) * 1000)
            text = glossary.correct(raw)
            if llm is not None:
                text = await llm.correct(text)
            out.put_nowait(
                {
                    "type": "final",
                    "text": text,
                    "raw": raw,
                    "t_start": round(segment.t_start, 3),
                    "t_end": round(segment.t_end, 3),
                    "stt_ms": stt_ms,
                }
            )

        async def sender() -> None:
            while True:
                await ws.send_json(await out.get())

        async def worker() -> None:
            # Sequential on purpose: finals arrive in speech order, and the GPU runs one job at a time.
            while True:
                await transcribe_one(await segments.get())

        send_task = asyncio.create_task(sender())
        work_task = asyncio.create_task(worker())
        try:
            while True:
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                data = message.get("bytes")
                if not data:
                    continue
                for event in segmenter.push(data):
                    if isinstance(event, SpeechStart):
                        out.put_nowait({"type": "speech_start", "t": round(event.t, 3)})
                    else:
                        out.put_nowait({"type": "speech_end", "t": round(event.t_end, 3)})
                        segments.put_nowait(event)
        except WebSocketDisconnect:
            pass
        finally:
            clients -= 1
            send_task.cancel()
            work_task.cancel()

    return app
