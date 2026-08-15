"""Tests for HTTP request retry logic."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from voice_to_text.providers.base import (
    get_http_retry_config,
    http_request_with_retry,
)


def _make_response(status_code: int = 200, json_body: dict | None = None) -> httpx.Response:
    """Build a fake httpx.Response."""
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.json.return_value = json_body or {}
    resp.text = ""

    def _raise_for_status():
        if 400 <= status_code < 600:
            request = MagicMock()
            request.url = "https://example.com"
            raise httpx.HTTPStatusError(
                f"{status_code}",
                request=request,
                response=resp,
            )

    resp.raise_for_status.side_effect = _raise_for_status
    return resp


class TestGetHttpRetryConfig:
    def test_defaults_when_no_config(self):
        codes, max_retries, delay = get_http_retry_config({})
        assert codes == frozenset((401,))
        assert max_retries == 0
        assert delay == 1.0

    def test_reads_from_config(self):
        cfg = {"http_retry": {"status_codes": [429, 503], "max_retries": 3, "delay": 2.5}}
        codes, max_retries, delay = get_http_retry_config(cfg)
        assert codes == frozenset({429, 503})
        assert max_retries == 3
        assert delay == 2.5

    def test_empty_http_retry_section_uses_defaults(self):
        cfg = {"http_retry": {}}
        codes, max_retries, _delay = get_http_retry_config(cfg)
        assert codes == frozenset((401,))
        assert max_retries == 0


class TestHttpRequestWithRetry:
    @pytest.mark.asyncio
    async def test_no_retry_when_status_ok(self):
        client = AsyncMock()
        client.post.return_value = _make_response(200)

        resp = await http_request_with_retry(
            client,
            "POST",
            "https://api.example.com/v1/transcribe",
            config={"http_retry": {"max_retries": 3}},
            headers_fn=lambda: {"Authorization": "Bearer key"},
        )
        assert resp.status_code == 200
        assert client.post.call_count == 1

    @pytest.mark.asyncio
    async def test_retries_on_configured_status_code(self):
        client = AsyncMock()
        client.post.side_effect = [
            _make_response(401),
            _make_response(200),
        ]

        resp = await http_request_with_retry(
            client,
            "POST",
            "https://api.example.com/v1/transcribe",
            config={"http_retry": {"status_codes": [401], "max_retries": 2, "delay": 0}},
            headers_fn=lambda: {"Authorization": "Bearer key"},
        )
        assert resp.status_code == 200
        assert client.post.call_count == 2

    @pytest.mark.asyncio
    async def test_no_retry_when_status_not_in_list(self):
        client = AsyncMock()
        client.post.side_effect = [_make_response(500), _make_response(200)]

        with pytest.raises(httpx.HTTPStatusError):
            await http_request_with_retry(
                client,
                "POST",
                "https://api.example.com/v1/transcribe",
                config={"http_retry": {"status_codes": [401], "max_retries": 3}},
                headers_fn=lambda: {"Authorization": "Bearer key"},
            )
        assert client.post.call_count == 1

    @pytest.mark.asyncio
    async def test_gives_up_after_max_retries(self):
        client = AsyncMock()
        client.post.return_value = _make_response(401)

        with pytest.raises(httpx.HTTPStatusError):
            await http_request_with_retry(
                client,
                "POST",
                "https://api.example.com/v1/transcribe",
                config={"http_retry": {"status_codes": [401], "max_retries": 2, "delay": 0}},
                headers_fn=lambda: {"Authorization": "Bearer key"},
            )
        # 1 initial + 2 retries = 3 calls
        assert client.post.call_count == 3

    @pytest.mark.asyncio
    async def test_headers_fn_called_fresh_each_attempt(self):
        """Headers should be rebuilt on each attempt so a re-resolved key is picked up."""
        client = AsyncMock()
        client.post.side_effect = [_make_response(401), _make_response(200)]

        keys = ["old_key", "new_key"]
        call_idx = {"i": 0}

        def fresh_headers():
            i = min(call_idx["i"], len(keys) - 1)
            call_idx["i"] += 1
            return {"Authorization": f"Bearer {keys[i]}"}

        resp = await http_request_with_retry(
            client,
            "POST",
            "https://api.example.com/v1/transcribe",
            config={"http_retry": {"status_codes": [401], "max_retries": 2, "delay": 0}},
            headers_fn=fresh_headers,
        )
        assert resp.status_code == 200
        # Check that second call got the updated key
        second_call_headers = client.post.call_args_list[1].kwargs["headers"]
        assert second_call_headers["Authorization"] == "Bearer new_key"

    @pytest.mark.asyncio
    async def test_re_resolve_key_called_before_retry(self):
        client = AsyncMock()
        client.post.side_effect = [_make_response(401), _make_response(200)]
        re_resolve = MagicMock()

        await http_request_with_retry(
            client,
            "POST",
            "https://api.example.com/v1/transcribe",
            config={"http_retry": {"status_codes": [401], "max_retries": 2, "delay": 0}},
            headers_fn=lambda: {"Authorization": "Bearer key"},
            re_resolve_key=re_resolve,
        )
        assert re_resolve.call_count == 1

    @pytest.mark.asyncio
    async def test_disabled_by_default_no_retry(self):
        """When max_retries=0 (default), 401 raises immediately."""
        client = AsyncMock()
        client.post.return_value = _make_response(401)

        with pytest.raises(httpx.HTTPStatusError):
            await http_request_with_retry(
                client,
                "POST",
                "https://api.example.com/v1/transcribe",
                config={},
                headers_fn=lambda: {"Authorization": "Bearer key"},
            )
        assert client.post.call_count == 1
