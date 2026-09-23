# Produktbilder

Wie Fotos vom kDrive in den Shop kommen — und warum sie einen Neustart
überleben.

## Wo die Bilder liegen

Medusas `file`-Modul benutzt den lokalen Provider. Der schreibt die Dateien in
ein Verzeichnis des Containers; ausgeliefert werden sie unter `/static/…`.

Der Auslieferungspfad ist **fest verdrahtet**:

```js
app.use("/static", express.static(path.join(baseDir, "static")))
// @medusajs/framework/dist/http/express-loader.js
```

`baseDir` ist das Verzeichnis, aus dem `medusa-config` geladen wurde, im
Container also `/app`. Daraus folgt alles Weitere:

| | |
|---|---|
| Ablage- und Auslieferungsort | `/app/static` |
| Docker-Volume | `medusa_data:/app/static` |
| Umgebungsvariable | `MEDUSA_UPLOAD_DIR=/app/static` |
| URL in der Datenbank | `${MEDUSA_BACKEND_URL}/static/<key>` |

**Die Falle, die hier vorher stand:** Das Volume war auf `/app/uploads`
gemountet. Dorthin schreibt niemand. Hochgeladene Bilder lagen im
Container-Dateisystem und wären beim nächsten `docker compose up` weg gewesen —
ohne Fehlermeldung, weil bis dahin alles funktioniert.

Zweite Falle: `upload_dir` ist beim Provider per Default `process.cwd() +
"/static"`, und `process.cwd()` ist bei einem `docker compose exec -w …` nicht
zwangsläufig `/app`. Deshalb steht der Pfad in `backend/medusa-config.ts`
absolut.

`MEDUSA_BACKEND_URL` wird beim Upload in die Datenbank geschrieben und ist
danach nicht mehr aus der Umgebung korrigierbar — ein falscher Wert bedeutet,
alle Bilder erneut hochzuladen. `import-product-images.ts` prüft das deshalb
selbst und bricht ab, wenn die Variable fehlt, keine gültige URL ist oder bei
`NODE_ENV=production` auf `localhost`/`medusa` zeigt. Für Test- und
Vorschauboxen ohne eigene API-Domain gibt es die Option `allow-internal-url`;
die Storefront selbst kommt damit zurecht, der Medusa-Admin und
Produktdaten-Feeds nicht.

## Bilder aufbereiten (einmal, auf dem Entwicklungsrechner)

```bash
npm install          # sharp ist devDependency der Repository-Wurzel
node scripts/prepare-product-images.mjs \
  "/mnt/c/Users/jnebe/kDrive/jibbit/Media/Produktfotos" \
  backend/media/produktbilder \
  backend/media/product-images.json
```

Erzeugt je Vorlage eine WebP-Fassung (die wird ausgeliefert) und eine
JPEG/PNG-Rückfallebene, längere Kante höchstens 1200 px, ohne Hochskalieren.
Die Begründung der Masse steht im Kopf des Scripts. Ergebnis committen.

Die Zuordnung Foto → Produkt steht in `backend/media/product-images.json`. Der
`product`-Wert muss dem Produkttitel **exakt** entsprechen; das erste Bild je
Produkt wird zum Vorschaubild.

## Hochladen (auf der VPS)

```bash
cd /opt/jibbit/medusa-ecom
docker compose cp ./backend/media medusa:/app/media

# erst schauen — Probelauf ist der Normalfall
docker compose exec medusa npx medusa exec \
  ./src/scripts/import-product-images.js \
  /app/media/product-images.json

# dann schreiben — `schreiben` als erstes Argument nach dem Script-Pfad
docker compose exec medusa npx medusa exec \
  ./src/scripts/import-product-images.js schreiben \
  /app/media/product-images.json
```

Achtung, **`.js` nicht `.ts`**: der Laufzeitcontainer enthält nur das Ergebnis
von `medusa build`, und das sind ausschliesslich kompilierte Dateien. (Das gilt
auch für `seed.js`, `import-catalog.js` und `import-price-tiers.js` — in
DEPLOY-HEUTE.md stehen die noch mit `.ts`.)

Der Ordner muss mit `docker compose cp` in den Container, weil `medusa build`
aus `src/` keine Bilder mitnimmt.

Das Script ist idempotent: ein zweiter Lauf lädt nichts erneut hoch und legt
keine Dubletten an. Wächst die Zuordnung um ein weiteres Foto, ergänzt der
nächste Lauf genau dieses. Buchgeführt wird das in
`product.metadata.image_sources` (Quelldateiname → hochgeladene URLs).

## Prüfen

```bash
# Datei liegt im Volume und wird ausgeliefert
docker compose exec medusa ls /app/static | head
curl -sI https://api-test.jibbit.ch/static/<key>

# überlebt den Neustart
docker compose down && docker compose up -d
curl -sI https://api-test.jibbit.ch/static/<key>
```

## Anzeige in der Storefront

Die Storefront lädt Produktbilder **nicht** direkt von der Backend-Adresse,
sondern über eine eigene Route (`/media/<host>/<key>`). Grund: die
Backend-Adresse eines Tenants ist im Regelfall gar nicht öffentlich erreichbar
(`http://medusa:9000`), und `next/image` prüft fremde Herkünfte gegen eine zur
Build-Zeit festgelegte Liste, die es im Mehrmandantenbetrieb nicht geben kann.
Ausführlich in `jibbit-frontend/lib/media.ts` und `next.config.ts`.

## Wenn später ein Objektspeicher dazukommt

Dann ändert sich `backend/medusa-config.ts` (S3-Provider statt local), und die
URLs enthalten kein `/static/` mehr. Die Storefront erkennt das und liefert
solche Bilder unverändert aus, statt sie zu proxen — für die Optimierung durch
`next/image` braucht es dann einen `images.remotePatterns`-Eintrag mit der
CDN-Adresse.
