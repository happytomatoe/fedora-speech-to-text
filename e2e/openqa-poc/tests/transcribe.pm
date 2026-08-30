# openQA test: full voice-to-text pipeline
#
# Migrates the bun/TS e2e/e2e.ts flow to openQA. Boots the autologin image,
# then drives a real voice-to-text transcription: starts the voice service
# in debug mode (no microphone), sends the recording hotkey, waits for the
# extension to write the transcription to /tmp/file.txt, and asserts the
# contents match the expected text passed via vars.json's TEST_EXPECTED_TEXT.
#
# Required vars (in vars.json):
#   TEST_EXPECTED_TEXT     the expected transcription (default: a hello-world case)
#   TEST_VOICE_DEBUG_FILE  path on the SUT to the test wav (set by bake-voice)
#
# Pre-reqs on the host (before isotovideo starts):
#   - parakeet container running on 127.0.0.1:5092 (reachable from VM as
#     10.0.2.2:5092 thanks to QEMU's default user-mode networking)
#   - the autologin image has been re-baked with `just bake-voice`
#     (extension + service + /tmp/test-audio.wav + dconf seed)
#
# End-to-end time: ~2-3 min (GDM boot + record + transcribe).

use strict;
use warnings;
use base 'basetest';
use testapi;
use bmwqemu;

sub run {
    my $self = shift;

    my $expected = $bmwqemu::vars{TEST_EXPECTED_TEXT}
      // 'good morning, how are you today?';

    # --- Phase 1: GDM login (VNC console) ---------------------------------
    select_console 'virtio-console';
    wait_serial 'localhost login:', 180;
    select_console 'sut';
    assert_screen 'login-screen', 60;
    type_string "testuser\n";
    assert_screen 'password-prompt', 30;
    type_string "testuser\n";
    # The welcome-tour dialog is suppressed by a dconf key in bake-voice
    # (welcome-dialog-last-shown-version=999 in /etc/dconf/db/local.d).
    # Wait for desktop (Activities/TopBar visible)
    assert_screen 'desktop', 30;

    # --- Phase 2: log in on the serial console as testuser -----------------
    # We need a shell to start the voice service. The serial getty on hvc0
    # gets us a tty; the user bus d-bus is the same regardless of which
    # tty we start the service on, because XDG_RUNTIME_DIR is the same.
    select_console 'virtio-console';
    # There's no logout from the previous boot-time login yet (we
    # haven't actually logged in on this console during this test — we
    # just hit "localhost login:" once and switched away). Type the
    # testuser login here.
    wait_serial 'login:', 30;
    type_string "testuser\n";
    wait_serial 'Password:', 30;
    type_string "testuser\n";
    wait_serial(qr/\[testuser@|\$ /, 30);

    # --- Phase 3: Verify the bake-voice image is usable --------------------
    # The bake-voice recipe drops a marker file. If it's missing, fail
    # loud and clear instead of timing out mysteriously.
    assert_script_run 'test -f /var/tmp/voice-bake-src/.baked-marker', 10;
    assert_script_run 'test -s /tmp/test-audio.wav', 5;
    # D-Bus binary should be on PATH
    assert_script_run 'command -v voice-to-text-dbus', 5;
    # D-Bus service file installed
    assert_script_run 'test -f $HOME/.local/share/dbus-1/services/com.happytomatoe.VoiceToText.service', 5;
    # Config installed
    assert_script_run 'test -s $HOME/.config/voice-to-text/config.yaml', 5;
    # Extension installed
    assert_script_run 'test -f $HOME/.local/share/gnome-shell/extensions/voice-to-text@happytomatoe.com/extension.js', 5;

    # --- Phase 4: Start the voice service in debug mode --------------------
    assert_script_run 'pkill -f voice_to_text 2>/dev/null; rm -f /tmp/voice-service.log /tmp/file.txt; true', 5;
    background_script_run q{export PATH=$HOME/.local/bin:$PATH; export XDG_RUNTIME_DIR=/run/user/$(id -u); export VOICE_TO_TEXT_PROVIDER=parakeet; export VOICE_TO_TEXT_DEBUG_FILE=/tmp/test-audio.wav; export PYTHONPATH=$HOME/voice_to_text/src; cd $HOME; setsid python3 -m voice_to_text > /tmp/voice-service.log 2>&1 < /dev/null & disown};
    # Wait for the d-bus name to appear
    assert_script_run 'busctl --user list 2>/dev/null | grep -q com.happytomatoe.VoiceToText', 60;

    # --- Phase 5: Trigger the hotkey (VNC console) ------------------------
    # The extension's default hotkey is <Super>w. Sending it toggles
    # recording via the extension's _toggle() handler. We assume the
    # desktop is focused (assert_screen on `desktop` already confirmed
    # that the shell is up; clicking Activities away is up to the
    # extension, not us).
    select_console 'sut';
    send_key 'super-w';
    save_screenshot;

    # --- Phase 6: Wait for /tmp/file.txt (serial console) -----------------
    select_console 'virtio-console';
    # Service runs ~3s of fake audio level then transcribes the file
    # (10-30s with parakeet on host). Extension writes result.
    assert_script_run 'for i in $(seq 1 90); do test -s /tmp/file.txt && exit 0; sleep 1; done; echo TIMEOUT; tail -100 /tmp/voice-service.log; exit 1', 100;

    # --- Phase 7: Assert text matches --------------------------------------
    # Compare the actual text against the expected, ignoring case, trailing
    # punctuation, and extra whitespace (parakeet/voxtral can vary a bit).
    my $expected_norm = lc($expected);
    $expected_norm =~ s/\.+\z//;
    $expected_norm =~ s/\s+/ /g;
    $expected_norm =~ s/^\s+|\s+$//g;
    my $expected_re = quotemeta($expected_norm);
    assert_script_run
      qq{actual=\$(cat /tmp/file.txt); echo "actual: \$actual"; actual_norm="\$(echo "\$actual" | tr '[:upper:]' '[:lower:]' | tr -d '.' | tr -s ' ')"; case "\$actual_norm" in "$expected_re") echo MATCH;; *) echo "FAIL: expected '$expected_norm', got '\$actual_norm'"; tail -80 /tmp/voice-service.log; exit 1;; esac}, 10;

    save_screenshot;
    return 1;
}

sub test_flags {
    return { fatal => 1 };
}

1;
