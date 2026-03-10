FROM node:22-alpine as build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
RUN npm run build:server

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

# Create data directory for SQLite
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data

EXPOSE 80
ENV PORT=80

CMD ["node", "dist-server/server.js"]
