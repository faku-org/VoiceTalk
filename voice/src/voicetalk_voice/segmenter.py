"""Turns a PCM stream into speech_start / speech_end segments.

Input: arbitrary-sized chunks of pcm_s16le mono 16 kHz. Internally the stream is
cut into fixed 512-sample frames (32 ms), which is what Silero VAD needs. Audio
is kept only in memory, for the current speech segment, and dropped once the
segment has been emitted. Nothing is written to disk.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Protocol

import numpy as np

SAMPLE_RATE = 16_000
FRAME_SAMPLES = 512
PRE_ROLL_FRAMES = 10  # ~320 ms kept before a detected onset


class Detector(Protocol):
    def feed(self, frame: np.ndarray) -> list[tuple[str, int]]:
        """Feed one FRAME_SAMPLES float32 frame. Return ("start"|"end", sample_index) events."""
        ...


@dataclass(frozen=True)
class SpeechStart:
    t: float


@dataclass(frozen=True)
class SpeechEnd:
    t_start: float
    t_end: float
    audio: np.ndarray  # float32 mono 16 kHz, this segment only


SegmenterEvent = SpeechStart | SpeechEnd


class Segmenter:
    def __init__(self, detector: Detector) -> None:
        self._detector = detector
        self._pending = b""  # odd trailing byte between pushes
        self._buffer = np.zeros(0, dtype=np.float32)  # samples not yet framed
        self._pre_roll: deque[np.ndarray] = deque(maxlen=PRE_ROLL_FRAMES)
        self._in_speech = False
        self._segment: list[np.ndarray] = []
        self._t_start = 0.0

    def push(self, data: bytes) -> list[SegmenterEvent]:
        data = self._pending + data
        usable = len(data) - (len(data) % 2)
        self._pending = data[usable:]
        samples = np.frombuffer(data[:usable], dtype="<i2").astype(np.float32) / 32768.0
        self._buffer = np.concatenate([self._buffer, samples])

        events: list[SegmenterEvent] = []
        while len(self._buffer) >= FRAME_SAMPLES:
            frame = self._buffer[:FRAME_SAMPLES]
            self._buffer = self._buffer[FRAME_SAMPLES:]
            events.extend(self._process_frame(frame))
        return events

    def _process_frame(self, frame: np.ndarray) -> list[SegmenterEvent]:
        events: list[SegmenterEvent] = []
        detected = self._detector.feed(frame)
        starts = [s for kind, s in detected if kind == "start"]
        ends = [s for kind, s in detected if kind == "end"]

        if starts and not self._in_speech:
            self._in_speech = True
            self._t_start = starts[0] / SAMPLE_RATE
            self._segment = list(self._pre_roll)
            events.append(SpeechStart(t=self._t_start))
        if self._in_speech:
            self._segment.append(frame)
        if ends and self._in_speech:
            t_end = ends[-1] / SAMPLE_RATE
            audio = np.concatenate(self._segment) if self._segment else np.zeros(0, np.float32)
            events.append(SpeechEnd(t_start=self._t_start, t_end=t_end, audio=audio))
            self._in_speech = False
            self._segment = []
        self._pre_roll.append(frame)
        return events
