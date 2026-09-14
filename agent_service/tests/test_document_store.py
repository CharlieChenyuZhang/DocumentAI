"""Exercise the real PDF/chunking/catalog pipeline with offline provider doubles."""

from dataclasses import replace
from io import BytesIO

import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from agent_service.document_store import (
    DocumentAccessError,
    DocumentStore,
    DocumentValidationError,
    StoreConfig,
    StoreConfigurationError,
    StoreUnavailableError,
)


def pdf_bytes(
    text="A document contains useful evidence for grounded answers.", pages=1
):
    writer = PdfWriter()
    for _ in range(pages):
        page = writer.add_blank_page(width=612, height=792)
        if text:
            font = DictionaryObject(
                {
                    NameObject("/Type"): NameObject("/Font"),
                    NameObject("/Subtype"): NameObject("/Type1"),
                    NameObject("/BaseFont"): NameObject("/Helvetica"),
                }
            )
            page[NameObject("/Resources")] = DictionaryObject(
                {
                    NameObject("/Font"): DictionaryObject(
                        {NameObject("/F1"): writer._add_object(font)}
                    ),
                }
            )
            content = DecodedStreamObject()
            content.set_data(f"BT /F1 12 Tf 50 700 Td ({text}) Tj ET".encode())
            page[NameObject("/Contents")] = writer._add_object(content)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


class ProviderError(Exception):
    def __init__(self, status):
        self.status = status


class FakeEmbeddings:
    def __init__(self):
        self.documents = []
        self.queries = []

    def embed_documents(self, texts):
        self.documents.append(texts)
        return [[0.1, 0.2, 0.3] for _ in texts]

    def embed_query(self, query):
        self.queries.append(query)
        return [0.1, 0.2, 0.3]


class FakeIndex:
    def __init__(self):
        self.records = {}
        self.upserts = []
        self.queries = []
        self.deletes = []
        self.upsert_errors = []
        self.delete_error = None
        self.extra_matches = []
        self.partial_upsert = False
        self.dimension = 3
        self.write_lsn = None
        self.query_lsns = []

    def describe_index_stats(self, **kwargs):
        return {"dimension": self.dimension}

    def upsert(self, *, namespace, vectors, **kwargs):
        self.upserts.append((namespace, vectors))
        for vector in vectors:
            self.records[(namespace, vector["id"])] = vector
        if self.upsert_errors:
            raise ProviderError(self.upsert_errors.pop(0))
        return {
            "upserted_count": len(vectors) - int(self.partial_upsert),
            "response_info": {"lsn_committed": self.write_lsn},
        }

    def query(self, **kwargs):
        self.queries.append(kwargs)
        allowed_ids = kwargs["filter"]["document_id"]["$in"]
        matches = [
            {"id": key[1], "metadata": value["metadata"], "score": 0.9}
            for key, value in self.records.items()
            if key[0] == kwargs["namespace"]
            and value["metadata"]["document_id"] in allowed_ids
        ]
        return {
            "matches": [*matches, *self.extra_matches],
            "response_info": {
                "lsn_reconciled": self.query_lsns.pop(0) if self.query_lsns else None
            },
        }

    def delete(self, *, namespace, ids, **kwargs):
        self.deletes.append((namespace, ids))
        if self.delete_error:
            raise ProviderError(self.delete_error)
        for vector_id in ids:
            self.records.pop((namespace, vector_id), None)


@pytest.fixture
def setup(tmp_path):
    config = StoreConfig(
        data_dir=tmp_path,
        embedding_dimensions=3,
        chunk_size=80,
        chunk_overlap=10,
        batch_size=2,
    )
    index = FakeIndex()
    embeddings = FakeEmbeddings()
    sleeps = []
    store = DocumentStore(
        config, index=index, embeddings=embeddings, sleeper=sleeps.append
    )
    return store, index, embeddings, sleeps


