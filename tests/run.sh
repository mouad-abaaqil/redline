#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
bin=$(mktemp "${TMPDIR:-/tmp}/redline-core.XXXXXX")
trap 'rm -f "$bin"' EXIT HUP INT TERM

g++ -std=c++11 -Wall -Wextra -Werror -pedantic \
  "$project_dir/tests/test_core.cpp" -o "$bin"
"$bin"
