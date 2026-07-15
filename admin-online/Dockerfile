FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787
ENV PREDDITA_DATA_DIR=/data

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p /data

EXPOSE 8787

CMD ["node", "server.mjs"]