def test_real_pdf_ingestion_persists_and_search_does_not_reembed_documents(setup):
    store, index, embeddings, _ = setup
    first = store.upload("alice", "first.pdf", pdf_bytes(pages=2))
    second = store.upload(
        "alice", "second.pdf", pdf_bytes("A second source supplies more context.")
    )
    assert first["pages"] == 2
    assert first["chunks"] == 2
    assert first["status"] == "ready"
    assert index.upserts[0][0].startswith("user-")
    assert "alice" not in index.upserts[0][0]
    original_embeddings = len(embeddings.documents)

    # A fresh service instance uses its SQLite catalog and existing Pinecone data.
    fresh = DocumentStore(store.config, index=index, embeddings=embeddings)
    assert {doc["id"] for doc in fresh.list_documents("alice")} == {
        first["id"],
        second["id"],
    }
    results = fresh.search("alice", [first["id"], second["id"]], "Compare the sources")
    assert {hit["document_id"] for hit in results} == {first["id"], second["id"]}
    assert {hit["page"] for hit in results} == {1, 2}
    assert all(hit["text"] and hit["document_name"].endswith(".pdf") for hit in results)
    assert len(embeddings.documents) == original_embeddings
    assert embeddings.queries == ["Compare the sources"]


def test_foreign_document_rejected_before_embedding_or_pinecone_query(setup):
    store, index, embeddings, _ = setup
    alice = store.upload("alice", "private.pdf", pdf_bytes("Alice private source"))
    bob = store.upload("bob", "private.pdf", pdf_bytes("Bob private source"))
    assert store.list_documents("alice") == [alice]
    assert store.list_documents("bob") == [bob]
    for ids in ([bob["id"]], [alice["id"], bob["id"]], ["missing"]):
        with pytest.raises(DocumentAccessError, match="unavailable or not ready"):
            store.search("alice", ids, "Who owns this?")
    assert embeddings.queries == []
    assert index.queries == []
    alice_result = store.search("alice", [alice["id"]], "Search")
    assert [hit["document_id"] for hit in alice_result] == [alice["id"]]
    assert index.upserts[0][0] != index.upserts[1][0]


def test_query_filters_selected_documents_and_rechecks_returned_metadata(setup):
    store, index, _, _ = setup
    selected = store.upload("alice", "selected.pdf", pdf_bytes())
    other = store.upload("alice", "other.pdf", pdf_bytes())
    index.extra_matches = [
        {
            "metadata": {
                "document_id": other["id"],
                "text": "Should not be returned",
                "page": 1,
            },
            "score": 1,
        }
    ]
    results = store.search("alice", [selected["id"]], "Search")
    assert index.queries[0]["filter"] == {"document_id": {"$in": [selected["id"]]}}
    assert [hit["document_id"] for hit in results] == [selected["id"]]


@pytest.mark.parametrize("status", ["indexing", "failed", "deleting"])
def test_not_ready_documents_never_retrieve(setup, status):
    store, index, embeddings, _ = setup
    document = store.upload("alice", "source.pdf", pdf_bytes())
    with store._db() as db:
        db.execute("UPDATE documents SET status=? WHERE id=?", (status, document["id"]))
    with pytest.raises(DocumentAccessError):
        store.search("alice", [document["id"]], "Search")
    assert not index.queries and not embeddings.queries


@pytest.mark.parametrize("owner", ["", " ", None, "x" * 513])
def test_all_public_operations_require_owner(setup, owner):
    store, _, _, _ = setup
    operations = [
        lambda: store.list_documents(owner),
        lambda: store.upload(owner, "source.pdf", pdf_bytes()),
        lambda: store.search(owner, ["id"], "question"),
        lambda: store.delete_document(owner, "id"),
        lambda: store.get_document_path(owner, "id"),
    ]
    for operation in operations:
        with pytest.raises(DocumentAccessError, match="authenticated user"):
            operation()


