FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY server.js quicksearch.html ./

USER node
EXPOSE 3000

CMD ["node", "server.js"]
