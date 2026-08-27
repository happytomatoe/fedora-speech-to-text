"""Test that D-Bus service name hasn't been changed."""


def test_dbus_service_name_in_dbus_service():
    """Verify the D-Bus service name constant is correct."""
    with open("src/voice_to_text/dbus_service.py") as f:
        content = f.read()
    assert 'SERVICE_NAME = "com.happytomatoe.VoiceToText"' in content


def test_dbus_service_name_in_service_files():
    """Verify the D-Bus service name in service files."""
    with open("service/com.happytomatoe.VoiceToText.service") as f:
        content = f.read()
    assert "Name=com.happytomatoe.VoiceToText" in content
    assert "SystemdService=com.happytomatoe.VoiceToText.user.service" in content

    with open("service/com.happytomatoe.VoiceToText.user.service") as f:
        content = f.read()
    assert "BusName=com.happytomatoe.VoiceToText" in content


def test_dbus_service_name_in_gnome_extension():
    """Verify the D-Bus service name in GNOME extension."""
    with open("gnome-ext/extension.js") as f:
        content = f.read()
    assert "com.happytomatoe.VoiceToText" in content


def test_dbus_service_name_in_prefs():
    """Verify the D-Bus service name in prefs."""
    with open("gnome-ext/prefs/device-row.js") as f:
        content = f.read()
    assert "com.happytomatoe.VoiceToText" in content
