# POC: boot golden image, verify graphical login screen

use Mojo::Base 'basetest';
use testapi;

sub run {
    my $self = shift;

    # Wait for login prompt on virtio console
    select_console 'virtio-console';
    wait_serial 'localhost login:', 180;
    
    # Wait a bit more for graphical to come up
    sleep 10;
    
    # Switch to graphical console (VNC) - default is 'sut'
    select_console 'sut';
    assert_screen 'login-screen', 60;
    
    # Success
    return 1;
}

1;