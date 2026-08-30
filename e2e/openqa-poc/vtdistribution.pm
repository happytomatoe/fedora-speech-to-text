# Minimal distribution for openQA POC. Uses os-autoinst's base `distribution`
# class (no fedoradistribution dependency) and registers the consoles we need.
#
# Console pipe paths default to the directory holding vars.json (CASEDIR),
# which is set by isotovideo to the CWD at run time. Override by exporting
# CASEDIR in the environment before invoking isotovideo.

package vtdistribution;

use strict;
use warnings;
use base 'distribution';

sub new {
    my ($class) = @_;
    my $self = $class->SUPER::new();
    return $self;
}

sub init {
    my ($self) = @_;
    my $casedir = $ENV{CASEDIR} // '.';

    # Register virtio console (for serial interaction with the SUT)
    $self->add_console('virtio-console' => 'virtio-terminal',
        { socked_path => "$casedir/virtio_console" });

    # Register root console (alternative serial access path)
    $self->add_console('root-console' => 'virtio-terminal',
        { socked_path => "$casedir/virtio_console_user" });

    # Register serial console (the default)
    $self->add_console('serial0' => 'virtio-terminal',
        { socked_path => "$casedir/serial0" });
}

sub test_modules {
    my ($self) = @_;
    return [qw(login_with_password)];
}

sub post_fail_hook {
    my ($self, $test) = @_;
    # no-op: avoid any cleanup that might fail after a test failure
}

sub name {
    return 'vtdistribution';
}

1;
