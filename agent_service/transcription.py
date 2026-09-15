"""Bounded, memory-only voice transcription with server-owned credentials."""

from __future__ import annotations

import asyncio

from fastapi import HTTPException, Request
from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
    AuthenticationError,
    RateLimitError,
)
from python_multipart.exceptions import MultipartParseError
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from .config import Settings

MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_AUDIO_REQUEST_BYTES = MAX_AUDIO_BYTES + 64 * 1024
TRANSCRIPTION_TIMEOUT = 60
MIME_EXTENSIONS = {
    "audio/webm": "webm",
    "audio/mp4": "mp4",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mpga": "mpga",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
}


class MemoryAudioParser(MultiPartParser):
    # ServiceBoundary has already capped the complete request. Keep even the
    # largest allowed recording in memory instead of spilling it to a temp file.
    spool_max_size = MAX_AUDIO_REQUEST_BYTES + 1


async def read_recording(request: Request) -> tuple[bytes, str, str]:
    content_type = request.headers.get("content-type", "")
    if content_type.split(";", 1)[0].strip().lower() != "multipart/form-data":
        raise HTTPException(415, "Record audio using the microphone button.")
    try:
        form = await MemoryAudioParser(
            request.headers, request.stream(), max_files=1, max_fields=0
        ).parse()
    except (MultiPartException, MultipartParseError, ValueError):
        raise HTTPException(
            400, "The recording could not be read. Please record again."
        ) from None
    try:
        file = form.get("file")
        if len(form) != 1 or not isinstance(file, UploadFile):
            raise HTTPException(400, "Include one audio recording in the file field.")
        mime = (file.content_type or "").split(";", 1)[0].strip().lower()
        extension = MIME_EXTENSIONS.get(mime)
        if extension is None:
            raise HTTPException(
                415, "This audio format is not supported. Please try another browser."
            )
        data = await file.read(MAX_AUDIO_BYTES + 1)
        if len(data) > MAX_AUDIO_BYTES:
            raise HTTPException(413, "Recordings must be 8 MiB or smaller.")
        if not data:
            raise HTTPException(400, "The recording is empty. Please record again.")
        # Do not forward user-controlled filenames or any other form fields.
        return data, mime, f"recording.{extension}"
    finally:
        await form.close()


async def transcribe_recording(
    settings: Settings, data: bytes, mime: str, filename: str
) -> str:
    if not settings.openai_api_key:
        raise HTTPException(
            503,
            "Configure OPENAI_API_KEY and restart the agent service to use voice input.",
        )
    try:
        async with asyncio.timeout(TRANSCRIPTION_TIMEOUT):
            async with AsyncOpenAI(
                api_key=settings.openai_api_key,
                timeout=TRANSCRIPTION_TIMEOUT,
                max_retries=0,
            ) as client:
                result = await client.audio.transcriptions.create(
                    model=settings.transcription_model,
                    file=(filename, data, mime),
                    response_format="json",
                )
    except AuthenticationError:
        raise HTTPException(
            503,
            "The OpenAI API key is invalid or has been revoked. Update OPENAI_API_KEY and restart the agent service.",
        ) from None
    except RateLimitError:
        raise HTTPException(
            429,
            "Voice transcription is temporarily rate limited. Check the OpenAI project quota or try again shortly.",
        ) from None
    except (APITimeoutError, TimeoutError):
        raise HTTPException(
            504, "Voice transcription timed out. Try a shorter recording."
        ) from None
    except APIStatusError as error:
        if error.status_code in (403, 404):
            raise HTTPException(
                503,
                "The voice transcription model is unavailable. Check OPENAI_TRANSCRIPTION_MODEL and project model access, then restart the agent service.",
            ) from None
        if error.status_code in (400, 413, 415, 422):
            raise HTTPException(
                400, "The recording could not be transcribed. Please record again."
            ) from None
        raise HTTPException(
            503, "Voice transcription is temporarily unavailable. Please try again."
        ) from None
    except APIConnectionError:
        raise HTTPException(
            503,
            "Voice transcription could not connect to OpenAI. Check the agent service network and try again.",
        ) from None
    except Exception:  # noqa: BLE001 - never expose provider diagnostics or audio details.
        # Provider diagnostics can contain credentials or private audio details.
        raise HTTPException(
            503, "Voice transcription is temporarily unavailable. Please try again."
        ) from None
    text = getattr(result, "text", None)
    if not isinstance(text, str):
        raise HTTPException(
            502, "Voice transcription returned no text. Please record again."
        )
    if len(text.strip()) > 8000:
        raise HTTPException(
            400, "The transcript is too long. Please record a shorter question."
        )
    return text.strip()


async def transcribe_request(request: Request, settings: Settings) -> str:
    recording = await read_recording(request)

    async def wait_for_disconnect():
        while (await request.receive())["type"] != "http.disconnect":
            pass

    transcription = asyncio.create_task(transcribe_recording(settings, *recording))
    disconnect = asyncio.create_task(wait_for_disconnect())
    try:
        done, _ = await asyncio.wait(
            (transcription, disconnect), return_when=asyncio.FIRST_COMPLETED
        )
        if disconnect in done:
            raise HTTPException(499, "Voice transcription was cancelled.")
        return await transcription
    finally:
        # Browser cancellation closes the private proxy connection. Cancelling
        # the SDK task also closes its OpenAI request, even during transcription.
        transcription.cancel()
        disconnect.cancel()
        await asyncio.gather(transcription, disconnect, return_exceptions=True)