def test_filename_is_display_only_and_uploaded_path_is_unique_uuid(setup):
    store, _, _, _ = setup
    first = store.upload("alice", "../../secret.pdf", pdf_bytes())
    second = store.upload("alice", "C:\\other\\secret.pdf", pdf_bytes())
    assert first["name"] == second["name"] == "secret.pdf"
    assert first["id"] != second["id"]
    for document in (first, second):
        path = store.get_document_path("alice", document["id"])
        assert path.parent == store.upload_dir
        assert path.name == f"{document['id']}.pdf"
        with pytest.raises(DocumentAccessError):
            store.get_document_path("bob", document["id"])


@pytest.mark.parametrize(
    "filename,data",
    [("test.txt", b"%PDF-data"), ("test.pdf", b"plain text"), ("test.pdf", b"")],
)
def test_rejects_invalid_file_before_catalog_or_providers(setup, filename, data):
    store, index, embeddings, _ = setup
    with pytest.raises(DocumentValidationError):
        store.upload("alice", filename, data)
    assert not store.list_documents("alice")
    assert not index.upserts and not embeddings.documents


def test_pdf_page_text_chunk_and_size_limits(setup):
    store, index, embeddings, _ = setup
    cases = [
        ({"max_upload_bytes": 10}, pdf_bytes()),
        ({"max_pages": 1}, pdf_bytes(pages=2)),
        ({"max_text_characters": 5}, pdf_bytes()),
        ({"max_chunks": 1, "chunk_size": 20, "chunk_overlap": 0}, pdf_bytes()),
    ]
    for overrides, content in cases:
        bounded = DocumentStore(
            replace(store.config, **overrides), index=index, embeddings=embeddings
        )
        with pytest.raises(DocumentValidationError):
            bounded.upload("alice", "limited.pdf", content)
    assert not index.upserts and not embeddings.documents
    assert not list(store.upload_dir.glob("*.pdf"))


@pytest.mark.parametrize("data", [b"%PDF-malformed", pdf_bytes("")])
def test_unreadable_or_image_only_pdf_is_clear_validation_error(setup, data):
    store, index, _, _ = setup
    with pytest.raises(DocumentValidationError):
        store.upload("alice", "empty.pdf", data)
    assert store.list_documents("alice")[0]["status"] == "failed"
    assert not index.upserts
    assert not list(store.upload_dir.glob("*.pdf"))


def test_transient_upsert_retries_same_ids_without_duplicate_embeddings(setup):
    store, index, embeddings, sleeps = setup
    index.upsert_errors = [503, 429]
    document = store.upload("alice", "retry.pdf", pdf_bytes())
    assert document["status"] == "ready"
    assert len(index.upserts) == 3
    assert len(embeddings.documents) == 1
    assert index.upserts[0] == index.upserts[1] == index.upserts[2]
    assert sleeps == [0.25, 0.5]
    assert len(index.records) == 1


@pytest.mark.parametrize("errors,attempts", [([400], 1), ([503, 503, 503], 3)])
def test_failed_indexing_cleans_up_and_never_retries_permanent_errors(
    setup, errors, attempts
):
    store, index, _, sleeps = setup
    index.upsert_errors = errors
    with pytest.raises(StoreUnavailableError, match="Document indexing failed"):
        store.upload("alice", "failed.pdf", pdf_bytes())
    assert len(index.upserts) == attempts
    assert len(sleeps) == attempts - 1
    assert not index.records
    assert not list(store.upload_dir.glob("*.pdf"))
    document = store.list_documents("alice")[0]
    assert document["status"] == "failed"
    assert index.deletes[0][0] == index.upserts[0][0]
    with pytest.raises(DocumentAccessError):
        store.search("alice", [document["id"]], "question")


def test_partial_upsert_fails_and_cleans_vectors(setup):
    store, index, _, _ = setup
    index.partial_upsert = True
    with pytest.raises(StoreUnavailableError, match="Some document chunks"):
        store.upload("alice", "partial.pdf", pdf_bytes())
    assert not index.records
    assert store.list_documents("alice")[0]["status"] == "failed"


