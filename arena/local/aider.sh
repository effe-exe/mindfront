#!/bin/sh
# Aider on the local coding server (arena/local/serve-coding.sh must be running).
#   arena/local/aider.sh [files...]
export PATH="$HOME/.local/bin:$PATH"
export OPENAI_API_BASE=http://localhost:9301/v1
export OPENAI_API_KEY=local
exec aider --model openai/default_model --no-show-model-warnings --no-auto-commits --edit-format diff "$@"
