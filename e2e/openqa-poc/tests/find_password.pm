use strict;
use warnings;
use base 'basetest';
use testapi;

sub run {
    select_console('virtio-console');
    wait_serial('localhost login:', 180);

    my @passwords = ('', 'testuser', 'password', 'test', 'fedora', 'root');

    foreach my $pwd (@passwords) {
        type_string("testuser\n");
        wait_serial('Password:', 10);
        type_string("$pwd\n");

        my $output = wait_serial(qr/Login incorrect|Last login|# \$|% \$|\$ /, 10);
        if ($output) {
            if ($output =~ /Last login/ || $output =~ /# \$/ || $output =~ /% \$/ || $output =~ /\ \$/) {
                record_info("Found working password: '$pwd'");
                # Reached login prompt - user found
                # Save a screenshot of the desktop after login
                save_screenshot;
                die "Password found, stopping test";
            }
        }
        # Login incorrect, try next password
    }

    die "No working password found";
}

sub test_flags {
    return { fatal => 1 };
}

1;
