#!/bin/bash
set -e

# Limpiar posibles bloqueos previos en caso de reinicio de contenedor
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

export DISPLAY=:99
export RESOLUTION="${RESOLUTION:-1600x1000x24}"

echo "Iniciando servidor de display virtual Xvfb en :99 (${RESOLUTION})..."
Xvfb :99 -screen 0 ${RESOLUTION} -ac +extension GLX +render -noreset &

# Esperar a que el servidor X responda activamente
for i in $(seq 1 30); do
    if xset q > /dev/null 2>&1 || [ -e /tmp/.X11-unix/X99 ]; then
        echo "Xvfb inicializado correctamente en :99."
        break
    fi
    sleep 0.2
done

echo "Iniciando gestor de ventanas Openbox..."
openbox &
sleep 1

echo "Iniciando servidor x11vnc..."
x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -listen 0.0.0.0 -quiet > /dev/null 2>&1 &
sleep 1

echo "Iniciando noVNC (acceso web en http://localhost:6080/vnc.html)..."
websockify --web /usr/share/novnc 6080 localhost:5900 > /dev/null 2>&1 &
sleep 2

echo "Iniciando proceso extractor Puppeteer..."
exec node /app/server_scraper.js
