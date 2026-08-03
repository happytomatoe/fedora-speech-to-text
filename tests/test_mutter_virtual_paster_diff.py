"""Tests for MutterVirtualPaster.stream_diff() incremental typing."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


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

        # Make call_commit_text return a coroutine
        mock_iface.call_commit_text = AsyncMock(return_value=None)

        yield mock_iface


@pytest.mark.asyncio
async def test_stream_diff_tracks_diff(mock_dbus):
    """stream_diff should only commit the NEW text, not the full text."""
    from voice_to_text.mutter_virtual_paster import MutterVirtualPaster

    paster = MutterVirtualPaster()
    await paster.start()

    # Simulate streaming: "Hello" -> "Hello world" -> "Hello world!"
    await paster.stream_diff("Hello")
    await paster.stream_diff("Hello world")
    await paster.stream_diff("Hello world!")

    # Check what was committed - should only be the DIFF each time
    calls = mock_dbus.call_commit_text.call_args_list
    assert len(calls) == 3
    # First call: "Hello" (new)
    assert calls[0][0][0] == "Hello"
    # Second call: " world" (only the new part, not "Hello world")
    assert calls[1][0][0] == " world", f"Expected ' world' but got '{calls[1][0][0]}'"
    # Third call: "!" (only the new part)
    assert calls[2][0][0] == "!", f"Expected '!' but got '{calls[2][0][0]}'"


@pytest.mark.asyncio
async def test_stream_diff_no_duplication(mock_dbus):
    """Stream_diff should not duplicate text."""
    from voice_to_text.mutter_virtual_paster import MutterVirtualPaster

    paster = MutterVirtualPaster()
    await paster.start()

    # Simulate streaming partial transcriptions
    await paster.stream_diff("Hello")
    await paster.stream_diff("Hello there")
    await paster.stream_diff("Hello there.")

    # Check what was committed - should be ONLY the diff each time
    calls = mock_dbus.call_commit_text.call_args_list
    assert len(calls) == 3
    assert calls[0][0][0] == "Hello"  # First call: full text
    assert calls[1][0][0] == " there"  # Second call: only new part
    assert calls[2][0][0] == "."  # Third call: only new part


@pytest.mark.asyncio
async def test_stream_diff_skip_if_same(mock_dbus):
    """Stream_diff should skip if text hasn't changed."""
    from voice_to_text.mutter_virtual_paster import MutterVirtualPaster

    paster = MutterVirtualPaster()
    await paster.start()

    await paster.stream_diff("Hello")
    await paster.stream_diff("Hello")  # Same text

    # Should only commit once
    assert mock_dbus.call_commit_text.call_count == 1
