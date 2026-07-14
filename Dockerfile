FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY worker.mjs ./

CMD ["node", "worker.mjs"]
