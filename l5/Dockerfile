FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY *.js ./
COPY public ./public
ENV HOST=0.0.0.0 DATA_DIR=/app/data
CMD ["node", "server.js"]
