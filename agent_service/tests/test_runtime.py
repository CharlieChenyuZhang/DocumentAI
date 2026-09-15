from __future__ import annotations

import asyncio
from builtins import ExceptionGroup
from typing import Any

import pytest
from ag_ui.core import RunAgentInput, UserMessage
from google.adk.models.base_llm import BaseLlm
from google.adk.sessions import DatabaseSessionService, InMemorySessionService
from mcp.shared.exceptions import MCPError
from pydantic import Field

from agent_service.config import Settings
from agent_service.runtime import build_bridge, scoped_thread_id
from agent_service.tests.runtime_fixtures import FakeStore, FakeWebSearch, ScriptedModel


def make_input(
    owner,
    ids,
    *,
    thread="same-client-thread",
    message="m1",
    question="First question",
    web=False,
):
    return RunAgentInput(
        thread_id=thread,
        run_id=f"run-{message}",
        messages=[UserMessage(id=message, role="user", content=question)],
        tools=[],
        context=[],
        forwarded_props={},
        state={
            "user_id": owner,
            "document_ids": ids,
            "web_enabled": web,
            "temp:question": question,
        },
    )


def phase_delta(events, phase):
    for event in events:
        if event.type == "STATE_DELTA":
            fields = {item["path"]: item.get("value") for item in event.delta}
            if fields.get("/phase") == phase:
                return fields
    raise AssertionError(f"No {phase} state delta was emitted")


@pytest.mark.asyncio
async def test_multidocument_retrieval_and_requested_web(tmp_path):
    store, model, web = (
        FakeStore(tmp_path),
        ScriptedModel(search_web=True),
        FakeWebSearch(),
    )
    ids = [store.upload("alice", name, b"%PDF")["id"] for name in ("a.pdf", "b.pdf")]
    bridge = build_bridge(
        Settings(data_dir=tmp_path),
        store,
        model=model,
        session_service=InMemorySessionService(),
        web_search=web,
    )
    try:
        events = [
            event async for event in bridge.run(make_input("alice", ids, web=True))
        ]
        assert events[-1].type == "RUN_FINISHED"
        snapshots = [
            event.snapshot for event in events if event.type == "STATE_SNAPSHOT"
        ]
        assert snapshots[-1]["phase"] == "complete"
        assert snapshots[-1]["search_mode"] == "hybrid"
        assert snapshots[-1]["web_search_status"] == "complete"
        assert snapshots[-1]["web_search_reason"] is None
        searching = phase_delta(events, "searching")
        assert searching["/web_search_status"] == "searching"
        assert all(source["kind"] == "document" for source in searching["/sources"])
        assert [source["id"] for source in snapshots[-1]["sources"]] == [
            "D1",
            "D2",
            "W1",
        ]
        assert store.searches[0][:2] == ("alice", ids)
        assert web.queries == ["public market facts"]
        planner = next(
            request for request in model.requests if request.config.response_schema
        )
        assert "Revenue increased" not in str(planner)
        synthesizer = next(
            request
            for request in model.requests
            if request.config.response_schema is None
        )
        evidence = str(synthesizer.config.system_instruction)
        assert '"web_search_status": "complete"' in evidence
        assert '"id": "W1"' in evidence
    finally:
        await bridge.close()


@pytest.mark.asyncio
async def test_web_setting_overrides_model_plan(tmp_path):
    store, model, web = (
        FakeStore(tmp_path),
        ScriptedModel(search_web=True),
        FakeWebSearch(),
    )
    id = store.upload("alice", "a.pdf", b"%PDF")["id"]
    bridge = build_bridge(
        Settings(data_dir=tmp_path),
        store,
        model=model,
        session_service=InMemorySessionService(),
        web_search=web,
    )
    try:
        events = [
            event async for event in bridge.run(make_input("alice", [id], web=False))
        ]
        assert events[-1].type == "RUN_FINISHED"
        assert web.queries == []
        final = [event.snapshot for event in events if event.type == "STATE_SNAPSHOT"][
            -1
        ]
        assert final["search_mode"] == "documents"
        assert final["web_search_status"] == "disabled"
        assert final["web_search_reason"] is None
    finally:
        await bridge.close()


class EmptyWebSearch(FakeWebSearch):
    async def search(self, query, ctx):
        self.queries.append(query)
        return []


class UnavailableWebSearch(FakeWebSearch):
    async def search(self, query, ctx):
        self.queries.append(query)
        raise RuntimeError("private provider error must not reach the client")


