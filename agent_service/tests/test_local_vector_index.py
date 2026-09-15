"""Exercise actual local persistence and cosine ranking without model services."""

import math
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from agent_service.local_vector_index import SQLiteVectorIndex


def record(vector_id, values, document_id="document-a", text="Evidence from a PDF"):
    return {
        "id": vector_id,
        "values": values,
        "metadata": {"document_id": document_id, "page": 1, "text": text},
    }


def search(index, namespace="owner-a", documents=None, vector=None, top_k=8, **options):
    return index.query(
        namespace=namespace,
        filter={"document_id": {"$in": documents or ["document-a"]}},
        vector=vector if vector is not None else [1, 0, 0],
        top_k=top_k,
        **options,
    )


@pytest.fixture
def index(tmp_path):
    return SQLiteVectorIndex(tmp_path / "vectors.sqlite3", 3)


def test_persistence_cosine_ranking_and_committed_sequence_survive_restart(index):
    uploaded = index.upsert(
        namespace="owner-a",
        vectors=[
            record("same-direction", [10, 0, 0]),
            record("near", [1, 1, 0]),
            record("perpendicular", [0, 1, 0]),
            record("opposite", [-1, 0, 0]),
        ],
    )
    fresh = SQLiteVectorIndex(index.path, 3)
    results = search(fresh, include_values=True)
    assert [item["id"] for item in results["matches"]] == [
        "same-direction",
        "near",
        "perpendicular",
        "opposite",
    ]
    assert [item["score"] for item in results["matches"]] == pytest.approx(
        [1, 1 / math.sqrt(2), 0, -1]
    )
    assert results["matches"][0]["values"] == [10, 0, 0]
    assert results["matches"][0]["metadata"]["text"] == "Evidence from a PDF"
    assert (
        results["response_info"]["lsn_reconciled"]
        == uploaded["response_info"]["lsn_committed"]
    )
    assert fresh.describe_index_stats() == {"dimension": 3, "total_vector_count": 4}
    with sqlite3.connect(index.path) as db:
        assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_filters_owner_and_selected_documents_before_decoding_vectors(index):
    index.upsert(
        namespace="owner-a", vectors=[record("shared-id", [1, 1, 0], "selected")]
    )
    index.upsert(
        namespace="owner-b",
        vectors=[record("shared-id", [1, 0, 0], "selected", "Another owner")],
    )
    index.upsert(
        namespace="owner-a", vectors=[record("not-selected", [1, 0, 0], "excluded")]
    )
    # If filtering were performed in Python after loading/scoring, these corrupt
    # out-of-scope blobs would make this query fail instead of returning a match.
    with sqlite3.connect(index.path) as db:
        db.execute(
            "UPDATE document_vectors SET vector=? WHERE namespace=? OR document_id=?",
            (b"invalid", "owner-b", "excluded"),
        )
    results = search(index, documents=["selected"])
    assert len(results["matches"]) == 1
    assert results["matches"][0]["id"] == "shared-id"
    assert results["matches"][0]["score"] == pytest.approx(1 / math.sqrt(2))
    assert results["matches"][0]["metadata"]["text"] == "Evidence from a PDF"


def test_multiple_selected_documents_are_scored_together(index):
    index.upsert(
        namespace="owner-a",
        vectors=[
            record("a", [0, 1, 0], "a"),
            record("b", [1, 0, 0], "b"),
            record("c", [1, 0, 0], "c"),
        ],
    )
    result = search(index, documents=["a", "b"], top_k=2)
    assert [item["id"] for item in result["matches"]] == ["b", "a"]
    assert not search(index, documents=["missing"])["matches"]
    assert not search(index, namespace="missing", documents=["a", "b"])["matches"]


def test_repeated_upsert_replaces_without_duplication_and_changes_metadata(index):
    index.upsert(namespace="owner-a", vectors=[record("a", [0, 1, 0])])
    index.upsert(
        namespace="owner-a", vectors=[record("a", [1, 0, 0], text="Updated evidence")]
    )
    result = search(index)
    assert len(result["matches"]) == 1
    assert result["matches"][0]["score"] == 1
    assert result["matches"][0]["metadata"]["text"] == "Updated evidence"
    assert index.describe_index_stats()["total_vector_count"] == 1
    assert result["response_info"]["lsn_reconciled"] == 2


def test_delete_removes_only_named_ids_in_requested_namespace(index):
    index.upsert(
        namespace="owner-a", vectors=[record("a", [1, 0, 0]), record("b", [0, 1, 0])]
    )
    index.upsert(namespace="owner-b", vectors=[record("a", [1, 0, 0])])
    index.delete(namespace="owner-a", ids=["a", "missing"])
    assert [item["id"] for item in search(index)["matches"]] == ["b"]
    assert [item["id"] for item in search(index, namespace="owner-b")["matches"]] == [
        "a"
    ]
    fresh = SQLiteVectorIndex(index.path, 3)
    fresh.delete(namespace="owner-a", ids=["b"])
    assert search(fresh)["matches"] == []
    assert fresh.describe_index_stats()["total_vector_count"] == 1


