"""A read-only MCP server for public web search. Run with python -m."""

from __future__ import annotations

import logging
import os
from urllib.parse import urlparse

import httpx
from mcp.server.mcpserver import MCPServer

# HTTPX's INFO request logs include the complete URL. SerpAPI authenticates via
# a query parameter, so keep HTTP client request/debug logs out of MCP stderr.
# Warnings and errors remain available for operational diagnosis.
mcp = MCPServer("Document AI Web Search", log_level="WARNING")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


@mcp.tool()
async def search_web(query: str) -> dict:
    """Search public web pages. Pass a public search query, never private document excerpts."""
    query = query.strip()
    if not query or len(query) > 400:
        return {
            "error": "Search queries must contain 1 to 400 characters.",
            "sources": [],
        }
    key = os.environ.get("SERPAPI_KEY", "")
    if not key:
        return {"error": "Web search is not configured.", "sources": []}
    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=False) as client:
            response = await client.get(
                "https://serpapi.com/search.json",
                params={"engine": "google", "q": query, "num": 5, "api_key": key},
            )
            response.raise_for_status()
            payload = response.json()
        if payload.get("error"):
            return {"error": "Web search is temporarily unavailable.", "sources": []}
        sources = []
        for item in payload.get("organic_results", [])[:5]:
            url = item.get("link", "")
            if not isinstance(url, str) or urlparse(url).scheme not in (
                "https",
                "http",
            ):
                continue
            sources.append(
                {
                    "title": str(item.get("title", "Web result"))[:300],
                    "url": url[:2048],
                    "text": str(item.get("snippet", ""))[:2000],
                }
            )
        return {"sources": sources}
    except (httpx.HTTPError, ValueError, TypeError):
        return {"error": "Web search is temporarily unavailable.", "sources": []}


if __name__ == "__main__":
    mcp.run(transport="stdio")
