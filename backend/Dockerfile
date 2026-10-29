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
# .npmrc MUSS mit hinein: es setzt legacy-peer-deps, ohne das `npm ci` am
# exakt auf @medusajs/*@2.18.0 gepinnten peerDependencies-Block von
# @zahls/medusa-plugin scheitert (Projekt: 2.13.6). Begruendung in .npmrc.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --maxsockets=8 --fetch-timeout=120000 --fetch-retries=5

# ACHTUNG — kleine VPS.
# V8 leitet sein Old-Space-Limit aus dem PHYSISCHEN RAM ab, nicht aus dem
# verfuegbaren Speicher inklusive Swap. Auf einer 2-GB-Kiste landet der
# Default bei rund 1 GB, und der Build stirbt mit "JavaScript heap out of
# memory" — auch dann, wenn reichlich Swap da ist, weil V8 ihn nie anfasst.
#
# Der Wert DARF das physische RAM ueberschreiten, solange Swap existiert.
# Ueber docker-compose.yml (build.args) oder --build-arg anpassbar.
ARG NODE_BUILD_MEMORY=3072
ENV NODE_OPTIONS="--max-old-space-size=${NODE_BUILD_MEMORY}"
COPY . .
RUN npm run build


FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# ACHTUNG — Reihenfolge ist hier entscheidend, in zwei Richtungen.
#
# 1. `node` BRAUCHT Schreibrechte auf node_modules. Medusas Migrationslauf
#    legt Verzeichnisse innerhalb der Modulpakete an; ohne Schreibrecht
#    scheitert `db:migrate` mit
#      EACCES: permission denied, mkdir '/app/node_modules/@medusajs/file/dist/migrations'
#    Es genuegt also NICHT, nur /app/static zu uebereignen.
#
# 2. Ein nachgelagertes `chown -R node:node /app` erledigt das zwar, kostet
#    aber auf einer 1-vCPU-VPS ueber 18 Minuten und schreibt jede beruehrte
#    Datei ein zweites Mal ins Image.
#
# Loesung: frueh auf USER node wechseln. Dann entstehen COPY-Ergebnis und
# npm-Installation direkt mit den richtigen Rechten — kein zusaetzlicher
# Durchlauf, keine doppelte Schicht.
# /app/static ist der Ablage- UND Auslieferungsort fuer Produktbilder (siehe
# medusa-config.ts). Es muss VOR dem Volume-Mount existieren und `node`
# gehoeren: Docker legt ein fehlendes Mount-Ziel sonst als root an, und der
# Upload scheitert mit EACCES.
# /app/buchhaltung: Schnappschuesse der Buchhaltung (BUCHHALTUNG_DIR), gleiche Regel.
RUN mkdir -p /app/static /app/buchhaltung && chown node:node /app /app/static /app/buchhaltung
USER node

# nur das Build-Ergebnis übernehmen
COPY --from=builder --chown=node:node /app/.medusa/server ./

# .npmrc auch hier: `medusa build` kopiert es nicht nach .medusa/server,
# und das npm install unten liefe sonst in denselben ERESOLVE-Abbruch
# (@zahls/medusa-plugin pinnt seine Peers exakt auf 2.18.0).
COPY --chown=node:node .npmrc ./

# das generierte package.json bringt keine Lockfile mit → install statt ci
RUN npm install --omit=dev --maxsockets=8 --fetch-timeout=120000 \
  && npm cache clean --force

EXPOSE 9000

CMD ["npm", "run", "start"]
