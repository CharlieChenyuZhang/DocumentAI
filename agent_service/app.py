"""Private FastAPI service called only by authenticated Next.js route handlers."""

from __future__ import annotations

import asyncio
import json
import re
import secrets
from contextlib import asynccontextmanager
from typing import Annotated, Any

import anyio
from ag_ui.core import RunAgentInput
from ag_ui_adk import add_adk_fastapi_endpoint
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from starlette.datastructures import Headers

from .config import Settings
from .document_store import (
    DocumentAccessError,
    DocumentStore,
    DocumentValidationError,
    StoreConfig,
    StoreConfigurationError,
    StoreUnavailableError,
)
from .transcription import MAX_AUDIO_REQUEST_BYTES, transcribe_request

OWNER_PATTERN = re.compile(r"^[A-Za-z0-9:_-]{1,128}$")
DOCUMENT_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
MAX_FILE_BYTES = 20 * 1024 * 1024


class ServiceBoundary:
    """Authenticate every endpoint and bound input before multipart/JSON parsing."""

    def __init__(self, app, settings: Settings, get_bridge):
        self.app = app
        self.settings = settings
        self.get_bridge = get_bridge

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = Headers(scope=scope)
        configured = self.settings.service_token
        if not configured:
            return await JSONResponse(
                {"detail": "AGENT_SERVICE_TOKEN is not configured."}, 503
            )(scope, receive, send)
        supplied = headers.get("authorization", "")
        if not secrets.compare_digest(
            supplied.encode(), f"Bearer {configured}".encode()
        ):
            return await JSONResponse({"detail": "Unauthorized."}, 401)(
                scope, receive, send
            )
        owner = headers.get("x-documentai-owner", "")
        if not OWNER_PATTERN.fullmatch(owner):
            return await JSONResponse(
                {"detail": "A valid authenticated owner is required."}, 401
            )(scope, receive, send)
        scope.setdefault("state", {})["owner_id"] = owner
        limit = {
            "/documents": MAX_FILE_BYTES + 1024 * 1024,
            "/transcriptions": MAX_AUDIO_REQUEST_BYTES,
        }.get(scope["path"], 512 * 1024)
        length = headers.get("content-length")
        if length:
            try:
                if int(length) < 0 or int(length) > limit:
                    return await JSONResponse({"detail": "Request is too large."}, 413)(
                        scope, receive, send
                    )
            except ValueError:
                return await JSONResponse({"detail": "Invalid request length."}, 400)(
                    scope, receive, send
                )
        chunks = []
        total = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            total += len(chunk)
            if total > limit:
                return await JSONResponse({"detail": "Request is too large."}, 413)(
                    scope, receive, send
                )
            chunks.append(chunk)
            if not message.get("more_body"):
                break
        body = b"".join(chunks)
        consumed = False

        async def bounded_receive():
            nonlocal consumed
            if not consumed:
                consumed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        try:
            await self.app(scope, bounded_receive, send)
        finally:
            # A disconnect can occur while the SSE generator is suspended at a
            # yield, so also cancel from the ASGI request's lifecycle boundary.
            bridge = self.get_bridge()
            if scope["path"] == "/run" and bridge is not None:
                try:
                    payload = json.loads(body)
                except (ValueError, TypeError):
                    payload = {}
                if (
                    isinstance(payload, dict)
                    and isinstance(payload.get("threadId"), str)
                    and isinstance(payload.get("runId"), str)
                ):
                    with anyio.CancelScope(shield=True):
                        await bridge.cancel_run(
                            owner, payload["threadId"], payload["runId"]
                        )


