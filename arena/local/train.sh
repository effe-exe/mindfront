#!/bin/sh
# LoRA on the 4-bit MLX model with the human-replay dataset. Overnight job.
#   [MODEL=..] [CFG=lora-q3.yaml] [LAYERS=16] [GC=--grad-checkpoint] [RESUME=adapters/x/adapters.safetensors] [DATA=data] [MAXSEQ=4608] [EVERY=500] arena/local/train.sh [adapter name=v1] [iters=2500]
set -e
cd "$(dirname "$0")"
MODEL=${MODEL:-models/Qwen3-30B-A3B-Instruct-2507-4bit}
NAME=${1:-v1}; ITERS=${2:-2500}
DATA=${DATA:-data}; MAXSEQ=${MAXSEQ:-4608}; EVERY=${EVERY:-500}
CFG=${CFG:-lora-q3.yaml}; LAYERS=${LAYERS:-16}; GC=${GC---grad-checkpoint}; RESUME=${RESUME:+--resume-adapter-file $RESUME}
mkdir -p adapters
.venv/bin/python -m mlx_lm.lora --model "$MODEL" --train --data "$DATA" -c "$CFG" \
  --fine-tune-type lora --num-layers "$LAYERS" --batch-size 1 $GC $RESUME --mask-prompt \
  --max-seq-length "$MAXSEQ" --iters "$ITERS" --steps-per-report 25 --steps-per-eval "$EVERY" --val-batches 25 --save-every "$EVERY" \
  --adapter-path "adapters/$NAME" 2>&1 | tee "adapters/$NAME.log"
.venv/bin/python -m mlx_lm.lora --model "$MODEL" --adapter-path "adapters/$NAME" --data "$DATA" --test 2>&1 | tail -3
