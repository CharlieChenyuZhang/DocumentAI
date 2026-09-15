"""Offline integration fixture. Never selected by production configuration.

Run: .venv/bin/python -m uvicorn agent_service.tests.fixture_server:app --port 8011
Set Next's AGENT_SERVICE_URL=http://127.0.0.1:8011 and use the token below.
"""

import asyncio
import tempfile
from pathlib import Path

from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import DatabaseSessionService
from google.genai import types

from agent_service.app import create_app
from agent_service.config import Settings
from agent_service.runtime import build_bridge
from agent_service.tests.runtime_fixtures import FakeStore, FakeWebSearch, ScriptedModel


class CancellableFixtureModel(ScriptedModel):
    """Block only an explicit current question so transport cancellation is observable."""

    cancelled_runs: int = 0

    async def generate_content_async(self, llm_request, stream=False):
        latest_question = ""
        for content in reversed(llm_request.contents):
            if content.role == "user":
                text = "".join(part.text or "" for part in content.parts or [])
                # ADK represents sibling-agent tool events as quoted user-role
                # transcripts after the actual question. They are not user input.
                if text.startswith(
                    "For context: below is a transcript of what another agent did,"
                ):
                    continue
                if text.strip():
                    latest_question = text.strip()
                    break
        if (
            llm_request.config.response_schema is None
            and latest_question == "WAIT_FOR_CANCEL"
        ):
            yield LlmResponse(
                content=types.Content(
                    role="model", parts=[types.Part(text="Waiting for cancellation")]
                ),
                partial=True,
            )
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                self.cancelled_runs += 1
                raise
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[types.Part(text="Waiting for cancellation timed out.")],
                ),
                partial=False,
                turn_complete=True,
                finish_reason=types.FinishReason.STOP,
            )
            return
        async for event in super().generate_content_async(llm_request, stream):
            yield event


settings = Settings(
    service_token="documentai-integration-test-token",
    openai_api_key="offline",
    serpapi_key="offline",
    pinecone_api_key="offline",
    pinecone_index_host="offline",
    data_dir=Path(tempfile.mkdtemp(prefix="documentai-integration-")),
)
store = FakeStore(settings.data_dir)
model = CancellableFixtureModel()
bridge = build_bridge(
    settings,
    store,
    model=model,
    web_search=FakeWebSearch(),
    session_service=DatabaseSessionService(db_url=settings.session_url),
)
app = create_app(settings, store=store, bridge=bridge)


@app.get("/test-observations")
async def test_observations():
    return {"cancelled_runs": model.cancelled_runs}
