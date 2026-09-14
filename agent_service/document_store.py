"""Durable PDF ingestion and retrieval, scoped to a server-authenticated owner.

The caller must derive ``owner_id`` from its authenticated session. A document ID
or a client-supplied namespace is never sufficient authorization. Pinecone stores
vectors; SQLite holds the authoritative ownership and ingestion status catalog.
"""

from __future__ import annotations

import hashlib
import logging
import math
import re
import sqlite3
import time
import uuid
from collections.abc import Callable, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class StoreConfigurationError(RuntimeError):
    """Required services or compatible configuration are missing."""


class DocumentValidationError(ValueError):
    """The upload or query exceeds the supported input contract."""


class DocumentAccessError(PermissionError):
    """One or more documents are not owned by this user or are not ready."""


class StoreUnavailableError(RuntimeError):
    """A provider operation failed; raw provider details are not exposed."""


@dataclass(frozen=True)
class StoreConfig:
    data_dir: Path = Path(".data")
    pinecone_api_key: str = field(default="", repr=False)
    pinecone_index_host: str = ""
    pinecone_index_name: str = ""
    openai_api_key: str = field(default="", repr=False)
    embedding_model: str = "text-embedding-3-small"
    embedding_dimensions: int = 1536
    max_upload_bytes: int = 20 * 1024 * 1024
    max_pages: int = 200
    max_chunks: int = 2000
    max_text_characters: int = 2_000_000
    max_selected_documents: int = 50
    chunk_size: int = 1000
    chunk_overlap: int = 150
    batch_size: int = 64
    top_k: int = 8
    request_timeout: float = 30
    retry_attempts: int = 3

    def __post_init__(self) -> None:
        positive = (
            self.embedding_dimensions,
            self.max_upload_bytes,
            self.max_pages,
            self.max_chunks,
            self.max_text_characters,
            self.max_selected_documents,
            self.chunk_size,
            self.batch_size,
            self.top_k,
            self.request_timeout,
        )
        if any(value <= 0 for value in positive):
            raise StoreConfigurationError("Document-store limits must be positive.")
        if not 0 <= self.chunk_overlap < self.chunk_size:
            raise StoreConfigurationError(
                "Chunk overlap must be smaller than chunk size."
            )
        if not 1 <= self.retry_attempts <= 3 or self.batch_size > 64:
            raise StoreConfigurationError(
                "Use at most 3 attempts and 64 vectors per batch."
            )


