FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

VOLUME ["/data"]

CMD ["node", "index.js"]
