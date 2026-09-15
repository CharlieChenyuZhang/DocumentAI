"""Deterministic adapters used only by tests and the local integration fixture."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import Field

from agent_service.document_store import DocumentAccessError


class ScriptedModel(BaseLlm):
    model: str = "offline-test-model"
    search_web: bool = False
    web_query: str = "public market facts"
    skip_reason: str = "no_public_query"
    requests: list[Any] = Field(default_factory=list)
    planner_failures: int = 0
    synthesis_failures: int = 0
    fail_after_partial: bool = False

    async def generate_content_async(self, llm_request, stream=False):
        self.requests.append(llm_request.model_copy(deep=True))
        if llm_request.config.response_schema is not None:
            if self.planner_failures:
                self.planner_failures -= 1
                raise RuntimeError("Offline planner failure")
            text = json.dumps(
                {
                    "search_web": self.search_web,
                    "web_query": self.web_query,
                    "skip_reason": self.skip_reason,
                }
            )
            yield LlmResponse(
                content=types.Content(role="model", parts=[types.Part(text=text)]),
                partial=False,
            )
            return
        if self.synthesis_failures:
            self.synthesis_failures -= 1
            raise RuntimeError("Offline synthesis failure")
        for text in ("Revenue increased ", "by 20%. [D1]"):
            yield LlmResponse(
                content=types.Content(role="model", parts=[types.Part(text=text)]),
                partial=True,
            )
            if self.fail_after_partial:
                raise RuntimeError("provider secret must never be returned")
        yield LlmResponse(
            content=types.Content(
                role="model", parts=[types.Part(text="Revenue increased by 20%. [D1]")]
            ),
            partial=False,
            turn_complete=True,
            finish_reason=types.FinishReason.STOP,
        )


class FakeStore:
    def __init__(self, path: Path):
        self.path = path
        self.docs: dict[str, tuple[str, dict[str, Any], bytes]] = {}
        self.searches = []

    def upload(self, owner, filename, data):
        doc = {
            "id": str(uuid.uuid4()),
            "name": filename,
            "size": len(data),
            "pages": 1,
            "chunks": 1,
            "status": "ready",
            "created_at": "2026-09-14T00:00:00Z",
        }
        self.docs[doc["id"]] = (owner, doc, data)
        return doc

    def list_documents(self, owner):
        return [doc for who, doc, _ in self.docs.values() if who == owner]

    def validate_documents(self, owner, ids):
        if any(id not in self.docs or self.docs[id][0] != owner for id in ids):
            raise DocumentAccessError("Document not found.")
        return [self.docs[id][1] for id in ids]

    def search(self, owner, ids, query):
        self.validate_documents(owner, ids)
        self.searches.append((owner, ids, query))
        return [
            {
                "document_id": id,
                "document_name": self.docs[id][1]["name"],
                "page": 1,
                "text": "Revenue increased by 20%.",
                "score": 0.9,
            }
            for id in ids
        ]

    def delete_document(self, owner, id):
        self.validate_documents(owner, [id])
        del self.docs[id]

    def get_document_path(self, owner, id):
        self.validate_documents(owner, [id])
        self.path.mkdir(parents=True, exist_ok=True)
        path = self.path / f"{id}.pdf"
        path.write_bytes(self.docs[id][2])
        return path


class FakeWebSearch:
    def __init__(self):
        self.queries = []

    async def search(self, query, ctx):
        self.queries.append(query)
        return [
            {
                "title": "Market report",
                "url": "https://example.com/report",
                "text": "Public market data.",
            }
        ]
