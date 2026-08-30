use strict;
use warnings;
use base 'basetest';
use testapi;

sub run {
    my $self = shift;

    # Wait for login prompt on virtio console
    select_console 'virtio-console';
    wait_serial 'localhost login:', 180;

    # Wait for graphical to come up
    sleep 15;

    # Switch to graphical console (VNC)
    select_console 'sut';

    # Wait for GDM login screen
    assert_screen 'login-screen', 60;

    # Type username
    type_string "testuser\n";

    # Wait for password prompt
    assert_screen 'password-prompt', 30;

    # Try password "testuser" (from our cloud-init config)
    type_string "testuser\n";

    # Wait a bit and take screenshot to see what happens
    sleep 5;
    save_screenshot;

    return 1;
}

sub test_flags {
    return { fatal => 1 };
}

1;
