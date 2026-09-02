import asyncio

import pytest

from voice_to_text.providers.base import close_shared_client


@pytest.fixture(autouse=True)
def _reset_shared_http_client():
    """Reset the shared httpx client singleton after each test.

    Some tests assign instance attributes (e.g. `provider._client.post = ...`)
    on the shared client; without a reset that polluted state leaks into
    later tests and breaks mock patching of `httpx.AsyncClient.post`.
    """
    yield
    asyncio.run(close_shared_client())
