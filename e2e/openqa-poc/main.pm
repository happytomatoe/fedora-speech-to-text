# openQA POC entrypoint: loads the vtdistribution and runs the test named
# in $bmwqemu::vars{TEST}. The local @INC is the directory of this file,
# so the POC works on the host or inside a container without path edits.

use strict;
use warnings;
use FindBin '$Bin';
use lib '/usr/lib/os-autoinst';
use lib "$Bin";
use testapi;
use autotest;
use bmwqemu;

# Register our minimal distribution
require vtdistribution;
testapi::set_distribution(vtdistribution->new());

# Get test to run from TEST variable (default: login_with_password)
my $test = $bmwqemu::vars{TEST} // 'login_with_password';
autotest::loadtest "tests/$test.pm";

1;