def create_app(
    settings: Settings | None = None, *, store: Any = None, bridge: Any = None
) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            if bridge is not None:
                await bridge.close()

    app = FastAPI(
        title="Document AI Agent Service",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.add_middleware(
        ServiceBoundary, settings=settings, get_bridge=lambda: app.state.agent_bridge
    )
    if store is None and not settings.missing:
        store = DocumentStore(
            StoreConfig(
                data_dir=settings.storage_dir,
                vector_backend=settings.vector_backend,
                pinecone_api_key=settings.pinecone_api_key,
                pinecone_index_host=settings.pinecone_index_host,
                pinecone_index_name=settings.pinecone_index_name,
                openai_api_key=settings.openai_api_key,
                embedding_model=settings.embedding_model,
                embedding_dimensions=settings.embedding_dimensions,
                max_selected_documents=20,
            )
        )
    if bridge is None and store is not None and not settings.missing:
        from .runtime import build_bridge

        bridge = build_bridge(settings, store)
    app.state.document_store = store
    app.state.agent_bridge = bridge

    def require_store():
        if store is None:
            raise HTTPException(
                503,
                "Complete the agent service configuration before uploading or searching documents.",
            )
        return store

    for error, status in (
        (DocumentAccessError, 404),
        (DocumentValidationError, 400),
        (StoreConfigurationError, 503),
        (StoreUnavailableError, 503),
    ):

        async def store_error(_request, exc, status=status):
            return JSONResponse({"detail": str(exc)}, status)

        app.add_exception_handler(error, store_error)

    @app.get("/health")
    async def health():
        return {
            "ready": not settings.missing and bridge is not None,
            "missing": settings.missing,
            "web_search": bool(settings.serpapi_key),
            "model": settings.openai_model,
            "vector_backend": settings.vector_backend,
        }

    @app.get("/documents")
    async def documents(request: Request):
        return {
            "documents": await asyncio.to_thread(
                require_store().list_documents, request.state.owner_id
            )
        }

    @app.post("/transcriptions")
    async def transcriptions(request: Request):
        return JSONResponse(
            {"text": await transcribe_request(request, settings)},
            headers={"Cache-Control": "private, no-store"},
        )

    @app.post("/documents", status_code=201)
    async def upload_document(request: Request, file: Annotated[UploadFile, File()]):
        document_store = require_store()
        try:
            data = await file.read(MAX_FILE_BYTES + 1)
        finally:
            await file.close()
        if len(data) > MAX_FILE_BYTES:
            raise HTTPException(413, "PDF files must be 20 MiB or smaller.")
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(400, "Choose a PDF file.")
        document = await asyncio.to_thread(
            document_store.upload, request.state.owner_id, file.filename, data
        )
        return {"document": document}

    @app.get("/documents/{document_id}")
    async def open_document(document_id: str, request: Request):
        document_store = require_store()
        path = await asyncio.to_thread(
            document_store.get_document_path, request.state.owner_id, document_id
        )
        return FileResponse(
            path,
            media_type="application/pdf",
            headers={
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "sandbox",
            },
        )

    @app.delete("/documents/{document_id}", status_code=204)
    async def delete_document(document_id: str, request: Request):
        await asyncio.to_thread(
            require_store().delete_document, request.state.owner_id, document_id
        )

    async def trusted_state(
        request: Request, input_data: RunAgentInput
    ) -> dict[str, Any]:
        owner = request.state.owner_id
        if not 1 <= len(input_data.thread_id) <= 128:
            raise HTTPException(400, "Invalid conversation ID.")
        if not 1 <= len(input_data.run_id) <= 128:
            raise HTTPException(400, "Invalid request ID.")
        # Every field here can be written by a browser. Only these two are inputs.
        incoming = input_data.state if isinstance(input_data.state, dict) else {}
        ids = incoming.get("document_ids", [])
        web_enabled = incoming.get("web_enabled", False)
        if (
            not isinstance(ids, list)
            or len(ids) > 20
            or any(
                not isinstance(value, str) or not DOCUMENT_PATTERN.fullmatch(value)
                for value in ids
            )
            or len(set(ids)) != len(ids)
        ):
            raise HTTPException(400, "Select at most 20 distinct document IDs.")
        if not isinstance(web_enabled, bool):
            raise HTTPException(400, "Invalid web search setting.")
        if web_enabled and not settings.serpapi_key:
            raise HTTPException(503, "Set SERPAPI_KEY to enable web search.")
        if len(input_data.messages) > 100:
            raise HTTPException(400, "Too many messages in one request.")
        # Trusted durable ADK history supplies context. Never ingest client-authored
        # system/tool/assistant history, which could forge agent actions or tool results.
        user_messages = [
            message for message in input_data.messages if message.role == "user"
        ]
        if request.url.path == "/run":
            if not user_messages:
                raise HTTPException(400, "A user question is required.")
            latest = user_messages[-1]
            if (
                not isinstance(latest.content, str)
                or not 1 <= len(latest.content.strip()) <= 8000
            ):
                raise HTTPException(400, "Questions must contain 1 to 8000 characters.")
            if not isinstance(latest.id, str) or not 1 <= len(latest.id) <= 128:
                raise HTTPException(400, "Invalid message ID.")
            if not ids and not web_enabled:
                raise HTTPException(400, "Select a document or enable web search.")
            if ids:
                await asyncio.to_thread(require_store().validate_documents, owner, ids)
            input_data.messages = [latest]
            question = latest.content.strip()
        else:
            question = ""
            input_data.messages = []
        input_data.tools = []
        input_data.context = []
        input_data.forwarded_props = {}
        input_data.state = {}
        return {
            "user_id": owner,
            "document_ids": ids,
            "web_enabled": web_enabled,
            "temp:question": question,
            "phase": "ready",
            "sources": [],
            "warnings": [],
            "search_mode": "hybrid" if web_enabled else "documents",
            "web_search_status": "pending" if web_enabled else "disabled",
            "web_search_reason": None,
        }

    if bridge is not None:
        add_adk_fastapi_endpoint(
            app, bridge, path="/run", extract_state_from_request=trusted_state
        )
        # The app owns its chat list. The bridge's experimental history endpoint
        # bypasses run-time thread mapping, so it is intentionally not exposed.
        app.router.routes = [
            route
            for route in app.router.routes
            if getattr(route, "path", "") != "/agents/state"
        ]
    else:

        @app.post("/run")
        async def unavailable_agent():
            raise HTTPException(
                503,
                "Complete the agent service configuration before sending a question.",
            )

    return app


app = create_app()
