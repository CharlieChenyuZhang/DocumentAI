import pytest

from agent_service import config


def test_config_reuses_only_named_legacy_credentials_and_fills_blank_values(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(config, "ROOT", tmp_path)
    (tmp_path / "server").mkdir()
    (tmp_path / "server" / ".env").write_text(
        "OPENAI_API_KEY=legacy-openai\nSERPAPI_KEY=legacy-search\nAGENT_SERVICE_TOKEN=wrong-token\n"
    )
    (tmp_path / ".env.local").write_text(
        "OPENAI_API_KEY=\nSERPAPI_KEY=\nAGENT_SERVICE_TOKEN=correct-token\n"
    )
    for key in ("OPENAI_API_KEY", "SERPAPI_KEY", "AGENT_SERVICE_TOKEN"):
        monkeypatch.delenv(key, raising=False)
    settings = config.Settings.from_env()
    assert settings.openai_api_key == "legacy-openai"
    assert settings.serpapi_key == "legacy-search"
    assert settings.service_token == "correct-token"
    assert "legacy-openai" not in repr(settings)
    assert "correct-token" not in repr(settings)
    monkeypatch.setenv("OPENAI_API_KEY", "preferred-env")
    assert config.Settings.from_env().openai_api_key == "preferred-env"


def test_local_mode_needs_openai_but_not_pinecone_and_isolates_storage(tmp_path):
    local = config.Settings(
        vector_backend="local",
        data_dir=tmp_path,
        service_token="test-service",
        openai_api_key="test-openai",
    )
    assert local.missing == []
    assert local.storage_dir == tmp_path / "local"
    assert local.session_url.endswith("/local/sessions.sqlite3")
    assert config.Settings(vector_backend="local").missing == [
        "AGENT_SERVICE_TOKEN",
        "OPENAI_API_KEY",
    ]
    cloud = config.Settings(data_dir=tmp_path)
    assert cloud.vector_backend == "pinecone"
    assert cloud.storage_dir == tmp_path
    assert "PINECONE_API_KEY" in cloud.missing
    with pytest.raises(ValueError, match="VECTOR_BACKEND"):
        config.Settings(vector_backend="automatic")


def test_local_backend_is_explicitly_read_from_configuration(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ROOT", tmp_path)
    monkeypatch.delenv("VECTOR_BACKEND", raising=False)
    (tmp_path / ".env.local").write_text("VECTOR_BACKEND=local\n")
    assert config.Settings.from_env().vector_backend == "local"
    monkeypatch.setenv("VECTOR_BACKEND", "pinecone")
    assert config.Settings.from_env().vector_backend == "pinecone"


def test_transcription_model_uses_default_and_server_override(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ROOT", tmp_path)
    monkeypatch.delenv("OPENAI_TRANSCRIPTION_MODEL", raising=False)
    assert config.Settings.from_env().transcription_model == "gpt-transcribe"
    monkeypatch.setenv("OPENAI_TRANSCRIPTION_MODEL", "gpt-4o-mini-transcribe")
    assert config.Settings.from_env().transcription_model == "gpt-4o-mini-transcribe"
    monkeypatch.setenv("OPENAI_TRANSCRIPTION_MODEL", " ")
    assert config.Settings.from_env().transcription_model == "gpt-transcribe"
