from __future__ import annotations

import asyncio
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

from agent_service import transcription
from agent_service.app import create_app
from agent_service.config import Settings

HEADERS = {
    "Authorization": "Bearer test-private-token",
    "x-documentai-owner": "session:alice",
}


@pytest_asyncio.fixture
async def voice(monkeypatch, tmp_path):
    state = SimpleNamespace(
        calls=[], clients=[], text="  请比较 both reports.  ", error=None
    )

    class Client:
        def __init__(self, **kwargs):
            state.clients.append(kwargs)
            self.audio = SimpleNamespace(
                transcriptions=SimpleNamespace(create=self.create)
            )

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        async def create(self, **kwargs):
            state.calls.append(kwargs)
            if state.error:
                raise state.error
            return SimpleNamespace(text=state.text)

    monkeypatch.setattr(transcription, "AsyncOpenAI", Client)
    settings = Settings(
        service_token="test-private-token",
        openai_api_key="private-test-key",
        transcription_model="test-transcription-model",
        data_dir=tmp_path,
    )
    # Transcription only requires the server key, independently of RAG setup.
    app = create_app(settings)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client, state, settings


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mime",
    ["audio/webm;codecs=opus", "audio/mp4", "audio/wav", "audio/mpeg", "audio/ogg"],
)
async def test_transcription_uses_private_config_and_normalized_audio(voice, mime):
    client, state, settings = voice
    response = await client.post(
        "/transcriptions",
        headers=HEADERS,
        files={"file": ("private-original-name", b"audio-bytes", mime)},
    )
    assert response.status_code == 200
    assert response.json() == {"text": "请比较 both reports."}
    assert response.headers["cache-control"] == "private, no-store"
    assert state.calls[0]["model"] == settings.transcription_model
    assert state.calls[0]["response_format"] == "json"
    assert "language" not in state.calls[0] and "prompt" not in state.calls[0]
    filename, data, content_type = state.calls[0]["file"]
    assert filename.startswith("recording.") and "private" not in filename
    assert data == b"audio-bytes" and content_type == mime.split(";")[0]
    assert state.clients == [
        {"api_key": "private-test-key", "timeout": 60, "max_retries": 0}
    ]


@pytest.mark.asyncio
async def test_transcription_rejects_unauthorized_before_reading_audio(voice):
    client, state, _ = voice
    for headers in (
        {},
        {"Authorization": "Bearer wrong"},
        {"Authorization": HEADERS["Authorization"]},
    ):
        response = await client.post(
            "/transcriptions", headers=headers, content=b"audio"
        )
        assert response.status_code == 401
    assert not state.calls


@pytest.mark.asyncio
async def test_transcription_bounds_file_and_chunked_request_before_parser(
    voice, monkeypatch
):
    client, state, _ = voice
    too_big = b"x" * (transcription.MAX_AUDIO_BYTES + 1)
    response = await client.post(
        "/transcriptions",
        headers=HEADERS,
        files={"file": ("x.wav", too_big, "audio/wav")},
    )
    assert response.status_code == 413

    def forbidden_parser(*_, **__):
        pytest.fail("Oversized request must be rejected before multipart parsing")

    monkeypatch.setattr(transcription, "MemoryAudioParser", forbidden_parser)

    async def chunks():
        yield b"x" * transcription.MAX_AUDIO_REQUEST_BYTES
        yield b"x"

    response = await client.post(
        "/transcriptions",
        headers={
            **HEADERS,
            "content-type": "multipart/form-data; boundary=x",
            "content-length": "1",
        },
        content=chunks(),
    )
    assert response.status_code == 413
    assert not state.calls


@pytest.mark.asyncio
async def test_large_recording_never_spools_to_disk(voice, monkeypatch):
    client, _, _ = voice
    original = transcription.MemoryAudioParser.parse
    inspected = []

    async def inspect_memory(parser):
        form = await original(parser)
        inspected.append(form["file"].file._rolled)
        return form

    monkeypatch.setattr(transcription.MemoryAudioParser, "parse", inspect_memory)
    response = await client.post(
        "/transcriptions",
        headers=HEADERS,
        files={"file": ("x.wav", b"x" * (2 * 1024 * 1024), "audio/wav")},
    )
    assert response.status_code == 200
    assert inspected == [False]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "files,expected",
    [
        ({"file": ("x.txt", b"audio", "text/plain")}, 415),
        ({"file": ("x.wav", b"", "audio/wav")}, 400),
        ({"wrong": ("x.wav", b"audio", "audio/wav")}, 400),
        (
            [
                ("file", ("a.wav", b"a", "audio/wav")),
                ("file", ("b.wav", b"b", "audio/wav")),
            ],
            400,
        ),
    ],
)
async def test_rejects_invalid_recording_without_provider_call(voice, files, expected):
    client, state, _ = voice
    response = await client.post("/transcriptions", headers=HEADERS, files=files)
    assert response.status_code == expected
    assert not state.calls


