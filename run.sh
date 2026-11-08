#!/usr/bin/env bash
# Keeps Stellar running: restarts it after a crash or a dropped connection.
cd "$(dirname "$0")"
while true; do
  npx tsx src/index.ts
  echo "[run.sh] exited with $? at $(date); restarting in 2 s"
  unset BOT_TOKEN
  sleep 2
done
