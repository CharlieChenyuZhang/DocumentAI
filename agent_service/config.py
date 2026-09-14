"""Server-only configuration. Secret values are never returned by health checks."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Settings:
    service_token: str = field(default="", repr=False)
    openai_api_key: str = field(default="", repr=False)
    openai_model: str = "gpt-5.6-sol"
    serpapi_key: str = field(default="", repr=False)
    pinecone_api_key: str = field(default="", repr=False)
    pinecone_index_host: str = ""
    pinecone_index_name: str = ""
    embedding_model: str = "text-embedding-3-small"
    embedding_dimensions: int = 1536
    data_dir: Path = ROOT / ".data" / "documentai"

    @classmethod
    def from_env(cls) -> Settings:
        # Only reuse these two existing credentials from the original backend.
        legacy = dotenv_values(ROOT / "server" / ".env")
        values = {
            k: v for k, v in dotenv_values(ROOT / ".env.local").items() if v is not None
        }
        values.update(os.environ)
        for key in ("OPENAI_API_KEY", "SERPAPI_KEY"):
            if not values.get(key) and legacy.get(key):
                values[key] = legacy[key]
        dimensions = int(values.get("OPENAI_EMBEDDING_DIMENSIONS", "1536"))
        if not 1 <= dimensions <= 3072:
            raise ValueError("OPENAI_EMBEDDING_DIMENSIONS must be between 1 and 3072.")
        return cls(
            service_token=values.get("AGENT_SERVICE_TOKEN", ""),
            openai_api_key=values.get("OPENAI_API_KEY", ""),
            openai_model=values.get("OPENAI_MODEL", "gpt-5.6-sol"),
            serpapi_key=values.get("SERPAPI_KEY", ""),
            pinecone_api_key=values.get("PINECONE_API_KEY", ""),
            pinecone_index_host=values.get("PINECONE_INDEX_HOST", ""),
            pinecone_index_name=values.get("PINECONE_INDEX_NAME", ""),
            embedding_model=values.get(
                "OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"
            ),
            embedding_dimensions=dimensions,
            data_dir=Path(
                values.get("DOCUMENTAI_DATA_DIR", str(ROOT / ".data" / "documentai"))
            ).resolve(),
        )

    @property
    def missing(self) -> list[str]:
        required = {
            "AGENT_SERVICE_TOKEN": self.service_token,
            "OPENAI_API_KEY": self.openai_api_key,
            "PINECONE_API_KEY": self.pinecone_api_key,
            "PINECONE_INDEX_HOST or PINECONE_INDEX_NAME": self.pinecone_index_host
            or self.pinecone_index_name,
        }
        return [name for name, value in required.items() if not value]

    @property
    def session_url(self) -> str:
        return f"sqlite+aiosqlite:///{self.data_dir / 'sessions.sqlite3'}"
