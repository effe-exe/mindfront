#!/bin/sh
# LoRA on the 4-bit MLX model with the human-replay dataset. Overnight job.
#   arena/local/train.sh [adapter name=v1] [iters=2500]
set -e
cd "$(dirname "$0")"
MODEL=${MODEL:-mlx-community/Qwen3.6-35B-A3B-4bit}
NAME=${1:-v1}; ITERS=${2:-2500}
mkdir -p adapters
.venv/bin/python -m mlx_lm.lora --model "$MODEL" --train --data data \
  --fine-tune-type lora --num-layers 16 --batch-size 1 --grad-checkpoint --mask-prompt \
  --max-seq-length 6000 --iters "$ITERS" --steps-per-report 20 --steps-per-eval 200 --save-every 200 \
  --adapter-path "adapters/$NAME" 2>&1 | tee "adapters/$NAME.log"
.venv/bin/python -m mlx_lm.lora --model "$MODEL" --adapter-path "adapters/$NAME" --data data --test 2>&1 | tail -3
