FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY spec ./spec

RUN mkdir -p /app/data
ENV PORT=3000
EXPOSE 3000

CMD ["node", "--experimental-sqlite", "server.js"]