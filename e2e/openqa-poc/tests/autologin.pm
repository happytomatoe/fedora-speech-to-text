use strict;
use warnings;
use base 'basetest';
use testapi;

sub run {
    my $self = shift;

    # Wait for login prompt on virtio console
    select_console 'virtio-console';
    wait_serial 'localhost login:', 180;

    # Wait for graphical desktop to come up (autologin should kick in)
    sleep 30;

    # Switch to graphical console (VNC)
    select_console 'sut';

    # With autologin configured, GNOME should boot directly to desktop
    # Try matching desktop
    assert_screen 'desktop', 60;

    # Take screenshot of the desktop
    save_screenshot;

    return 1;
}

sub test_flags {
    return { fatal => 1 };
}

1;
