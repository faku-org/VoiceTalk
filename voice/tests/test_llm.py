import asyncio
import json

import httpx

from voicetalk_voice.llm import LlmCorrector


def _corrector(handler) -> LlmCorrector:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return LlmCorrector("http://llm.test/v1", terms=["VoiceTalk"], client=client)


def _reply(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


def test_applies_correction_and_sends_no_thinking_flag() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = request.read().decode()
        return _reply("hola VoiceTalk")

    result = asyncio.run(_corrector(handler).correct("hola voice talk"))
    assert result == "hola VoiceTalk"
    assert seen["url"] == "http://llm.test/v1/chat/completions"
    body = json.loads(seen["body"])
    assert body["chat_template_kwargs"] == {"enable_thinking": False}
    assert "VoiceTalk" in body["messages"][0]["content"]


def test_timeout_falls_back_to_input() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    assert asyncio.run(_corrector(handler).correct("texto original")) == "texto original"


def test_http_error_falls_back_to_input() -> None:
    assert asyncio.run(_corrector(lambda r: httpx.Response(500)).correct("texto")) == "texto"


def test_malformed_reply_falls_back_to_input() -> None:
    assert asyncio.run(_corrector(lambda r: httpx.Response(200, json={})).correct("texto")) == "texto"


def test_implausibly_long_reply_is_rejected() -> None:
    result = asyncio.run(_corrector(lambda r: _reply("x" * 500)).correct("corto"))
    assert result == "corto"


def test_empty_reply_is_rejected() -> None:
    assert asyncio.run(_corrector(lambda r: _reply("   ")).correct("corto")) == "corto"
