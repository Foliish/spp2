FROM node:24-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./

FROM base AS test
RUN npm ci
COPY *.js schema.sql ./
COPY public ./public
COPY test ./test
CMD ["npm", "test"]

FROM base AS app
RUN npm ci --omit=dev
COPY *.js schema.sql ./
COPY public ./public
ENV HOST=0.0.0.0 NODE_ENV=production
CMD ["node", "server.js"]
