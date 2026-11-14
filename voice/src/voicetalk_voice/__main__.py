"""Console entry point: `uv run --project voice voicetalk-voice --port N`. Binds 127.0.0.1 only."""

from __future__ import annotations

import argparse
import logging
from pathlib import Path

import uvicorn

from .app import Settings, create_app

HOST = "127.0.0.1"  # loopback only, no flag: the sidecar is never exposed on the network


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="voicetalk-voice", description="VoiceTalk voice sidecar")
    parser.add_argument("--port", type=int, default=8765, help="loopback port (default 8765)")
    parser.add_argument(
        "--glossary", type=Path, default=None, help="glossary TOML (default: voice/glossary.toml, or VT_GLOSSARY)"
    )
    parser.add_argument("--log-level", default="info", choices=["debug", "info", "warning", "error"])
    args = parser.parse_args(argv)

    logging.basicConfig(level=args.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    app = create_app(Settings.from_env(glossary_path=args.glossary))
    uvicorn.run(app, host=HOST, port=args.port, log_level=args.log_level, access_log=False, ws="websockets-sansio")


if __name__ == "__main__":
    main()
