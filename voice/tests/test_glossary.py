from pathlib import Path

import pytest

from voicetalk_voice.glossary import Glossary

GLOSSARY_PATH = Path(__file__).resolve().parents[1] / "glossary.toml"


@pytest.fixture(scope="module")
def glossary() -> Glossary:
    return Glossary.from_toml(GLOSSARY_PATH)


@pytest.mark.parametrize(
    ("heard", "expected"),
    [
        # exact term, any casing
        ("abri VoiceTalk y voicetalk", "abri VoiceTalk y VoiceTalk"),
        # listed mis-hearing, multi-word
        ("hola voice talk", "hola VoiceTalk"),
        ("usamos carte sia hoy", "usamos Cartesia hoy"),
        # accent-insensitive
        ("Cartesía sonó bien", "Cartesia sonó bien"),
        # fuzzy: one letter off, length diff <= 1
        ("usamos Cartesi en el TTS", "usamos Cartesia en el TTS"),
        ("Tenemos WeFaver listo", "Tenemos WeFaber listo"),
        ("VoiceTalks sin errores", "VoiceTalk sin errores"),
        # short terms only match exactly (LFM is 3 chars, no fuzzy)
        ("lfm corre local", "LFM corre local"),
        ("el lfn corre", "el lfn corre"),
        # word boundary: no partial replacement inside a longer word
        ("Cartesiano es otra cosa", "Cartesiano es otra cosa"),
        # unrelated Spanish words of similar shape stay
        ("tauro y carta", "tauro y carta"),
        # listed short-ish mis-hearing
        ("la tory en la app", "la Tauri en la app"),
        # idempotent on already-correct text
        ("VoiceTalk con Cartesia y LFM", "VoiceTalk con Cartesia y LFM"),
        ("", ""),
    ],
)
def test_correct(glossary: Glossary, heard: str, expected: str) -> None:
    assert glossary.correct(heard) == expected


def test_longest_span_wins() -> None:
    glossary = Glossary()
    glossary.add("VoiceTalk", ["voice talk"])
    glossary.add("Voice", [])
    assert glossary.correct("voice talk ya") == "VoiceTalk ya"


def test_punctuation_and_spacing_preserved(glossary: Glossary) -> None:
    assert glossary.correct("¿Probás cartecia, ¿no?  ") == "¿Probás Cartesia, ¿no?  "
