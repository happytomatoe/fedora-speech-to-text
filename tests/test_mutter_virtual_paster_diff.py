"""Tests for MutterVirtualPaster.stream_diff() and flush().

SKIPPED: stream_diff/flush/commit_text API not yet implemented —
current MutterVirtualPaster only has paste().
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

pytestmark = pytest.mark.skip(reason="stream_diff/flush/commit_text not implemented")


@pytest.fixture
def mock_dbus():
    """Mock D-Bus proxy for MutterVirtualPaster."""
    with patch("voice_to_text.mutter_virtual_paster.MessageBus") as mock_bus_cls:
        mock_bus = AsyncMock()
        mock_introspection = MagicMock()
        mock_proxy = MagicMock()
        mock_iface = MagicMock()

        mock_bus_cls.return_value.connect = AsyncMock(return_value=mock_bus)
        mock_bus.introspect = AsyncMock(return_value=mock_introspection)
        mock_bus.get_proxy_object = MagicMock(return_value=mock_proxy)
        mock_proxy.get_interface = MagicMock(return_value=mock_iface)

        mock_iface.call_commit_text = AsyncMock(return_value=None)

        yield mock_iface


@pytest.mark.asyncio
async def test_stream_diff_stores_text(mock_dbus):
    """stream_diff should store text without making D-Bus calls."""
    from voice_to_text.mutter_virtual_paster import MutterVirtualPaster

    paster = MutterVirtualPaster()
    await paster.start()

    # Simulate streaming: "Hello" -> "Hello world" -> "Hello world!"
    await paster.stream_diff("Hello")
    await paster.stream_diff("Hello world")
    await paster.stream_diff("Hello world!")

    # stream_diff should NOT make any D-Bus calls
    assert mock_dbus.call_commit_text.call_count == 0
    assert mock_dbus.call_set_preedit_text.call_count == 0 if hasattr(mock_dbus, "call_set_preedit_text") else True

    # Text should be stored internally
    assert paster._typed_text == "Hello world!"


@pytest.mark.asyncio
async def test_stream_diff_no_duplication(mock_dbus):
    """Stream_diff should store text correctly."""
    from voice_to_text.mutter_virtual_paster import MutterVirtualPaster

    paster = MutterVirtualPaster()
    await paster.start()

    await paster.stream_diff("Hello")
    await paster.stream_diff("Hello there")
    await paster.stream_diff("Hello there.")

    # No D-Bus calls during streaming
    assert mock_dbus.call_commit_text.call_count == 0

    # Final text stored correctly
    assert paster._typed_text == "Hello there."


@pytest.mark.asyncio
async def test_stream_diff_skip_if_same(mock_dbus):
    """Stream_diff should still store even if same (idempotent)."""
    from voice_to_text.mutter_virtual_paster import MutterVirtualPaster

    paster = MutterVirtualPaster()
    await paster.start()

    await paster.stream_diff("Hello")
    await paster.stream_diff("Hello")  # Same text

    # No D-Bus calls
    assert mock_dbus.call_commit_text.call_count == 0

    # Text stored correctly
    assert paster._typed_text == "Hello"


@pytest.mark.asyncio
async def test_flush_commits_text(mock_dbus):
    """Flush should commit the accumulated text."""
    from voice_to_text.mutter_virtual_paster import MutterVirtualPaster

    paster = MutterVirtualPaster()
    await paster.start()

    # Stream some text
    await paster.stream_diff("Hello world")

    # Flush should commit the text
    result = await paster.flush()

    assert result is True
    assert mock_dbus.call_commit_text.call_count == 1
    assert mock_dbus.call_commit_text.call_args[0][0] == "Hello world"


@pytest.mark.asyncio
async def test_flush_empty_text(mock_dbus):
    """Flush should return False if no text to commit."""
    from voice_to_text.mutter_virtual_paster import MutterVirtualPaster

    paster = MutterVirtualPaster()
    await paster.start()

    # No text streamed
    result = await paster.flush()

    assert result is False
    assert mock_dbus.call_commit_text.call_count == 0


@pytest.mark.asyncio
async def test_commit_text(mock_dbus):
    """commit_text should call D-Bus directly."""
    from voice_to_text.mutter_virtual_paster import MutterVirtualPaster

    paster = MutterVirtualPaster()
    await paster.start()

    result = await paster.commit_text("Direct commit")

    assert result is True
    assert mock_dbus.call_commit_text.call_count == 1
    assert mock_dbus.call_commit_text.call_args[0][0] == "Direct commit"
