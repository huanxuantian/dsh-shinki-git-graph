#!/bin/sh
# Git askpass launcher (POSIX) — see askpass-main.mjs for the rationale.
#
# git runs this as:  <this script> "Username for 'https://host': "
# `"$@"` stays QUOTED on purpose: the prompt must reach the helper as a single
# argv entry, so it can be parsed reliably (VS Code leaves it unquoted and then
# has to reconstruct the prompt from split words).
exec "${DSH_GIT_ASKPASS_NODE:-node}" "$DSH_GIT_ASKPASS_MAIN" "$@"
