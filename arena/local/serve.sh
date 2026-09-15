#!/bin/sh
# OpenAI-compatible endpoint for the local seat (tool calls + prefix cache come
# with mlx_lm.server). Thinking is off so training and inference prompts match.
#   arena/local/serve.sh [adapter dir]      then: MINDFRONT_LLM_URL=http://localhost:9300/v1/chat/completions npx tsx arena/brain.ts --roster arena/roster.local.json ...
cd "$(dirname "$0")"
MODEL=${MODEL:-models/Qwen3-30B-A3B-Instruct-2507-4bit}
ADAPTER=${1:+--adapter-path $1}
exec .venv/bin/python -m mlx_lm.server --model "$MODEL" $ADAPTER --port 9300 --max-tokens 600 \
  --chat-template-args '{"enable_thinking": false}' --log-level WARNING
