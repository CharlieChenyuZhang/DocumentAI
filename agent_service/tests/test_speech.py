from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
from fastapi import HTTPException
from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AuthenticationError,
    RateLimitError,
)
from starlette.requests import Request

from agent_service import speech
from agent_service.app import create_app
from agent_service.config import Settings

HEADERS = {
    "Authorization": "Bearer test-private-token",
    "x-documentai-owner": "session:alice",
}


@pytest_asyncio.fixture
async def narration(monkeypatch, tmp_path):
    state = SimpleNamespace(
        calls=[],
        clients=[],
        chunks=[b"ID3", b"mp3-audio"],
        error=None,
        closed=0,
        wait=False,
        cancelled=False,
    )

    class AudioStream:
        async def __aenter__(self):
            if state.error:
                raise state.error
            return self

        async def __aexit__(self, *_):
            state.closed += 1

        async def iter_bytes(self, *, chunk_size):
            assert chunk_size == 64 * 1024
            if state.wait:
                try:
                    await asyncio.Event().wait()
                finally:
                    state.cancelled = True
            for chunk in state.chunks:
                yield chunk

    class Client:
        def __init__(self, **kwargs):
            state.clients.append(kwargs)
            self.audio = SimpleNamespace(
                speech=SimpleNamespace(
                    with_streaming_response=SimpleNamespace(create=self.create)
                )
            )

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        def create(self, **kwargs):
            state.calls.append(kwargs)
            return AudioStream()

    monkeypatch.setattr(speech, "AsyncOpenAI", Client)
    settings = Settings(
        service_token="test-private-token",
        openai_api_key="private-test-key",
        speech_model="test-speech-model",
        speech_voice="cedar",
        data_dir=tmp_path,
    )
    # Read aloud is available without requiring a Pinecone/RAG configuration.
    app = create_app(settings)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client, state, settings


@pytest.mark.asyncio
async def test_narration_uses_private_config_and_returns_uncached_mp3(narration):
    client, state, settings = narration
    response = await client.post(
        "/speech", headers=HEADERS, json={"text": "  你好。Here is the answer.  "}
    )
    assert response.status_code == 200
    assert response.content == b"ID3mp3-audio"
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert state.calls == [
        {
            "model": settings.speech_model,
            "voice": settings.speech_voice,
            "input": "你好。Here is the answer.",
            "instructions": speech.NARRATION_INSTRUCTIONS,
            "response_format": "mp3",
        }
    ]
    assert state.clients == [
        {"api_key": "private-test-key", "timeout": 60, "max_retries": 0}
    ]
    assert state.closed == 1


@pytest.mark.asyncio
async def test_narration_authenticates_before_processing_text(narration):
    client, state, _ = narration
    for headers in (
        {},
        {"Authorization": "Bearer wrong"},
        {"Authorization": HEADERS["Authorization"]},
    ):
        response = await client.post("/speech", headers=headers, json={"text": "Hello"})
        assert response.status_code == 401
    assert not state.calls


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload,fragment",
    [
        ({"text": "   "}, "no text"),
        ({"text": "x" * 3001}, "3000 characters"),
        ({"text": 42}, "only the text"),
        ({"text": None}, "only the text"),
        ({"text": "Hello", "voice": "untrusted"}, "only the text"),
        ({"text": "Hello", "model": "untrusted"}, "only the text"),
        ({"text": "Hello", "owner": "session:bob"}, "only the text"),
        ([], "only the text"),
        ({}, "only the text"),
    ],
)
async def test_invalid_narration_payload_is_not_forwarded(narration, payload, fragment):
    client, state, _ = narration
    response = await client.post("/speech", headers=HEADERS, json=payload)
    assert response.status_code == 400
    assert fragment in response.json()["detail"]
    assert not state.calls


@pytest.mark.asyncio
async def test_narration_accepts_3000_unicode_characters(narration):
    client, state, _ = narration
    text = "😀" * 3000
    response = await client.post(
        "/speech",
        headers={**HEADERS, "content-type": "application/json; charset=utf-8"},
        content=json.dumps({"text": text}, ensure_ascii=False).encode(),
    )
    assert response.status_code == 200
    assert state.calls[0]["input"] == text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "content,content_type,expected",
    [
        (b'{"text":"Hello"}', "text/plain", 415),
        (b"invalid-json", "application/json", 400),
        (b'{"text":"\\ud800"}', "application/json", 400),
        (b'{"text":"\xff"}', "application/json", 400),
    ],
)
async def test_narration_rejects_unreadable_requests(
    narration, content, content_type, expected
):
    client, state, _ = narration
    response = await client.post(
        "/speech", headers={**HEADERS, "content-type": content_type}, content=content
    )
    assert response.status_code == expected
    assert not state.calls


