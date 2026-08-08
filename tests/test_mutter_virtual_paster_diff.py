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

        # Make call_set_preedit_text return a coroutine
        mock_iface.call_set_preedit_text = AsyncMock(return_value=None)
        mock_iface.call_commit_text = AsyncMock(return_value=None)

        yield mock_iface


@pytest.mark.asyncio
async def test_stream_diff_tracks_diff(mock_dbus):
    """stream_diff should set preedit text with the full text each time."""
    from voice_to_text.mutter_virtual_paster import MutterVirtualPaster

    paster = MutterVirtualPaster()
    await paster.start()

    # Simulate streaming: "Hello" -> "Hello world" -> "Hello world!"
    await paster.stream_diff("Hello")
    await paster.stream_diff("Hello world")
    await paster.stream_diff("Hello world!")

    # Check what was set as preedit - should be the full text each time
    calls = mock_dbus.call_set_preedit_text.call_args_list
    assert len(calls) == 3
    # First call: "Hello" (full text)
    assert calls[0][0][0] == "Hello"
    # Second call: "Hello world" (full text, not just diff)
    assert calls[1][0][0] == "Hello world", f"Expected 'Hello world' but got '{calls[1][0][0]}'"
    # Third call: "Hello world!" (full text)
    assert calls[2][0][0] == "Hello world!", f"Expected 'Hello world!' but got '{calls[2][0][0]}'"
    # All calls should have commit=False (preedit mode)
    for call in calls:
        assert call[0][3] is False, "Expected commit=False for preedit mode"


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

    # Check what was set as preedit - should be the full text each time
    calls = mock_dbus.call_set_preedit_text.call_args_list
    assert len(calls) == 3
    assert calls[0][0][0] == "Hello"  # First call: full text
    assert calls[1][0][0] == "Hello there"  # Second call: full text
    assert calls[2][0][0] == "Hello there."  # Third call: full text


@pytest.mark.asyncio
async def test_stream_diff_skip_if_same(mock_dbus):
    """Stream_diff should skip if text hasn't changed."""
    from voice_to_text.mutter_virtual_paster import MutterVirtualPaster

    paster = MutterVirtualPaster()
    await paster.start()

    await paster.stream_diff("Hello")
    await paster.stream_diff("Hello")  # Same text

    # Should only set preedit once
    assert mock_dbus.call_set_preedit_text.call_count == 1


@pytest.mark.asyncio
async def test_commit_preedit(mock_dbus):
    """commit_preedit should commit the current preedit text."""
    from voice_to_text.mutter_virtual_paster import MutterVirtualPaster

    paster = MutterVirtualPaster()
    await paster.start()

    # Stream some text
    await paster.stream_diff("Hello world")

    # Commit the preedit
    result = await paster.commit_preedit()

    assert result is True
    # Should have called set_preedit_text with commit=True
    calls = mock_dbus.call_set_preedit_text.call_args_list
    assert len(calls) == 2  # One for stream_diff, one for commit_preedit
    assert calls[1][0][0] == "Hello world"  # The text being committed
    assert calls[1][0][3] is True  # commit=True