@pytest.mark.asyncio
async def test_ignores_no_user_controlled_model_or_identity(voice):
    client, state, _ = voice
    response = await client.post(
        "/transcriptions",
        headers=HEADERS,
        files={"file": ("x.wav", b"audio", "audio/wav")},
        data={"model": "untrusted-model"},
    )
    assert response.status_code == 400
    assert not state.calls


@pytest.mark.asyncio
async def test_rejects_nonmultipart_and_malformed_recording(voice):
    client, state, _ = voice
    for content_type, expected in (
        ("application/json", 415),
        ("multipart/form-data", 400),
        ("multipart/form-data; boundary=x", 400),
    ):
        response = await client.post(
            "/transcriptions",
            headers={**HEADERS, "content-type": content_type},
            content=b"not multipart",
        )
        assert response.status_code == expected
        assert "not multipart" not in response.text
    assert not state.calls


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,expected,fragment",
    [
        (401, 503, "API key"),
        (403, 503, "model is unavailable"),
        (404, 503, "model is unavailable"),
        (429, 429, "quota"),
        (400, 400, "record again"),
        (500, 503, "temporarily unavailable"),
    ],
)
async def test_provider_errors_never_expose_diagnostics(
    voice, status, expected, fragment
):
    client, state, _ = voice
    request = httpx.Request("POST", "https://api.openai.com/v1/audio/transcriptions")
    response = httpx.Response(status, request=request)
    error_class = (
        AuthenticationError
        if status == 401
        else RateLimitError
        if status == 429
        else APIStatusError
    )
    state.error = error_class(
        "private-test-key private audio",
        response=response,
        body={"debug": "private-test-key"},
    )
    result = await client.post(
        "/transcriptions",
        headers=HEADERS,
        files={"file": ("x.wav", b"audio", "audio/wav")},
    )
    assert result.status_code == expected
    assert fragment in result.json()["detail"]
    assert "private-test-key" not in result.text and "private audio" not in result.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind,expected", [("timeout", 504), ("network", 503), ("unexpected", 503)]
)
async def test_timeout_and_network_errors_are_actionable(voice, kind, expected):
    client, state, _ = voice
    request = httpx.Request("POST", "https://api.openai.com/v1/audio/transcriptions")
    state.error = (
        APITimeoutError(request=request)
        if kind == "timeout"
        else APIConnectionError(request=request)
        if kind == "network"
        else RuntimeError("private-test-key")
    )
    result = await client.post(
        "/transcriptions",
        headers=HEADERS,
        files={"file": ("x.wav", b"audio", "audio/wav")},
    )
    assert result.status_code == expected
    assert "private-test-key" not in result.text


@pytest.mark.asyncio
async def test_empty_transcript_and_invalid_provider_result(voice):
    client, state, _ = voice
    for text, expected in (("  ", 200), (None, 502), ("x" * 8001, 400)):
        state.text = text
        response = await client.post(
            "/transcriptions",
            headers=HEADERS,
            files={"file": ("x.wav", b"audio", "audio/wav")},
        )
        assert response.status_code == expected
        if expected == 200:
            assert response.json() == {"text": ""}


@pytest.mark.asyncio
async def test_browser_disconnect_cancels_provider_task(monkeypatch):
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def slow_provider(*_):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    async def read_audio(_):
        return b"audio", "audio/wav", "recording.wav"

    async def receive():
        await started.wait()
        return {"type": "http.disconnect"}

    monkeypatch.setattr(transcription, "read_recording", read_audio)
    monkeypatch.setattr(transcription, "transcribe_recording", slow_provider)
    request = Request({"type": "http", "headers": []}, receive)
    with pytest.raises(HTTPException) as error:
        await asyncio.wait_for(transcription.transcribe_request(request, Settings()), 1)
    assert error.value.status_code == 499
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_missing_key_fails_without_constructing_openai_client(monkeypatch):
    def forbidden_client(**_):
        pytest.fail("Missing credential must fail before constructing client")

    monkeypatch.setattr(transcription, "AsyncOpenAI", forbidden_client)
    with pytest.raises(HTTPException) as error:
        await transcription.transcribe_recording(
            Settings(), b"audio", "audio/wav", "x.wav"
        )
    assert error.value.status_code == 503
    assert "OPENAI_API_KEY" in error.value.detail