class MCPUnavailableWebSearch(FakeWebSearch):
    async def search(self, query, ctx):
        self.queries.append(query)
        raise MCPError(-32000, "private provider error must not reach the client")


class GroupedUnavailableWebSearch(FakeWebSearch):
    async def search(self, query, ctx):
        self.queries.append(query)
        raise ExceptionGroup(
            "private provider error must not reach the client",
            [MCPError(-32000, "transport closed")],
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "model_options,web_class,status,reason,call_count",
    [
        ({"search_web": False}, FakeWebSearch, "complete", None, 1),
        ({"web_query": "   "}, FakeWebSearch, "skipped", "no_public_query", 0),
        (
            {"web_query": "", "skip_reason": "not_needed"},
            FakeWebSearch,
            "skipped",
            "not_needed",
            0,
        ),
        (
            {"planner_failures": 2},
            FakeWebSearch,
            "skipped",
            "planning_unavailable",
            0,
        ),
        ({}, EmptyWebSearch, "empty", None, 1),
        ({}, UnavailableWebSearch, "failed", None, 2),
        ({}, MCPUnavailableWebSearch, "failed", None, 2),
        ({}, GroupedUnavailableWebSearch, "failed", None, 2),
    ],
)
async def test_requested_web_reports_actual_result(
    tmp_path, model_options, web_class, status, reason, call_count
):
    store, model, web = FakeStore(tmp_path), ScriptedModel(**model_options), web_class()
    id = store.upload("alice", "CONFIDENTIAL_FILENAME.pdf", b"%PDF")["id"]
    bridge = build_bridge(
        Settings(data_dir=tmp_path),
        store,
        model=model,
        session_service=InMemorySessionService(),
        web_search=web,
    )
    try:
        events = [
            event
            async for event in bridge.run(
                make_input("alice", [id], question="Summarize my documents", web=True)
            )
        ]
        assert events[-1].type == "RUN_FINISHED"
        snapshots = [
            event.snapshot for event in events if event.type == "STATE_SNAPSHOT"
        ]
        final = snapshots[-1]
        assert final["search_mode"] == "hybrid"
        assert final["web_search_status"] == status
        assert final["web_search_reason"] == reason
        assert len(web.queries) == call_count
        assert all(query == "public market facts" for query in web.queries)
        assert phase_delta(events, "planning")["/web_search_status"] == "pending"
        assert all(source["kind"] == "document" for source in final["sources"]) == (
            status != "complete"
        )
        assert "private provider error" not in str(events)
        planner_requests = [
            request for request in model.requests if request.config.response_schema
        ]
        assert all(
            "CONFIDENTIAL_FILENAME" not in str(request) for request in planner_requests
        )
        assert all(
            "Revenue increased" not in str(request) for request in planner_requests
        )
        if status == "failed":
            assert final["warnings"] == [
                "Web search was unavailable. No web results were used."
            ]
            assert any(
                event.type == "TEXT_MESSAGE_CONTENT"
                and "Revenue increased" in event.delta
                for event in events
            )
    finally:
        await bridge.close()


@pytest.mark.asyncio
async def test_persistent_followups_reset_web_status_and_skip_reason(tmp_path):
    settings = Settings(data_dir=tmp_path)
    store, model, web = (
        FakeStore(tmp_path),
        ScriptedModel(web_query=""),
        FakeWebSearch(),
    )
    id = store.upload("alice", "a.pdf", b"%PDF")["id"]
    db = DatabaseSessionService(db_url=settings.session_url)
    bridge = build_bridge(
        settings, store, model=model, session_service=db, web_search=web
    )
    try:
        for index, (enabled, query, expected_status) in enumerate(
            [
                (True, "", "skipped"),
                (True, "public market facts", "complete"),
                (False, "", "disabled"),
            ]
        ):
            model.web_query = query
            events = [
                event
                async for event in bridge.run(
                    make_input("alice", [id], message=f"turn-{index}", web=enabled)
                )
            ]
            assert events[-1].type == "RUN_FINISHED"
            snapshots = [
                event.snapshot for event in events if event.type == "STATE_SNAPSHOT"
            ]
            planning = phase_delta(events, "planning")
            assert planning["/web_search_status"] == (
                "pending" if enabled else "disabled"
            )
            assert planning["/web_search_reason"] is None
            assert planning["/sources"] == []
            assert planning["/warnings"] == []
            assert snapshots[-1]["web_search_status"] == expected_status
            if expected_status != "skipped":
                assert snapshots[-1]["web_search_reason"] is None
        assert web.queries == ["public market facts"]
    finally:
        await bridge.close()
        await db.close()


