#!/bin/bash
set -e

export DISPLAY=:99
export RESOLUTION="${RESOLUTION:-1600x1000x24}"

echo "Iniciando servidor de display virtual Xvfb en :99 (${RESOLUTION})..."
Xvfb :99 -screen 0 ${RESOLUTION} -ac +extension GLX +render -noreset &
sleep 2

echo "Iniciando gestor de ventanas Openbox..."
openbox &
sleep 1

echo "Iniciando servidor x11vnc..."
x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -listen 0.0.0.0 &
sleep 1

echo "Iniciando noVNC (acceso web en http://localhost:6080/vnc.html)..."
websockify --web /usr/share/novnc 6080 localhost:5900 &
sleep 2

echo "Iniciando proceso extractor Puppeteer..."
node /app/server_scraper.js
