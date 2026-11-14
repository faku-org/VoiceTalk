"""Stream a wav to a running sidecar's WS /stt and print events and latency.

Usage (sidecar already running on the same port):
  uv run --project voice python voice/scripts/ws_smoke.py <file.wav> [--port 8765] [--fast]

The wav must be pcm 16-bit mono 16 kHz. Audio is sent in 20 ms chunks, paced in
real time by default, so latencies are meaningful. --fast sends as fast as possible
(latencies are then not meaningful). A 1.5 s silence tail is appended so the last
segment closes. Nothing is written to disk.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.request
import wave
from pathlib import Path

from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect

SAMPLE_RATE = 16_000
CHUNK_MS = 20
CHUNK_BYTES = SAMPLE_RATE * 2 * CHUNK_MS // 1000
TAIL_SECONDS = 1.5


def read_pcm(path: Path) -> bytes:
    with wave.open(str(path), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != SAMPLE_RATE:
            sys.exit(f"{path}: need pcm 16-bit mono 16 kHz, got {wav.getnchannels()}ch {wav.getsampwidth()*8}bit {wav.getframerate()} Hz")
        return wav.readframes(wav.getnframes())


def wait_ready(port: int, timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    url = f"http://127.0.0.1:{port}/health"
    last = "unreachable"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                body = json.loads(resp.read())
                last = body.get("stt", "?")
                if last == "ready":
                    return
                if last == "error":
                    sys.exit("sidecar reports stt error; check its log")
        except OSError:
            pass
        time.sleep(0.5)
    sys.exit(f"stt not ready after {timeout_s:.0f}s (last: {last})")


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to cp1252
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("wav", type=Path)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--fast", action="store_true", help="send without real-time pacing")
    parser.add_argument("--wait", type=float, default=180.0, help="seconds to wait for stt ready")
    args = parser.parse_args()

    pcm = read_pcm(args.wav)
    audio_s = len(pcm) / (SAMPLE_RATE * 2)
    print(f"audio {audio_s:.2f}s, pacing={'fast' if args.fast else 'realtime'}")
    wait_ready(args.port, args.wait)

    received: list[tuple[float, dict]] = []

    with connect(f"ws://127.0.0.1:{args.port}/stt", max_size=None) as ws:

        def reader() -> None:
            try:
                while True:
                    raw = ws.recv()  # block first; stamp on arrival, not before
                    received.append((time.monotonic(), json.loads(raw)))
            except ConnectionClosed:
                pass

        threading.Thread(target=reader, daemon=True).start()

        stream = pcm + b"\x00\x00" * int(TAIL_SECONDS * SAMPLE_RATE)
        t0 = time.monotonic()
        for offset in range(0, len(stream), CHUNK_BYTES):
            ws.send(stream[offset : offset + CHUNK_BYTES])
            if not args.fast:
                due = t0 + (offset + CHUNK_BYTES) / (SAMPLE_RATE * 2)
                delay = due - time.monotonic()
                if delay > 0:
                    time.sleep(delay)

        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            starts = sum(1 for _, e in received if e["type"] == "speech_end")
            finals = sum(1 for _, e in received if e["type"] in ("final", "error"))
            if finals >= starts:
                break
            time.sleep(0.1)

    print()
    seg_rows = []
    for wall, event in received:
        kind = event["type"]
        if kind == "final":
            print(f"  final  text={event['text']!r}")
            if event["raw"] != event["text"]:
                print(f"         raw={event['raw']!r}")
            print(f"         t={event['t_start']:.2f}-{event['t_end']:.2f}s stt_ms={event['stt_ms']}")
        elif kind == "error":
            print(f"  error  {event.get('message')}")
        else:
            print(f"  {kind:<12} t={event['t']:.2f}s")
        if kind == "speech_start":
            seg_rows.append({"start_lat": wall - (t0 + event["t"])})
        elif kind == "speech_end":
            seg_rows.append({"end_wall": wall, "end_t": event["t"]})
        elif kind == "final":
            seg_rows.append({"final_lat": wall - (t0 + event["t_end"]), "stt_ms": event["stt_ms"]})

    if not args.fast:
        print("\nlatency (wall clock, realtime pacing):")
        starts = [r["start_lat"] for r in seg_rows if "start_lat" in r]
        finals = [r for r in seg_rows if "final_lat" in r]
        for i, lat in enumerate(starts):
            print(f"  segment {i + 1}: speech_start after onset {lat * 1000:.0f} ms")
        for i, row in enumerate(finals):
            print(f"  segment {i + 1}: final after speech end {row['final_lat'] * 1000:.0f} ms, stt_ms={row['stt_ms']}")
    else:
        print("\n--fast: latencies not meaningful; stt_ms per segment:")
        for row in seg_rows:
            if "stt_ms" in row:
                print(f"  stt_ms={row['stt_ms']}")


if __name__ == "__main__":
    main()
