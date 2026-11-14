"""Optional LLM post-correction of STT text via an OpenAI-compatible endpoint.

Enabled only when VT_LLM_URL is set (base URL including /v1, e.g.
http://127.0.0.1:8080/v1 for llama-server). Any error, timeout or suspicious
output returns the input text unchanged: the glossary result is always a
valid fallback.
"""

from __future__ import annotations

import logging

import httpx

log = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "Corriges transcripciones de reconocimiento de voz en espanol. "
    "Corrige solo errores evidentes de palabras mal oidas. No cambies el sentido, "
    "no agregues ni quites contenido, no traduzcas. Devuelve unicamente el texto corregido."
)


def build_system_prompt(terms: list[str]) -> str:
    if not terms:
        return SYSTEM_PROMPT
    return f"{SYSTEM_PROMPT} Terminos conocidos que deben escribirse asi: {', '.join(terms)}."


class LlmCorrector:
    def __init__(
        self,
        base_url: str,
        *,
        model: str = "local",
        terms: list[str] | None = None,
        timeout_s: float = 0.3,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._model = model
        self._system = build_system_prompt(terms or [])
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(timeout_s))

    async def correct(self, text: str) -> str:
        if not text.strip():
            return text
        payload = {
            "model": self._model,
            "temperature": 0,
            "max_tokens": min(512, len(text) // 2 + 32),
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [
                {"role": "system", "content": self._system},
                {"role": "user", "content": text},
            ],
        }
        try:
            response = await self._client.post(self._url, json=payload)
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
        except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as exc:
            log.warning("llm post-correction skipped: %s", type(exc).__name__)
            return text
        corrected = str(content).strip()
        if not corrected or len(corrected) > 2 * len(text) + 40:
            log.warning("llm post-correction rejected: implausible output length")
            return text
        return corrected

    async def aclose(self) -> None:
        await self._client.aclose()
