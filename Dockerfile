FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000
ENV DATA_FILE=/data/db.json
EXPOSE 3000
CMD ["node", "server.js"]
