FROM ghcr.io/puppeteer/puppeteer:latest

# Working directory set karein
WORKDIR /app

# Root user se package install karein
USER root
COPY package*.json ./
RUN npm install --production

COPY . .

# Cloud Run port env
ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
