"""Bounded, memory-only answer narration with server-owned credentials."""

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

from .config import Settings

MAX_SPEECH_REQUEST_BYTES = 32 * 1024
MAX_SPEECH_CHARACTERS = 3000
MAX_SPEECH_AUDIO_BYTES = 8 * 1024 * 1024
SPEECH_TIMEOUT = 60
NARRATION_INSTRUCTIONS = (
    "Read the supplied text exactly, without adding an introduction, commentary, "
    "or extra words. Use the text's original language, including natural Mandarin "
    "for Chinese passages. Speak in a warm, natural, conversational voice with "
    "clear pronunciation, gentle variation in intonation, and unhurried pacing. "
    "Pause naturally at sentence and paragraph boundaries. Avoid an exaggerated, "
    "robotic, or announcer-like delivery."
)


async def read_speech_text(request: Request) -> str:
    if (
        request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        != "application/json"
    ):
        raise HTTPException(415, "Read aloud requires a JSON text request.")
    try:
        payload = await request.json()
    except (ValueError, UnicodeError):
        raise HTTPException(400, "The read aloud request could not be read.") from None
    if (
        not isinstance(payload, dict)
        or set(payload) != {"text"}
        or not isinstance(payload["text"], str)
    ):
        raise HTTPException(400, "Include only the text to read aloud.")
    text = payload["text"].strip()
    if not text:
        raise HTTPException(400, "There is no text to read aloud.")
    if len(text) > MAX_SPEECH_CHARACTERS:
        raise HTTPException(400, "Read aloud text must be 3000 characters or fewer.")
    try:
        text.encode("utf-8")
    except UnicodeError:
        raise HTTPException(
            400, "The read aloud text contains invalid characters."
        ) from None
    return text


async def synthesize_speech(settings: Settings, text: str) -> bytes:
    if not settings.openai_api_key:
        raise HTTPException(
            503,
            "Configure OPENAI_API_KEY and restart the agent service to use read aloud.",
        )
    try:
        async with asyncio.timeout(SPEECH_TIMEOUT):
            async with AsyncOpenAI(
                api_key=settings.openai_api_key,
                timeout=SPEECH_TIMEOUT,
                max_retries=0,
            ) as client:
                async with client.audio.speech.with_streaming_response.create(
                    model=settings.speech_model,
                    voice=settings.speech_voice,
                    input=text,
                    instructions=NARRATION_INSTRUCTIONS,
                    response_format="mp3",
                ) as response:
                    audio = bytearray()
                    async for chunk in response.iter_bytes(chunk_size=64 * 1024):
                        if len(audio) + len(chunk) > MAX_SPEECH_AUDIO_BYTES:
                            raise HTTPException(
                                502,
                                "The generated audio is too large. Please try again.",
                            )
                        audio.extend(chunk)
    except HTTPException:
        raise
    except AuthenticationError:
        raise HTTPException(
            503,
            "The OpenAI API key is invalid or has been revoked. Update OPENAI_API_KEY and restart the agent service.",
        ) from None
    except RateLimitError:
        raise HTTPException(
            429,
            "Read aloud is temporarily rate limited. Check the OpenAI project quota or try again shortly.",
        ) from None
    except (APITimeoutError, TimeoutError):
        raise HTTPException(504, "Read aloud timed out. Please try again.") from None
    except APIStatusError as error:
        if error.status_code in (400, 403, 404, 422):
            raise HTTPException(
                503,
                "The speech model or voice is unavailable. Check OPENAI_TTS_MODEL, OPENAI_TTS_VOICE, and project model access, then restart the agent service.",
            ) from None
        raise HTTPException(
            503, "Read aloud is temporarily unavailable. Please try again."
        ) from None
    except APIConnectionError:
        raise HTTPException(
            503,
            "Read aloud could not connect to OpenAI. Check the agent service network and try again.",
        ) from None
    except Exception:  # noqa: BLE001 - never expose provider diagnostics or answer text.
        raise HTTPException(
            503, "Read aloud is temporarily unavailable. Please try again."
        ) from None
    if not audio:
        raise HTTPException(502, "Read aloud returned no audio. Please try again.")
    return bytes(audio)


async def speak_request(request: Request, settings: Settings) -> bytes:
    text = await read_speech_text(request)

    async def wait_for_disconnect():
        while (await request.receive())["type"] != "http.disconnect":
            pass

    speech = asyncio.create_task(synthesize_speech(settings, text))
    disconnect = asyncio.create_task(wait_for_disconnect())
    try:
        done, _ = await asyncio.wait(
            (speech, disconnect), return_when=asyncio.FIRST_COMPLETED
        )
        if disconnect in done:
            raise HTTPException(499, "Read aloud was cancelled.")
        return await speech
    finally:
        # Stopping playback aborts the private proxy connection. Cancelling the
        # SDK task closes the OpenAI stream without saving any audio to disk.
        speech.cancel()
        disconnect.cancel()
        await asyncio.gather(speech, disconnect, return_exceptions=True)
