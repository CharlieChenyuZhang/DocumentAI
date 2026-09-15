"""Explicit local vector storage for a single Document AI service deployment.

This index never creates embeddings or calls a remote service. The caller chooses
it explicitly instead of Pinecone, passes a server-derived namespace, and checks
document ownership against the catalog before querying. SQLite additionally
filters namespace and selected document IDs before reading or scoring vectors.
"""

from __future__ import annotations

import heapq
import json
import math
import sqlite3
import struct
import time
from collections.abc import Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any


class SQLiteVectorIndex:
    """Persist dense vectors and rank selected documents by exact cosine score.

    Implements the small Pinecone index interface used by DocumentStore. A new
    connection per operation allows asyncio.to_thread callers without sharing
    SQLite connections across threads. Write batches are atomic and queries use
    a consistent read transaction. Use a dedicated storage profile when switching
    backends; existing Pinecone catalog entries are not migrated automatically.
    """

    def __init__(
        self,
        path: Path,
        dimension: int,
        *,
        max_vectors_per_namespace: int = 100_000,
        max_query_vectors: int = 50_000,
    ) -> None:
        if type(dimension) is not int or not 1 <= dimension <= 3072:
            raise ValueError("Local vector dimensions must be between 1 and 3072.")
        if any(
            type(value) is not int or not 1 <= value <= 100_000
            for value in (max_vectors_per_namespace, max_query_vectors)
        ):
            raise ValueError("Local vector limits must be between 1 and 100,000.")
        if str(path) == ":memory:":
            raise ValueError("The local vector index requires a persistent file path.")
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path.touch(mode=0o600, exist_ok=True)
        self.path.chmod(0o600)
        self.dimension = dimension
        self.max_vectors_per_namespace = max_vectors_per_namespace
        self.max_query_vectors = max_query_vectors
        self._vector_format = struct.Struct(f"<{dimension}d")
        with self._db() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("BEGIN IMMEDIATE")
            db.execute("""
                CREATE TABLE IF NOT EXISTS vector_index_config (
                    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                    dimension INTEGER NOT NULL
                )
            """)
            db.execute(
                "INSERT OR IGNORE INTO vector_index_config(singleton, dimension) VALUES(1, ?)",
                (dimension,),
            )
            persisted = db.execute(
                "SELECT dimension FROM vector_index_config WHERE singleton=1"
            ).fetchone()[0]
            if persisted != dimension:
                raise ValueError(
                    "The local vector index uses a different embedding dimension. "
                    "Choose a separate data directory before re-indexing documents."
                )
            db.execute("""
                CREATE TABLE IF NOT EXISTS vector_namespaces (
                    namespace TEXT PRIMARY KEY,
                    sequence INTEGER NOT NULL DEFAULT 0
                )
            """)
            db.execute("""
                CREATE TABLE IF NOT EXISTS document_vectors (
                    namespace TEXT NOT NULL,
                    id TEXT NOT NULL,
                    document_id TEXT NOT NULL,
                    vector BLOB NOT NULL,
                    scale REAL NOT NULL,
                    scaled_norm REAL NOT NULL,
                    metadata TEXT NOT NULL,
                    PRIMARY KEY(namespace, id)
                )
            """)
            db.execute("""
                CREATE INDEX IF NOT EXISTS vectors_by_document
                ON document_vectors(namespace, document_id)
            """)
        self.path.chmod(0o600)

    @contextmanager
    def _db(self, timeout: float | None = None):
        duration = self._duration(timeout)
        db = sqlite3.connect(self.path, timeout=min(duration, 10))
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _duration(timeout: float | None) -> float:
        if timeout is None:
            return 30.0
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or timeout <= 0
        ):
            raise ValueError("The local vector timeout must be positive and finite.")
        return min(float(timeout), 120.0)

    @staticmethod
    def _identifier(value: Any, label: str, limit: int = 128) -> str:
        if (
            not isinstance(value, str)
            or not value.strip()
            or len(value) > limit
            or any(ord(character) < 32 for character in value)
        ):
            raise ValueError(f"A valid {label} is required.")
        return value

    def _vector(self, value: Any) -> tuple[list[float], float, float]:
        if (
            not isinstance(value, Sequence)
            or isinstance(value, (str, bytes))
            or len(value) != self.dimension
        ):
            raise ValueError("Vector dimensions do not match the local index.")
        if any(
            isinstance(number, bool) or not isinstance(number, (int, float))
            for number in value
        ):
            raise ValueError("Vectors must contain only finite numbers.")
        try:
            vector = [float(number) for number in value]
        except (ValueError, OverflowError) as error:
            raise ValueError("Vectors must contain only finite numbers.") from error
        if not all(math.isfinite(number) for number in vector):
            raise ValueError("Vectors must contain only finite numbers.")
        scale = max(abs(number) for number in vector)
        if scale == 0:
            raise ValueError("Zero vectors cannot be used for cosine similarity.")
        # Scaling before summation avoids overflow for large finite inputs and
        # underflow for very small vectors without changing cosine similarity.
        scaled_norm = math.sqrt(math.fsum((number / scale) ** 2 for number in vector))
        return vector, scale, scaled_norm

    def _document_ids(self, selection: Any) -> list[str]:
        if not isinstance(selection, Mapping) or set(selection) != {"document_id"}:
            raise ValueError("Local searches require an explicit document_id filter.")
        condition = selection["document_id"]
        if not isinstance(condition, Mapping) or set(condition) not in (
            {"$in"},
            {"$eq"},
        ):
            raise ValueError("Use document_id $in or $eq to select documents.")
        ids = condition.get("$in") if "$in" in condition else [condition["$eq"]]
        if not isinstance(ids, (list, tuple)) or not 1 <= len(ids) <= 50:
            raise ValueError("Select between 1 and 50 document IDs.")
        return list(
            dict.fromkeys(self._identifier(value, "document ID") for value in ids)
        )

    @staticmethod
    def _advance(db: sqlite3.Connection, namespace: str) -> int:
        db.execute(
            "INSERT INTO vector_namespaces(namespace, sequence) VALUES(?, 1) "
            "ON CONFLICT(namespace) DO UPDATE SET sequence=sequence+1",
            (namespace,),
        )
        return db.execute(
            "SELECT sequence FROM vector_namespaces WHERE namespace=?", (namespace,)
        ).fetchone()[0]

    def describe_index_stats(self, *, timeout: float | None = None) -> dict[str, Any]:
        with self._db(timeout) as db:
            count = db.execute("SELECT COUNT(*) FROM document_vectors").fetchone()[0]
        return {"dimension": self.dimension, "total_vector_count": count}

    def upsert(
        self,
        *,
        vectors: Sequence[Mapping[str, Any]],
        namespace: str,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        namespace = self._identifier(namespace, "owner namespace")
        if not isinstance(vectors, (list, tuple)) or not 1 <= len(vectors) <= 64:
            raise ValueError(
                "Local upsert batches must contain between 1 and 64 vectors."
            )
        rows = []
        identifiers = []
        # Validate the complete batch before opening the write transaction.
        for record in vectors:
            if not isinstance(record, Mapping):
                raise TypeError("Each vector record must be an object.")
            vector_id = self._identifier(record.get("id"), "vector ID", 512)
            values, scale, scaled_norm = self._vector(record.get("values"))
            metadata = record.get("metadata")
            if not isinstance(metadata, Mapping):
                raise TypeError("Document metadata is required.")
            document_id = self._identifier(metadata.get("document_id"), "document ID")
            serialized = json.dumps(dict(metadata), ensure_ascii=False, allow_nan=False)
            if len(serialized.encode("utf-8")) > 40 * 1024:
                raise ValueError("Vector metadata exceeds the 40 KiB limit.")
            identifiers.append(vector_id)
            rows.append(
                (
                    namespace,
                    vector_id,
                    document_id,
                    self._vector_format.pack(*values),
                    scale,
                    scaled_norm,
                    serialized,
                )
            )
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("Vector IDs must be unique within an upsert batch.")
        placeholders = ",".join("?" for _ in identifiers)
        with self._db(timeout) as db:
            db.execute("BEGIN IMMEDIATE")
            count = db.execute(
                "SELECT COUNT(*) FROM document_vectors WHERE namespace=?", (namespace,)
            ).fetchone()[0]
            existing = db.execute(
                f"SELECT COUNT(*) FROM document_vectors WHERE namespace=? AND id IN ({placeholders})",
                (namespace, *identifiers),
            ).fetchone()[0]
            if count + len(rows) - existing > self.max_vectors_per_namespace:
                raise ValueError(
                    "This local document library has reached its vector limit. Delete unused documents."
                )
            db.executemany(
                "INSERT INTO document_vectors(namespace,id,document_id,vector,scale,scaled_norm,metadata) "
                "VALUES(?,?,?,?,?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET "
                "document_id=excluded.document_id,vector=excluded.vector,scale=excluded.scale,"
                "scaled_norm=excluded.scaled_norm,metadata=excluded.metadata",
                rows,
            )
            sequence = self._advance(db, namespace)
        return {
            "upserted_count": len(rows),
            "response_info": {"lsn_committed": sequence},
        }

    def query(
        self,
        *,
        vector: Sequence[float],
        namespace: str,
        filter: Mapping[str, Any],
        top_k: int,
        include_metadata: bool = True,
        include_values: bool = False,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        namespace = self._identifier(namespace, "owner namespace")
        document_ids = self._document_ids(filter)
        if type(top_k) is not int or not 1 <= top_k <= 100:
            raise ValueError("Local search top_k must be between 1 and 100.")
        values, scale, scaled_norm = self._vector(vector)
        unit_query = [value / scale / scaled_norm for value in values]
        deadline = time.monotonic() + self._duration(timeout)
        placeholders = ",".join("?" for _ in document_ids)
        where = f"namespace=? AND document_id IN ({placeholders})"
        params = (namespace, *document_ids)
        heap: list[tuple[float, str, dict[str, Any]]] = []
        with self._db(timeout) as db:
            db.execute("BEGIN")
            sequence_row = db.execute(
                "SELECT sequence FROM vector_namespaces WHERE namespace=?", (namespace,)
            ).fetchone()
            sequence = sequence_row[0] if sequence_row else 0
            # Bound the selected set before loading any vector bytes. Never
            # truncate it silently, which could return incorrect nearest matches.
            count = db.execute(
                f"SELECT COUNT(*) FROM document_vectors WHERE {where}", params
            ).fetchone()[0]
            if count > self.max_query_vectors:
                raise ValueError(
                    "Too many local vectors selected. Select fewer documents."
                )
            cursor = db.execute(
                f"SELECT id,vector,scale,scaled_norm,metadata FROM document_vectors WHERE {where}",
                params,
            )
            for row in cursor:
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        "Local vector search timed out. Select fewer documents."
                    )
                stored = self._vector_format.unpack(row["vector"])
                stored_scale = row["scale"]
                stored_norm = row["scaled_norm"]
                score = math.fsum(
                    (value / stored_scale / stored_norm) * query_value
                    for value, query_value in zip(stored, unit_query, strict=True)
                )
                score = min(1.0, max(-1.0, score))
                if len(heap) == top_k and (score, row["id"]) <= heap[0][:2]:
                    continue
                match: dict[str, Any] = {"id": row["id"], "score": score}
                if include_metadata:
                    match["metadata"] = json.loads(row["metadata"])
                if include_values:
                    match["values"] = list(stored)
                item = (score, row["id"], match)
                if len(heap) < top_k:
                    heapq.heappush(heap, item)
                elif item[:2] > heap[0][:2]:
                    heapq.heapreplace(heap, item)
        matches = [
            item[2] for item in sorted(heap, key=lambda item: item[:2], reverse=True)
        ]
        return {"matches": matches, "response_info": {"lsn_reconciled": sequence}}

    def delete(
        self,
        *,
        ids: Sequence[str],
        namespace: str,
        timeout: float | None = None,
    ) -> None:
        namespace = self._identifier(namespace, "owner namespace")
        if not isinstance(ids, (list, tuple)) or not 1 <= len(ids) <= 1000:
            raise ValueError(
                "Local delete batches must contain between 1 and 1000 vector IDs."
            )
        identifiers = list(
            dict.fromkeys(self._identifier(value, "vector ID", 512) for value in ids)
        )
        placeholders = ",".join("?" for _ in identifiers)
        with self._db(timeout) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                f"DELETE FROM document_vectors WHERE namespace=? AND id IN ({placeholders})",
                (namespace, *identifiers),
            )
            self._advance(db, namespace)
