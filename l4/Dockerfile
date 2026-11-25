FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY game.js server.js ./
COPY public ./public
ENV HOST=0.0.0.0 PORT=3104 DATA_DIR=/app/data
EXPOSE 3104
CMD ["node", "server.js"]
