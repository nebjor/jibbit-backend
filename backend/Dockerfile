# ─── jibbit.ch Medusa v2 Backend ──────────────────────────────
# Zweistufig: `medusa build` erzeugt unter .medusa/server eine
# eigenständige Server-Anwendung mit eigenem package.json. Nur die
# wandert ins Runtime-Image — Quellcode und Dev-Abhängigkeiten nicht.

FROM node:20-alpine AS builder

WORKDIR /app

# node-gyp braucht eine Toolchain für native Module (z.B. sharp)
RUN apk add --no-cache python3 make g++

# ACHTUNG — Workspace-Falle.
# Das Repo ist ein npm-Workspace mit Root in ../ (workspaces: ["backend"]).
# Der Build-Context hier ist aber NUR backend/, also gibt es im Image keine
# Root-package.json: `npm ci` nutzt backend/package-lock.json eigenständig.
#
# Ein `npm install` im Repo-Root aktualisiert jedoch die ROOT-Lockfile und
# lässt diese hier unberührt zurück — sie veraltet still, und der Image-Build
# bricht ab ("lock file's axios@… does not satisfy axios@…"), während lokal
# alles funktioniert.
#
# Nach jeder Dependency-Änderung deshalb auch diese Lockfile isoliert
# neu erzeugen (package.json + Lockfile in ein leeres Verzeichnis kopieren,
# dort `npm install --package-lock-only`, Ergebnis zurückkopieren) und mit
# `npm ci --dry-run` prüfen. Dauerhafte Alternative: aus dem Workspace-Root
# bauen oder den Ein-Member-Workspace ganz auflösen.
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
