FROM node:22-alpine as build
WORKDIR /app
COPY package*.json ./
# npm ci (no npm install): instala EXACTO lo del package-lock.json y falla ruidoso
# si está desincronizado. Así el deploy reproduce lo que valida el CI (.github/workflows/ci.yml).
RUN npm ci
COPY . .
RUN npm run build
RUN npm run build:server

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

# Create data directory for SQLite
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data

EXPOSE 80
ENV PORT=80

CMD ["node", "dist-server/server.js"]