@pytest.mark.parametrize(
    "bad",
    [
        [1, 2],
        [1, 2, 3, 4],
        [0, 0, 0],
        [1, math.nan, 0],
        [1, math.inf, 0],
        [1, -math.inf, 0],
        [True, 1, 0],
        ["1", 1, 0],
        [10**400, 1, 0],
    ],
)
def test_bad_vectors_rejected_without_partially_writing_batch(index, bad):
    with pytest.raises(ValueError):
        index.upsert(
            namespace="owner-a",
            vectors=[record("valid", [1, 0, 0]), record("bad", bad)],
        )
    assert index.describe_index_stats()["total_vector_count"] == 0
    with pytest.raises(ValueError):
        search(index, vector=bad)


def test_cosine_is_stable_for_large_and_small_finite_vectors(index):
    index.upsert(
        namespace="owner-a",
        vectors=[
            record("large", [1e308, 1e308, 0]),
            record("small", [1e-308, 1e-308, 0]),
        ],
    )
    results = search(index, vector=[1e308, 1e308, 0])
    assert [item["score"] for item in results["matches"]] == pytest.approx([1, 1])


@pytest.mark.parametrize("namespace", ["", " ", None, "x" * 129, "bad\nnamespace"])
def test_all_data_operations_require_explicit_namespace(index, namespace):
    with pytest.raises(ValueError):
        index.upsert(namespace=namespace, vectors=[record("a", [1, 0, 0])])
    with pytest.raises(ValueError):
        search(index, namespace=namespace)
    with pytest.raises(ValueError):
        index.delete(namespace=namespace, ids=["a"])


@pytest.mark.parametrize(
    "selection",
    [
        None,
        {},
        {"document_id": {}},
        {"document_id": {"$in": []}},
        {"document_id": {"$nin": ["a"]}},
        {"document_id": {"$in": ["a"]}, "owner": "other"},
    ],
)
def test_search_does_not_allow_broad_or_unsupported_filters(index, selection):
    with pytest.raises(ValueError):
        index.query(namespace="owner-a", vector=[1, 0, 0], filter=selection, top_k=5)


def test_immutable_dimension_and_disk_requirement(index, tmp_path):
    with pytest.raises(ValueError, match="different embedding dimension"):
        SQLiteVectorIndex(index.path, 2)
    with pytest.raises(ValueError, match="persistent file"):
        SQLiteVectorIndex(":memory:", 3)
    with pytest.raises(ValueError, match="dimensions"):
        SQLiteVectorIndex(tmp_path / "invalid.sqlite3", 0)


def test_capacity_and_query_limits_fail_without_partial_results(tmp_path):
    index = SQLiteVectorIndex(
        tmp_path / "vectors.sqlite3",
        3,
        max_vectors_per_namespace=2,
        max_query_vectors=1,
    )
    index.upsert(namespace="owner-a", vectors=[record("a", [1, 0, 0])])
    with pytest.raises(ValueError, match="vector limit"):
        index.upsert(
            namespace="owner-a",
            vectors=[record("b", [1, 0, 0]), record("c", [1, 0, 0])],
        )
    assert index.describe_index_stats()["total_vector_count"] == 1
    # Updating existing IDs stays within capacity; another namespace has its own quota.
    index.upsert(
        namespace="owner-a",
        vectors=[record("a", [0, 1, 0]), record("b", [1, 0, 0], "other")],
    )
    index.upsert(
        namespace="owner-b", vectors=[record("a", [1, 0, 0]), record("b", [1, 0, 0])]
    )
    with pytest.raises(ValueError, match="Select fewer documents"):
        search(index, documents=["document-a", "other"])
    assert [item["id"] for item in search(index)["matches"]] == ["a"]


def test_batch_and_metadata_bounds_are_atomic(index):
    cases = [
        [record("same", [1, 0, 0]), record("same", [0, 1, 0])],
        [record(str(i), [1, 0, 0]) for i in range(65)],
        [record("a", [1, 0, 0], text="x" * (41 * 1024))],
        [{"id": "a", "values": [1, 0, 0], "metadata": {}}],
    ]
    for vectors in cases:
        with pytest.raises(ValueError):
            index.upsert(namespace="owner-a", vectors=vectors)
    assert index.describe_index_stats()["total_vector_count"] == 0


def test_query_can_omit_metadata_and_values(index):
    index.upsert(namespace="owner-a", vectors=[record("a", [1, 0, 0])])
    assert search(index, include_metadata=False, include_values=False)["matches"] == [
        {"id": "a", "score": 1.0}
    ]


def test_namespace_limits_remain_atomic_across_concurrent_connections(tmp_path):
    index = SQLiteVectorIndex(
        tmp_path / "vectors.sqlite3", 3, max_vectors_per_namespace=1
    )

    def write(vector_id):
        try:
            index.upsert(namespace="owner-a", vectors=[record(vector_id, [1, 0, 0])])
            return True
        except ValueError:
            return False

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(write, ["a", "b"]))
    assert sorted(outcomes) == [False, True]
    assert index.describe_index_stats()["total_vector_count"] == 1