@pytest.mark.asyncio
async def test_durable_history_survives_bridge_restart_and_owner_collision(tmp_path):
    store, settings = FakeStore(tmp_path), Settings(data_dir=tmp_path)
    alice_doc = store.upload("alice", "alice.pdf", b"%PDF")["id"]
    bob_doc = store.upload("bob", "bob.pdf", b"%PDF")["id"]
    db = DatabaseSessionService(db_url=settings.session_url)
    first_model = ScriptedModel()
    first = build_bridge(settings, store, model=first_model, session_service=db)
    try:
        assert [
            event
            async for event in first.run(
                make_input("alice", [alice_doc], question="ALICE_PRIVATE_QUESTION")
            )
        ][-1].type == "RUN_FINISHED"
    finally:
        await first.close()
        await db.close()
    second_model = ScriptedModel()
    db2 = DatabaseSessionService(db_url=settings.session_url)
    second = build_bridge(settings, store, model=second_model, session_service=db2)
    try:
        events = [
            event
            async for event in second.run(
                make_input("alice", [alice_doc], message="m2", question="Follow-up")
            )
        ]
        assert events[-1].type == "RUN_FINISHED"
        synthesis = next(
            request
            for request in second_model.requests
            if request.config.response_schema is None
        )
        assert "ALICE_PRIVATE_QUESTION" in str(synthesis.contents)
        assert "Follow-up" in str(synthesis.contents)
        second_model.requests.clear()
        events = [
            event
            async for event in second.run(
                make_input("bob", [bob_doc], question="Bob question")
            )
        ]
        assert events[-1].type == "RUN_FINISHED"
        assert all(
            "ALICE_PRIVATE_QUESTION" not in str(request)
            for request in second_model.requests
        )
        assert scoped_thread_id("alice", "x") != scoped_thread_id("bob", "x")
    finally:
        await second.close()
        await db2.close()


@pytest.mark.asyncio
async def test_retry_is_bounded_and_partial_answers_are_not_replayed(tmp_path):
    store, model = (
        FakeStore(tmp_path),
        ScriptedModel(planner_failures=2, fail_after_partial=True),
    )
    id = store.upload("alice", "a.pdf", b"%PDF")["id"]
    bridge = build_bridge(
        Settings(data_dir=tmp_path),
        store,
        model=model,
        session_service=InMemorySessionService(),
    )
    try:
        events = [event async for event in bridge.run(make_input("alice", [id]))]
        assert events[-1].type == "RUN_ERROR"
        assert "provider secret" not in str(events)
        assert (
            len(model.requests) == 3
        )  # Two planner attempts, one partially streamed answer.
        deltas = [
            event.delta for event in events if event.type == "TEXT_MESSAGE_CONTENT"
        ]
        assert deltas == ["Revenue increased "]
    finally:
        await bridge.close()


class BlockingModel(BaseLlm):
    model: str = "offline-blocking-model"
    started: Any = Field(default_factory=asyncio.Event)
    cancelled: Any = Field(default_factory=asyncio.Event)

    async def generate_content_async(self, llm_request, stream=False):
        self.started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled.set()
            raise
        yield  # pragma: no cover


@pytest.mark.asyncio
async def test_cancelling_consumer_cancels_background_model_and_releases_thread(
    tmp_path,
):
    model, store = BlockingModel(), FakeStore(tmp_path)
    id = store.upload("alice", "a.pdf", b"%PDF")["id"]
    bridge = build_bridge(
        Settings(data_dir=tmp_path),
        store,
        model=model,
        session_service=InMemorySessionService(),
    )

    async def consume():
        async for _ in bridge.run(make_input("alice", [id])):
            pass

    task = asyncio.create_task(consume())
    try:
        await asyncio.wait_for(model.started.wait(), 5)
        duplicate = [
            event
            async for event in bridge.run(make_input("alice", [id], message="other"))
        ]
        assert duplicate[-1].type == "RUN_ERROR"
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.wait_for(model.cancelled.wait(), 3)
        assert not bridge._owned_tasks
        assert not bridge._inflight_threads
    finally:
        task.cancel()
        await bridge.close()
