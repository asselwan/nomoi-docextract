FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for layer caching.
COPY package.json ./
RUN npm install --omit=dev

# Application source.
COPY server.js ./
COPY lib ./lib

EXPOSE 8080

CMD ["node", "server.js"]