class DocumentStore:
    """Blocking operations; async HTTP handlers should call via asyncio.to_thread.

    Provider dependencies may be injected for offline tests. Production has no
    in-memory fallback and never provisions or modifies a Pinecone index.
    """

    def __init__(
        self,
        config: StoreConfig,
        *,
        index: Any = None,
        embeddings: Any = None,
        loader_factory: Callable[[str], Any] | None = None,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        self.config = config
        self._index = index
        self._embeddings = embeddings
        self._loader_factory = loader_factory
        self._sleep = sleeper
        self._pinecone_client: Any = None
        self._index_checked = False
        self.data_dir = Path(config.data_dir).resolve()
        self.upload_dir = self.data_dir / "uploads"
        self.upload_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.catalog_path = self.data_dir / "documents.sqlite3"
        with self._db() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY,
                    owner_key TEXT NOT NULL,
                    name TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    pages INTEGER NOT NULL DEFAULT 0,
                    chunks INTEGER NOT NULL DEFAULT 0,
                    vector_chunks INTEGER NOT NULL DEFAULT 0,
                    write_lsn INTEGER,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    embedding_model TEXT NOT NULL,
                    embedding_dimensions INTEGER NOT NULL
                )
            """)
            db.execute(
                "CREATE INDEX IF NOT EXISTS document_owner ON documents(owner_key)"
            )
            columns = {
                row["name"] for row in db.execute("PRAGMA table_info(documents)")
            }
            if "write_lsn" not in columns:
                db.execute("ALTER TABLE documents ADD COLUMN write_lsn INTEGER")
        self.catalog_path.chmod(0o600)

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.catalog_path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _namespace(owner_id: str) -> str:
        if not isinstance(owner_id, str) or not owner_id.strip() or len(owner_id) > 512:
            raise DocumentAccessError("An authenticated user is required.")
        return "user-" + hashlib.sha256(owner_id.encode("utf-8")).hexdigest()

    @staticmethod
    def _public(row: sqlite3.Row) -> dict[str, Any]:
        return {
            key: row[key]
            for key in ("id", "name", "size", "pages", "chunks", "status", "created_at")
        }

    @staticmethod
    def _field(value: Any, key: str, default: Any = None) -> Any:
        return (
            value.get(key, default)
            if isinstance(value, dict)
            else getattr(value, key, default)
        )

    @staticmethod
    def _transient(error: Exception) -> bool:
        status = getattr(error, "status", None) or getattr(error, "status_code", None)
        if status is None:
            status = getattr(getattr(error, "response", None), "status_code", None)
        if status is not None:
            try:
                return int(status) in {408, 429, 500, 502, 503, 504}
            except (TypeError, ValueError):
                return False
        return isinstance(error, (TimeoutError, ConnectionError)) or type(
            error
        ).__name__ in {
            "APIConnectionError",
            "APITimeoutError",
            "ReadTimeout",
            "ConnectTimeout",
            "ReadTimeoutError",
            "ConnectTimeoutError",
            "ProtocolError",
        }

    def _retry(self, operation: Callable[[], Any]) -> Any:
        for attempt in range(self.config.retry_attempts):
            try:
                return operation()
            except Exception as error:
                if attempt + 1 == self.config.retry_attempts or not self._transient(
                    error
                ):
                    raise
                self._sleep(0.25 * 2**attempt)
        raise AssertionError("Unreachable retry state")

    def _providers(self) -> tuple[Any, Any]:
        if self._embeddings is None:
            if not self.config.openai_api_key:
                raise StoreConfigurationError(
                    "Set OPENAI_API_KEY to index and search documents."
                )
            from langchain_openai import OpenAIEmbeddings

            self._embeddings = OpenAIEmbeddings(
                api_key=self.config.openai_api_key,
                model=self.config.embedding_model,
                dimensions=self.config.embedding_dimensions,
                request_timeout=self.config.request_timeout,
                max_retries=0,
                chunk_size=self.config.batch_size,
            )
        if self._index is None:
            if not self.config.pinecone_api_key or not (
                self.config.pinecone_index_host or self.config.pinecone_index_name
            ):
                raise StoreConfigurationError(
                    "Set PINECONE_API_KEY and PINECONE_INDEX_HOST or PINECONE_INDEX_NAME. "
                    "Create a compatible dense vector index before uploading."
                )
            from pinecone import Pinecone

            self._pinecone_client = Pinecone(api_key=self.config.pinecone_api_key)
            # SDK 10 calls this index(); SDK 7-9 expose the same vector client as Index().
            factory = (
                getattr(self._pinecone_client, "index", None)
                or self._pinecone_client.Index
            )
            if self.config.pinecone_index_host:
                self._index = factory(host=self.config.pinecone_index_host)
            else:
                self._index = factory(name=self.config.pinecone_index_name)
        if not self._index_checked:
            stats = self._retry(
                lambda: self._index.describe_index_stats(
                    timeout=self.config.request_timeout
                )
            )
            if (
                int(self._field(stats, "dimension", 0))
                != self.config.embedding_dimensions
            ):
                raise StoreConfigurationError(
                    "The Pinecone index dimension does not match EMBEDDING_DIMENSIONS."
                )
            self._index_checked = True
        return self._index, self._embeddings

    def list_documents(self, owner_id: str) -> list[dict[str, Any]]:
        namespace = self._namespace(owner_id)
        with self._db() as db:
            rows = db.execute(
                "SELECT * FROM documents WHERE owner_key = ? ORDER BY created_at DESC, id",
                (namespace,),
            ).fetchall()
        return [self._public(row) for row in rows]

    def validate_documents(
        self, owner_id: str, document_ids: Sequence[str]
    ) -> list[dict[str, Any]]:
        namespace = self._namespace(owner_id)
        if isinstance(document_ids, (str, bytes)) or not document_ids:
            raise DocumentValidationError("Select at least one document.")
        if len(document_ids) > self.config.max_selected_documents:
            raise DocumentValidationError("Too many documents selected.")
        if any(
            not isinstance(doc_id, str) or len(doc_id) > 64 for doc_id in document_ids
        ):
            raise DocumentAccessError(
                "A selected document is unavailable or not ready."
            )
        ids = list(dict.fromkeys(document_ids))
        placeholders = ",".join("?" for _ in ids)
        with self._db() as db:
            rows = db.execute(
                f"SELECT * FROM documents WHERE owner_key = ? AND id IN ({placeholders})",
                (namespace, *ids),
            ).fetchall()
        if len(rows) != len(ids) or any(row["status"] != "ready" for row in rows):
            raise DocumentAccessError(
                "A selected document is unavailable or not ready."
            )
        if any(
            row["embedding_model"] != self.config.embedding_model
            or row["embedding_dimensions"] != self.config.embedding_dimensions
            for row in rows
        ):
            raise StoreConfigurationError(
                "Re-upload these documents after changing the embedding model."
            )
        by_id = {row["id"]: self._public(row) for row in rows}
        return [by_id[doc_id] for doc_id in ids]

    def _load_chunks(self, path: Path) -> tuple[int, list[Any]]:
        from langchain_community.document_loaders import PyPDFLoader
        from langchain_text_splitters import RecursiveCharacterTextSplitter
        from pypdf import PdfReader

        try:
            reader = PdfReader(str(path))
            if reader.is_encrypted:
                raise DocumentValidationError(
                    "Password-protected PDFs are not supported."
                )
            pages = len(reader.pages)
            if not 1 <= pages <= self.config.max_pages:
                raise DocumentValidationError(
                    f"PDFs must contain 1 to {self.config.max_pages} pages."
                )
            splitter = RecursiveCharacterTextSplitter(
                chunk_size=self.config.chunk_size,
                chunk_overlap=self.config.chunk_overlap,
                separators=["\n\n", "\n", "。", "！", "？", " ", ""],
            )
            loader = (
                self._loader_factory(str(path))
                if self._loader_factory
                else PyPDFLoader(str(path), mode="page")
            )
            chunks: list[Any] = []
            characters = 0
            for page_index, page in enumerate(loader.lazy_load()):
                characters += len(page.page_content)
                if (
                    page_index >= self.config.max_pages
                    or characters > self.config.max_text_characters
                ):
                    raise DocumentValidationError(
                        "This PDF contains too much text. Split it into smaller files."
                    )
                # Use our counted page number, not untrusted PDF metadata.
                page.metadata = {"page": page_index + 1}
                chunks.extend(
                    chunk
                    for chunk in splitter.split_documents([page])
                    if chunk.page_content.strip()
                )
                if len(chunks) > self.config.max_chunks:
                    raise DocumentValidationError(
                        "This PDF contains too many chunks. Split it into smaller files."
                    )
            if not chunks:
                raise DocumentValidationError(
                    "This PDF has no extractable text. Upload a text PDF or run OCR first."
                )
            return pages, chunks
        except DocumentValidationError:
            raise
        except Exception as error:
            raise DocumentValidationError(
                "This PDF could not be read. Upload a valid, unencrypted PDF."
            ) from error

    def _vectors_valid(self, vectors: Sequence[Sequence[float]], count: int) -> bool:
        return len(vectors) == count and all(
            len(vector) == self.config.embedding_dimensions
            and all(
                isinstance(value, (int, float)) and math.isfinite(value)
                for value in vector
            )
            for vector in vectors
        )

    def upload(self, owner_id: str, filename: str, content: bytes) -> dict[str, Any]:
        namespace = self._namespace(owner_id)
        if (
            not isinstance(content, bytes)
            or not content
            or len(content) > self.config.max_upload_bytes
        ):
            raise DocumentValidationError(
                f"Upload a nonempty PDF up to {self.config.max_upload_bytes // (1024 * 1024)} MB."
            )
        name = re.sub(
            r"[\x00-\x1f\x7f]", "", str(filename).replace("\\", "/").rsplit("/", 1)[-1]
        ).strip()
        if (
            not name.lower().endswith(".pdf")
            or len(name) > 200
            or not content.startswith(b"%PDF-")
        ):
            raise DocumentValidationError(
                "Upload a PDF file with a valid .pdf filename."
            )
        document_id = uuid.uuid4().hex
        path = self.upload_dir / f"{document_id}.pdf"
        created_at = datetime.now(timezone.utc).isoformat()
        with self._db() as db:
            db.execute(
                "INSERT INTO documents(id,owner_key,name,size,status,created_at,embedding_model,embedding_dimensions) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (
                    document_id,
                    namespace,
                    name,
                    len(content),
                    "indexing",
                    created_at,
                    self.config.embedding_model,
                    self.config.embedding_dimensions,
                ),
            )
        vector_ids: list[str] = []
        index = None
        try:
            with path.open("xb") as output:
                path.chmod(0o600)
                output.write(content)
            pages, chunks = self._load_chunks(path)
            with self._db() as db:
                db.execute(
                    "UPDATE documents SET pages=?, chunks=? WHERE id=? AND owner_key=?",
                    (pages, len(chunks), document_id, namespace),
                )
            index, embeddings = self._providers()
            for start in range(0, len(chunks), self.config.batch_size):
                batch = chunks[start : start + self.config.batch_size]
                values = self._retry(
                    lambda batch=batch: embeddings.embed_documents(
                        [chunk.page_content for chunk in batch]
                    )
                )
                if not self._vectors_valid(values, len(batch)):
                    raise StoreConfigurationError(
                        "The embedding provider returned invalid vector dimensions."
                    )
                vectors = [
                    {
                        "id": f"{document_id}:{start + offset}",
                        "values": vector,
                        "metadata": {
                            "document_id": document_id,
                            "page": chunk.metadata["page"],
                            "text": chunk.page_content,
                        },
                    }
                    for offset, (chunk, vector) in enumerate(
                        zip(batch, values, strict=True)
                    )
                ]
                # Record IDs before the call, including requests that timeout after acceptance.
                vector_ids.extend(vector["id"] for vector in vectors)
                with self._db() as db:
                    db.execute(
                        "UPDATE documents SET vector_chunks=? WHERE id=? AND owner_key=?",
                        (len(vector_ids), document_id, namespace),
                    )
                response = self._retry(
                    lambda vectors=vectors: index.upsert(
                        vectors=vectors,
                        namespace=namespace,
                        timeout=self.config.request_timeout,
                    )
                )
                if self._field(response, "upserted_count", len(vectors)) != len(
                    vectors
                ):
                    raise StoreUnavailableError(
                        "Some document chunks could not be indexed. Please retry the upload."
                    )
                committed = self._field(
                    self._field(response, "response_info"), "lsn_committed"
                )
                if isinstance(committed, int):
                    with self._db() as db:
                        db.execute(
                            "UPDATE documents SET write_lsn = MAX(COALESCE(write_lsn, 0), ?) "
                            "WHERE id=? AND owner_key=?",
                            (committed, document_id, namespace),
                        )
            with self._db() as db:
                db.execute(
                    "UPDATE documents SET pages=?, chunks=?, status='ready' WHERE id=? AND owner_key=?",
                    (pages, len(chunks), document_id, namespace),
                )
                row = db.execute(
                    "SELECT * FROM documents WHERE id=? AND owner_key=?",
                    (document_id, namespace),
                ).fetchone()
            return self._public(row)
        except Exception as error:
            # Failed rows remain in the durable catalog so interrupted cleanup can
            # be retried via delete(). They can never be used in retrieval.
            with self._db() as db:
                db.execute(
                    "UPDATE documents SET status='failed' WHERE id=? AND owner_key=?",
                    (document_id, namespace),
                )
            path.unlink(missing_ok=True)
            if index is not None and vector_ids:
                try:
                    self._delete_vectors(index, namespace, vector_ids)
                except Exception:  # noqa: BLE001 - preserve the ingestion error, catalog retains cleanup state.
                    logger.warning(
                        "Vector cleanup needs retry for document %s", document_id
                    )
            if isinstance(
                error,
                (
                    DocumentValidationError,
                    StoreConfigurationError,
                    StoreUnavailableError,
                ),
            ):
                raise
            raise StoreUnavailableError(
                "Document indexing failed. Check service configuration and retry."
            ) from error

    def search(
        self, owner_id: str, document_ids: Sequence[str], query: str
    ) -> list[dict[str, Any]]:
        namespace = self._namespace(owner_id)
        documents = self.validate_documents(owner_id, document_ids)
        if not isinstance(query, str) or not query.strip() or len(query) > 12_000:
            raise DocumentValidationError(
                "Enter a question between 1 and 12,000 characters."
            )
        by_id = {document["id"]: document for document in documents}
        placeholders = ",".join("?" for _ in by_id)
        with self._db() as db:
            target_lsn = db.execute(
                f"SELECT MAX(write_lsn) FROM documents WHERE owner_key=? AND id IN ({placeholders})",
                (namespace, *by_id),
            ).fetchone()[0]
        try:
            index, embeddings = self._providers()
            vector = self._retry(lambda: embeddings.embed_query(query))
            if not self._vectors_valid([vector], 1):
                raise StoreConfigurationError(
                    "The embedding provider returned invalid vector dimensions."
                )
            for visibility_attempt in range(5):
                response = self._retry(
                    lambda: index.query(
                        namespace=namespace,
                        vector=vector,
                        top_k=self.config.top_k,
                        filter={"document_id": {"$in": list(by_id)}},
                        include_metadata=True,
                        include_values=False,
                        timeout=self.config.request_timeout,
                    )
                )
                reconciled = self._field(
                    self._field(response, "response_info"), "lsn_reconciled"
                )
                if target_lsn is None or (
                    isinstance(reconciled, int) and reconciled >= target_lsn
                ):
                    break
                if visibility_attempt == 4:
                    raise StoreUnavailableError(
                        "These documents are still becoming searchable. Please try again shortly."
                    )
                # An accepted write may not yet appear in Pinecone queries. Reuse
                # the query vector and never synthesize from incomplete results.
                self._sleep(2**visibility_attempt)
            results = []
            for match in self._field(response, "matches", []):
                metadata = self._field(match, "metadata", {}) or {}
                document_id = metadata.get("document_id")
                # Defense in depth: do not trust remote metadata to enforce ACLs.
                if document_id not in by_id:
                    continue
                text = metadata.get("text")
                page = metadata.get("page")
                score = self._field(match, "score", 0)
                if (
                    not isinstance(text, str)
                    or not text.strip()
                    or not isinstance(page, (int, float))
                    or not math.isfinite(page)
                    or int(page) != page
                    or not 1 <= page <= by_id[document_id]["pages"]
                    or not isinstance(score, (int, float))
                    or not math.isfinite(score)
                ):
                    continue
                results.append(
                    {
                        "document_id": document_id,
                        "document_name": by_id[document_id]["name"],
                        "page": int(page),
                        "text": text[: self.config.chunk_size],
                        "score": float(score),
                    }
                )
            # Recheck status in case a concurrent delete happened during query.
            self.validate_documents(owner_id, list(by_id))
            return results[: self.config.top_k]
        except (StoreConfigurationError, DocumentAccessError, StoreUnavailableError):
            raise
        except Exception as error:
            raise StoreUnavailableError(
                "Document search is unavailable. Please try again."
            ) from error

    def delete(self, owner_id: str, document_id: str) -> None:
        namespace = self._namespace(owner_id)
        with self._db() as db:
            row = db.execute(
                "SELECT * FROM documents WHERE id=? AND owner_key=?",
                (document_id, namespace),
            ).fetchone()
            if row is None:
                raise DocumentAccessError("The document is unavailable.")
            if row["status"] == "indexing":
                raise DocumentAccessError(
                    "Wait for this document to finish indexing before deleting it."
                )
            db.execute(
                "UPDATE documents SET status='deleting' WHERE id=? AND owner_key=?",
                (document_id, namespace),
            )
        try:
            if row["vector_chunks"]:
                index, _ = self._providers()
                self._delete_vectors(
                    index,
                    namespace,
                    [
                        f"{document_id}:{offset}"
                        for offset in range(row["vector_chunks"])
                    ],
                )
            (self.upload_dir / f"{document_id}.pdf").unlink(missing_ok=True)
            with self._db() as db:
                db.execute(
                    "DELETE FROM documents WHERE id=? AND owner_key=?",
                    (document_id, namespace),
                )
        except StoreConfigurationError:
            raise
        except Exception as error:
            raise StoreUnavailableError(
                "Document deletion failed. Please retry."
            ) from error

    def _delete_vectors(
        self, index: Any, namespace: str, vector_ids: list[str]
    ) -> None:
        # Deterministic IDs avoid metadata-filter visibility delays after upsert.
        for start in range(0, len(vector_ids), 1000):
            batch = vector_ids[start : start + 1000]
            self._retry(
                lambda batch=batch: index.delete(
                    ids=batch, namespace=namespace, timeout=self.config.request_timeout
                )
            )

    def delete_document(self, owner_id: str, document_id: str) -> None:
        self.delete(owner_id, document_id)

    def get_document_path(self, owner_id: str, document_id: str) -> Path:
        self.validate_documents(owner_id, [document_id])
        path = self.upload_dir / f"{document_id}.pdf"
        if not path.is_file():
            raise DocumentAccessError("The document file is unavailable.")
        return path
