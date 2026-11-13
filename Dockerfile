# Leaky Pipes game server (also serves the game page at /)
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY server ./server
COPY docs ./docs
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["node", "server/server.js"]
