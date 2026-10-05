#!/bin/sh
# Compiles the trip runner, which links the real firmware core.
set -eu
cd "$(dirname "$0")"
mkdir -p build
g++ -std=c++11 -O2 -Wall -Wextra -Werror -pedantic runner.cpp -o build/runner
