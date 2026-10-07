#!/bin/bash
# Restart webshell persistently (survives session close).
# Kills session-bound instance, installs/starts systemd service.

set -euo pipefail

PIDFILE=/tmp/webshell.pid

# 1. Stop any running session-bound server
OLDPID=$(cat "$PIDFILE" 2>/dev/null || pgrep -f 'node server\.js' | head -1 || true)
if [ -n "$OLDPID" ]; then
  echo "Stopping old session-bound server (PID $OLDPID)..."
  kill -SIGTERM "$OLDPID" 2>/dev/null || true
  sleep 1
  kill -0 "$OLDPID" 2>/dev/null && kill -SIGKILL "$OLDPID" || true
fi

# 2. Write service file
SERVICE=/etc/systemd/system/webshell.service
if [ ! -f "$SERVICE" ]; then
  echo "Installing webshell.service..."
  cp /var/home/Heterodoxin/webshell/webshell.service "$SERVICE"
fi

# 3. Restart via systemd (survives session death)
echo "Starting persistent webshell via systemd..."
if command -v systemctl >/dev/null; then
  systemctl daemon-reload 2>/dev/null || true
  systemctl enable webshell.service
  systemctl restart webshell.service
  echo "Started. Check: systemctl status webshell"
else
  echo "systemctl not available — falling back to nohup"
  nohup /home/linuxbrew/.linuxbrew/bin/node /var/home/Heterodoxin/webshell/server.js > /dev/null 2>&1 &
  echo $! > "$PIDFILE"
  echo "Started in background (PID $(cat "$PIDFILE"))."
fi

echo "Done. The server will stay alive after this tab closes."
