import logging

import httpx
import pytest

from agent_service import mcp_server


@pytest.mark.asyncio
async def test_search_validates_query_and_reports_missing_configuration(monkeypatch):
    monkeypatch.delenv("SERPAPI_KEY", raising=False)
    assert (await mcp_server.search_web(""))["sources"] == []
    assert "configured" in (await mcp_server.search_web("public query"))["error"]
    assert "400" in (await mcp_server.search_web("x" * 401))["error"]


@pytest.mark.asyncio
async def test_search_uses_serpapi_and_rejects_unsafe_result_urls(monkeypatch):
    monkeypatch.setenv("SERPAPI_KEY", "offline-test-key")
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "organic_results": [
                    {
                        "title": "Report",
                        "link": "https://example.com/report",
                        "snippet": "Public data",
                    },
                    {
                        "title": "Unsafe",
                        "link": "javascript:alert(1)",
                        "snippet": "Bad",
                    },
                ]
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(mcp_server.httpx, "AsyncClient", lambda **kwargs: client)
    result = await mcp_server.search_web("public facts")
    assert result == {
        "sources": [
            {
                "title": "Report",
                "url": "https://example.com/report",
                "text": "Public data",
            }
        ]
    }
    assert seen[0].url.host == "serpapi.com"
    assert seen[0].url.params["q"] == "public facts"


@pytest.mark.asyncio
async def test_search_does_not_log_credential_bearing_urls(monkeypatch, caplog):
    synthetic_key = "synthetic-serpapi-secret-not-for-logging"
    monkeypatch.setenv("SERPAPI_KEY", synthetic_key)
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"organic_results": []})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(mcp_server.httpx, "AsyncClient", lambda **kwargs: client)
    # A verbose host application must not re-enable the HTTP client's INFO
    # request line, which includes api_key in the real SerpAPI request URL.
    with caplog.at_level(logging.DEBUG):
        result = await mcp_server.search_web("public facts")
        logging.getLogger("httpcore.http11").debug(
            "Request trace for api_key=%s", synthetic_key
        )
        logging.getLogger("httpx").warning("Safe upstream warning")
        logging.getLogger("httpcore.http11").error("Safe transport error")

    assert result == {"sources": []}
    assert requests[0].url.params["api_key"] == synthetic_key
    assert synthetic_key not in caplog.text
    assert "api_key=" not in caplog.text
    assert "HTTP Request:" not in caplog.text
    assert "Safe upstream warning" in caplog.text
    assert "Safe transport error" in caplog.text
    assert mcp_server.mcp.settings.log_level == "WARNING"


@pytest.mark.asyncio
async def test_actual_mcp_stdio_adapter_handles_tool_result(tmp_path):
    from google.adk.agents import LlmAgent
    from google.adk.agents.invocation_context import InvocationContext
    from google.adk.sessions import InMemorySessionService

    from agent_service.runtime import MCPWebSearch

    sessions = InMemorySessionService()
    session = await sessions.create_session(app_name="test", user_id="alice")
    ctx = InvocationContext(
        session_service=sessions,
        session=session,
        invocation_id="test",
        agent=LlmAgent(name="test"),
    )
    # Launch the real server and invoke it through McpToolset. The deliberately
    # absent key makes this a protocol test with no provider traffic.
    with pytest.raises(RuntimeError, match="temporarily unavailable"):
        await MCPWebSearch("").search("public query", ctx)
