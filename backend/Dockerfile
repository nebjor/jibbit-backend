# ─── jibbit.ch Medusa v2 Backend ──────────────────────────────
# Zweistufig: `medusa build` erzeugt unter .medusa/server eine
# eigenständige Server-Anwendung mit eigenem package.json. Nur die
# wandert ins Runtime-Image — Quellcode und Dev-Abhängigkeiten nicht.

FROM node:20-alpine AS builder

WORKDIR /app

# node-gyp braucht eine Toolchain für native Module (z.B. sharp)
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --maxsockets=8 --fetch-timeout=120000 --fetch-retries=5

COPY . .
RUN npm run build


FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# nur das Build-Ergebnis übernehmen
COPY --from=builder /app/.medusa/server ./

# das generierte package.json bringt keine Lockfile mit → install statt ci
RUN npm install --omit=dev --maxsockets=8 --fetch-timeout=120000 \
  && npm cache clean --force

RUN mkdir -p /app/uploads && chown -R node:node /app
USER node

EXPOSE 9000

CMD ["npm", "run", "start"]
