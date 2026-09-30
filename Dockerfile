FROM mcr.microsoft.com/playwright:v1.43.0-jammy

WORKDIR /app

# Dependencies copy & install
COPY package*.json ./
RUN npm install --production

# Application code copy
COPY . .

ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "index.js"]
