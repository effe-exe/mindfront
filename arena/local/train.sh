#!/bin/sh
# LoRA on the 4-bit MLX model with the human-replay dataset. Overnight job.
#   arena/local/train.sh [adapter name=v1] [iters=2500]
set -e
cd "$(dirname "$0")"
MODEL=${MODEL:-models/Qwen3-30B-A3B-Instruct-2507-4bit}
NAME=${1:-v1}; ITERS=${2:-2500}
mkdir -p adapters
.venv/bin/python -m mlx_lm.lora --model "$MODEL" --train --data data -c lora-q3.yaml \
  --fine-tune-type lora --num-layers 16 --batch-size 1 --grad-checkpoint --mask-prompt \
  --max-seq-length 4608 --iters "$ITERS" --steps-per-report 25 --steps-per-eval 500 --val-batches 25 --save-every 500 \
  --adapter-path "adapters/$NAME" 2>&1 | tee "adapters/$NAME.log"
.venv/bin/python -m mlx_lm.lora --model "$MODEL" --adapter-path "adapters/$NAME" --data data --test 2>&1 | tail -3
