#!/bin/sh
# Copy the observation code and the dataset builder into the worktree that sits
# at the engine commit the archived games were played on, shimming observe.ts
# for that engine. Usage: arena/local/sync-worktree.sh [worktree=~/mindfront-replay]
set -e
SRC=$(cd "$(dirname "$0")/../.." && pwd)
WT=${1:-$HOME/mindfront-replay}
mkdir -p "$WT/arena/local"
cp "$SRC/arena/observe.ts" "$SRC/arena/types.ts" "$WT/arena/"
cp "$SRC/arena/local/dataset.ts" "$SRC/arena/local/prompt.ts" "$SRC/arena/local/tools.json" "$WT/arena/local/"
python3 "$SRC/arena/local/shim-observe.py" "$WT/arena/observe.ts"
[ -e "$WT/node_modules" ] || ln -s "$SRC/node_modules" "$WT/node_modules"
printf '{ "extends": "./tsconfig.json", "include": ["arena/**/*", "src/**/*"], "compilerOptions": { "noEmit": true } }\n' > "$WT/tsconfig.arena.json"
echo "synced to $WT ($(git -C "$WT" rev-parse --short HEAD))"
