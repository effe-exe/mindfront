#!/bin/sh
# Same local model for coding: thinking ON, longer answers, port 9301.
# Run it when the arena is not using the GPU (a second copy is another 20 GB).
cd "$(dirname "$0")"
MODEL=${MODEL:-models/Qwen3.6-35B-A3B-4bit}
exec .venv/bin/python -m mlx_lm.server --model "$MODEL" --port 9301 --max-tokens 4000 --log-level WARNING
