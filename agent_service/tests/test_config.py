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