@pytest.mark.asyncio
async def test_narration_rejects_large_and_chunked_requests_before_json(
    narration, monkeypatch
):
    client, state, _ = narration

    async def forbidden_json(*_, **__):
        pytest.fail("Oversized requests must fail before JSON parsing")

    monkeypatch.setattr(Request, "json", forbidden_json)
    response = await client.post(
        "/speech", headers=HEADERS, content=b"x" * (speech.MAX_SPEECH_REQUEST_BYTES + 1)
    )
    assert response.status_code == 413

    async def chunks():
        yield b"x" * speech.MAX_SPEECH_REQUEST_BYTES
        yield b"x"

    response = await client.post(
        "/speech", headers={**HEADERS, "content-length": "1"}, content=chunks()
    )
    assert response.status_code == 413
    assert not state.calls


@pytest.mark.asyncio
async def test_narration_bounds_audio_while_reading_and_closes_stream(
    narration, monkeypatch
):
    client, state, _ = narration
    monkeypatch.setattr(speech, "MAX_SPEECH_AUDIO_BYTES", 8)
    state.chunks = [b"12345678", b"9"]
    response = await client.post("/speech", headers=HEADERS, json={"text": "Hello"})
    assert response.status_code == 502
    assert "too large" in response.json()["detail"]
    assert state.closed == 1
    state.chunks = []
    response = await client.post("/speech", headers=HEADERS, json={"text": "Hello"})
    assert response.status_code == 502
    assert "no audio" in response.json()["detail"]
    assert state.closed == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,expected,fragment",
    [
        (401, 503, "API key"),
        (403, 503, "model or voice"),
        (404, 503, "model or voice"),
        (400, 503, "model or voice"),
        (429, 429, "quota"),
        (500, 503, "temporarily unavailable"),
    ],
)
async def test_narration_provider_errors_are_sanitized(
    narration, status, expected, fragment
):
    client, state, _ = narration
    request = httpx.Request("POST", "https://api.openai.com/v1/audio/speech")
    response = httpx.Response(status, request=request)
    error_class = (
        AuthenticationError
        if status == 401
        else RateLimitError
        if status == 429
        else APIStatusError
    )
    state.error = error_class(
        "private-test-key private answer",
        response=response,
        body={"debug": "private-test-key"},
    )
    result = await client.post("/speech", headers=HEADERS, json={"text": "Hello"})
    assert result.status_code == expected
    assert fragment in result.json()["detail"]
    assert "private-test-key" not in result.text and "private answer" not in result.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind,expected", [("timeout", 504), ("network", 503), ("unexpected", 503)]
)
async def test_narration_timeout_and_network_errors_are_safe(narration, kind, expected):
    client, state, _ = narration
    request = httpx.Request("POST", "https://api.openai.com/v1/audio/speech")
    state.error = (
        APITimeoutError(request=request)
        if kind == "timeout"
        else APIConnectionError(request=request)
        if kind == "network"
        else RuntimeError("private-test-key")
    )
    result = await client.post("/speech", headers=HEADERS, json={"text": "Hello"})
    assert result.status_code == expected
    assert "private-test-key" not in result.text


@pytest.mark.asyncio
async def test_narration_total_timeout_cancels_and_closes_audio_stream(
    narration, monkeypatch
):
    client, state, _ = narration
    monkeypatch.setattr(speech, "SPEECH_TIMEOUT", 0.01)
    state.wait = True
    response = await asyncio.wait_for(
        client.post("/speech", headers=HEADERS, json={"text": "Hello"}), 1
    )
    assert response.status_code == 504
    assert state.cancelled and state.closed == 1


@pytest.mark.asyncio
async def test_narration_disconnect_cancels_provider(monkeypatch):
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def slow_provider(*_):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    async def read_text(_):
        return "Hello"

    async def receive():
        await started.wait()
        return {"type": "http.disconnect"}

    monkeypatch.setattr(speech, "read_speech_text", read_text)
    monkeypatch.setattr(speech, "synthesize_speech", slow_provider)
    request = Request({"type": "http", "headers": []}, receive)
    with pytest.raises(HTTPException) as error:
        await asyncio.wait_for(speech.speak_request(request, Settings()), 1)
    assert error.value.status_code == 499
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_narration_missing_key_does_not_construct_openai_client(monkeypatch):
    def forbidden_client(**_):
        pytest.fail("Missing credentials must fail before constructing client")

    monkeypatch.setattr(speech, "AsyncOpenAI", forbidden_client)
    with pytest.raises(HTTPException) as error:
        await speech.synthesize_speech(Settings(), "Hello")
    assert error.value.status_code == 503
    assert "OPENAI_API_KEY" in error.value.detail
