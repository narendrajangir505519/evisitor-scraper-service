# Node + Pre-installed Chrome aur saari required OS libraries ke sath official image
FROM ghcr.io/puppeteer/puppeteer:22.6.0

# Cloud Run / Container ke liye environment setup
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    PORT=8080 \
    NODE_ENV=production

# Root user se working directory create aur permissions set karein
USER root
WORKDIR /app

# Package files copy karein aur install karein
COPY package*.json ./
RUN npm ci --only=production

# Baaki code copy karein aur ownership 'pptruser' ko dein (Security best practice)
COPY . .
RUN chown -R pptruser:pptruser /app

# Non-root user par switch karein (Chrome bina root ke chalne ke liye zaroori hai)
USER pptruser

EXPOSE 8080

CMD ["node", "index.js"]
