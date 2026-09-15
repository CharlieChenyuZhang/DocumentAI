"""Real PDFs, local disk vectors and ADK; only paid providers are replaced."""

import json

import httpx
import langchain_openai
import pytest

from agent_service import runtime
from agent_service.app import create_app
from agent_service.config import Settings
from agent_service.tests.runtime_fixtures import ScriptedModel
from agent_service.tests.test_app import headers, run_input
from agent_service.tests.test_document_store import FakeEmbeddings, pdf_bytes


@pytest.mark.asyncio
async def test_local_pdf_rag_survives_restart_and_preserves_ownership(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        langchain_openai, "OpenAIEmbeddings", lambda **kwargs: FakeEmbeddings()
    )
    original_build = runtime.build_bridge
    monkeypatch.setattr(
        runtime,
        "build_bridge",
        lambda settings, store: original_build(
            settings,
            store,
            model=ScriptedModel(),
        ),
    )
    settings = Settings(
        vector_backend="local",
        data_dir=tmp_path,
        embedding_dimensions=3,
        service_token="test-service-token",
        openai_api_key="offline-test-key",
    )
    assert settings.missing == []
    ids = []
    for restart in range(2):
        app = create_app(settings)
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                health = (await client.get("/health", headers=headers())).json()
                assert health["ready"] is True
                assert health["vector_backend"] == "local"
                if not restart:
                    for name in ("first.pdf", "second.pdf"):
                        response = await client.post(
                            "/documents",
                            headers=headers(),
                            files={
                                "file": (
                                    name,
                                    pdf_bytes("Revenue increased by 20%."),
                                    "application/pdf",
                                ),
                            },
                        )
                        assert response.status_code == 201
                        ids.append(response.json()["document"]["id"])
                documents = (await client.get("/documents", headers=headers())).json()[
                    "documents"
                ]
                assert {doc["id"] for doc in documents} == set(ids)
                assert (
                    await client.get("/documents", headers=headers("session:bob"))
                ).json()["documents"] == []
                assert (
                    await client.get(
                        f"/documents/{ids[0]}", headers=headers("session:bob")
                    )
                ).status_code == 404
                assert (
                    await client.post(
                        "/run", headers=headers("session:bob"), json=run_input(ids)
                    )
                ).status_code == 404
                response = await client.post(
                    "/run",
                    headers=headers(),
                    json=run_input(ids, runId=f"run-{restart}"),
                )
                assert response.status_code == 200
                events = [
                    json.loads(line[6:])
                    for line in response.text.splitlines()
                    if line.startswith("data: ")
                ]
                assert events[-1]["type"] == "RUN_FINISHED"
                snapshot = [
                    event["snapshot"]
                    for event in events
                    if event["type"] == "STATE_SNAPSHOT"
                ][-1]
                assert snapshot["phase"] == "complete"
                assert {source["document_id"] for source in snapshot["sources"]} == set(
                    ids
                )
                if restart:
                    assert (
                        await client.delete(
                            f"/documents/{ids[0]}", headers=headers("session:bob")
                        )
                    ).status_code == 404
                    assert (
                        await client.delete(f"/documents/{ids[0]}", headers=headers())
                    ).status_code == 204
                    assert (
                        await client.get(f"/documents/{ids[0]}", headers=headers())
                    ).status_code == 404
        finally:
            await app.state.agent_bridge.close()
    assert (tmp_path / "local" / "vectors.sqlite3").is_file()
    assert (tmp_path / "local" / "documents.sqlite3").is_file()
    assert not (tmp_path / "documents.sqlite3").exists()
