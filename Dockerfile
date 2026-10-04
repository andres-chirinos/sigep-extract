FROM node:20-bookworm-slim

# Evitar prompts interactivos
ENV DEBIAN_FRONTEND=noninteractive

# Instalar dependencias de sistema: Xvfb, VNC, noVNC, Openbox, fuentes y librerías
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    curl \
    gnupg \
    ca-certificates \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    openbox \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-croscore \
    procps \
    libnss3 \
    libatk-bridge2.0-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcups2 \
    && rm -rf /var/lib/apt/lists/*

# Instalar Google Chrome Stable oficial
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/google-chrome-stable
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# Instalar dependencias Node.js
COPY package.json ./
RUN npm install --omit=dev

# Copiar scripts y entrypoint
COPY server_scraper.js ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 6080 5900

CMD ["./entrypoint.sh"]