def test_missing_configuration_has_no_memory_fallback(tmp_path):
    store = DocumentStore(StoreConfig(data_dir=tmp_path))
    assert store.list_documents("alice") == []
    with pytest.raises(StoreConfigurationError, match="OPENAI_API_KEY"):
        store.upload("alice", "source.pdf", pdf_bytes())
    assert store.list_documents("alice")[0]["status"] == "failed"
    assert not list(store.upload_dir.glob("*.pdf"))
    store.delete_document("alice", store.list_documents("alice")[0]["id"])
    assert store.list_documents("alice") == []


def test_mismatched_pinecone_dimensions_fail_before_embeddings(setup):
    store, index, embeddings, _ = setup
    index.dimension = 1536
    with pytest.raises(StoreConfigurationError, match="dimension"):
        store.upload("alice", "source.pdf", pdf_bytes())
    assert not embeddings.documents and not index.upserts


def test_changed_embedding_model_requires_reingestion(setup):
    store, index, embeddings, _ = setup
    document = store.upload("alice", "source.pdf", pdf_bytes())
    changed = DocumentStore(
        replace(store.config, embedding_model="different-model"),
        index=index,
        embeddings=embeddings,
    )
    with pytest.raises(StoreConfigurationError, match="Re-upload"):
        changed.search("alice", [document["id"]], "Search")
    assert not embeddings.queries and not index.queries


def test_delete_checks_owner_and_removes_file_catalog_and_vectors(setup):
    store, index, _, _ = setup
    document = store.upload("alice", "source.pdf", pdf_bytes())
    with pytest.raises(DocumentAccessError):
        store.delete_document("bob", document["id"])
    assert not index.deletes
    store.delete_document("alice", document["id"])
    assert not store.list_documents("alice")
    assert not index.records
    assert not list(store.upload_dir.glob("*.pdf"))


def test_failed_delete_is_inaccessible_and_can_be_retried(setup):
    store, index, _, _ = setup
    document = store.upload("alice", "source.pdf", pdf_bytes())
    index.delete_error = 400
    with pytest.raises(StoreUnavailableError):
        store.delete_document("alice", document["id"])
    assert store.list_documents("alice")[0]["status"] == "deleting"
    with pytest.raises(DocumentAccessError):
        store.search("alice", [document["id"]], "question")
    index.delete_error = None
    store.delete_document("alice", document["id"])
    assert not store.list_documents("alice")


def test_query_selection_must_be_explicit_and_nonempty(setup):
    store, index, embeddings, _ = setup
    for ids in ([], "any", ["id"] * 51):
        with pytest.raises(DocumentValidationError):
            store.search("alice", ids, "Question")
    assert not index.queries and not embeddings.queries


def test_search_waits_for_all_selected_document_writes_to_be_searchable(setup):
    store, index, embeddings, sleeps = setup
    index.write_lsn = 5
    first = store.upload("alice", "first.pdf", pdf_bytes())
    index.write_lsn = 9
    second = store.upload("alice", "second.pdf", pdf_bytes())
    index.query_lsns = [5, 8, 9]
    fresh = DocumentStore(
        store.config, index=index, embeddings=embeddings, sleeper=sleeps.append
    )
    results = fresh.search("alice", [first["id"], second["id"]], "Search both")
    assert len(results) == 2
    assert len(index.queries) == 3
    assert embeddings.queries == ["Search both"]
    assert sleeps == [1, 2]


def test_search_does_not_present_stale_results_as_a_successful_retrieval(setup):
    store, index, embeddings, sleeps = setup
    index.write_lsn = 10
    document = store.upload("alice", "still-indexing.pdf", pdf_bytes())
    index.query_lsns = [None, 7, 7, 8, 9]
    with pytest.raises(StoreUnavailableError, match="still becoming searchable"):
        store.search("alice", [document["id"]], "Search")
    assert len(index.queries) == 5
    assert embeddings.queries == ["Search"]
    assert sleeps == [1, 2, 4, 8]
