"""Deterministic post-correction of STT text against a user glossary.

Matching is case- and accent-insensitive on word n-grams (up to 3 words), with
spaces removed before comparing, so "voice talk" matches "VoiceTalk". Exact
matches (the term or a listed mis-hearing) always apply. Fuzzy matches apply
only to keys of at least `min_fuzzy_len` characters and similarity >= threshold.
"""

from __future__ import annotations

import difflib
import re
import tomllib
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

_WORD = re.compile(r"\w+")
_MAX_NGRAM = 3


def _key(text: str) -> str:
    """Lowercase, strip accents, keep only letters and digits."""
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return "".join(c for c in stripped.casefold() if c.isalnum())


@dataclass(frozen=True)
class _Entry:
    canonical: str
    key: str


@dataclass
class Glossary:
    entries: dict[str, _Entry] = field(default_factory=dict)  # key -> entry
    fuzzy_threshold: float = 0.85
    min_fuzzy_len: int = 5

    @classmethod
    def from_toml(cls, path: Path) -> Glossary:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
        glossary = cls(
            fuzzy_threshold=float(data.get("fuzzy_threshold", 0.85)),
            min_fuzzy_len=int(data.get("min_fuzzy_len", 5)),
        )
        for item in data.get("terms", []):
            term = str(item["term"])
            glossary.add(term, [str(m) for m in item.get("misheard", [])])
        return glossary

    def add(self, term: str, misheard: list[str]) -> None:
        entry = _Entry(canonical=term, key=_key(term))
        self.entries.setdefault(entry.key, entry)
        for form in misheard:
            self.entries.setdefault(_key(form), entry)

    def correct(self, text: str) -> str:
        if not text or not self.entries:
            return text
        words = list(_WORD.finditer(text))
        out: list[str] = []
        cursor = 0  # char offset in `text` already copied to `out`
        i = 0
        while i < len(words):
            match = self._match_at(words, i)
            if match is None:
                i += 1
                continue
            entry, last = match
            out.append(text[cursor : words[i].start()])
            out.append(entry.canonical)
            cursor = words[last].end()
            i = last + 1
        out.append(text[cursor:])
        return "".join(out)

    def _match_at(self, words: list[re.Match[str]], i: int) -> tuple[_Entry, int] | None:
        # Longest span first, so "voice talk" wins over a shorter overlap.
        for n in range(min(_MAX_NGRAM, len(words) - i), 0, -1):
            last = i + n - 1
            key = _key(" ".join(w.group(0) for w in words[i : last + 1]))
            if not key:
                continue
            exact = self.entries.get(key)
            if exact is not None:
                return exact, last
            # Fuzzy only on single words: joined n-grams fuzzy-match across word
            # boundary ("y voicetalk" ~ "voicetalk"). Multi-word forms must be listed.
            if n > 1 or len(key) < self.min_fuzzy_len:
                continue
            best = self._best_fuzzy(key)
            if best is not None:
                return best, last
        return None

    def _best_fuzzy(self, key: str) -> _Entry | None:
        best: _Entry | None = None
        best_score = self.fuzzy_threshold
        for candidate_key, entry in self.entries.items():
            if abs(len(candidate_key) - len(key)) > 1:  # keeps "cartesiano" from matching "cartesia"
                continue
            if len(candidate_key) < self.min_fuzzy_len:
                continue
            score = difflib.SequenceMatcher(None, key, candidate_key).ratio()
            if score >= best_score:
                best, best_score = entry, score
        return best
