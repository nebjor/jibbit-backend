#!/usr/bin/env node
/**
 * Produktfotos aus dem kDrive in web-taugliche Varianten umrechnen.
 *
 *   node scripts/prepare-product-images.mjs \
 *     "/mnt/c/Users/jnebe/kDrive/jibbit/Media/Produktfotos" \
 *     backend/media/produktbilder \
 *     backend/media/product-images.json
 *
 * Einmalwerkzeug: das Ergebnis liegt im Repository (backend/media/
 * produktbilder), damit der Import auf der VPS ohne kDrive-Zugriff und ohne
 * sharp im Backend-Image auskommt. Neu dazukommende Fotos einmal hier
 * durchschieben, Ergebnis committen.
 *
 * sharp ist bewusst NUR eine devDependency der Repository-WURZEL und steht
 * nicht in backend/package.json: das Backend-Image baut aus dem Kontext
 * backend/ mit backend/package-lock.json, und jede Abhängigkeit dort
 * verlängert den Build auf der 1-vCPU-VPS. Bildverarbeitung gehört nicht in
 * den Laufzeitcontainer.
 *
 * ─── Die gewählten Masse ───────────────────────────────────────────────
 *
 * MAX_EDGE = 1200 px, längere Kante, OHNE Hochskalieren.
 *
 * Hergeleitet aus dem Layout, nicht aus den vorhandenen Dateien:
 * Die grösste Darstellung ist das Hauptbild auf der Produktseite. Der Seiten-
 * container ist auf 1280 px begrenzt (`--page-max`), abzüglich 2 × 24 px
 * Innenabstand bleiben 1232 px; ab 900 px Breite teilt sich das in
 * `1.1fr 1fr` mit 48 px Spalt, die Bildspalte misst also rund 620 CSS-Pixel.
 * Auf einem Retina-Display mit DPR 2 sind das 1240 Gerätepixel — 1200 ist die
 * nächstkleinere runde Zahl und der Punkt, ab dem mehr Pixel nichts mehr
 * bringen.
 *
 * `withoutEnlargement` ist hier entscheidend: die vorhandenen Fotos sind
 * 381–749 px lang. Ein Hochskalieren auf 1200 würde die Dateien vervielfachen
 * und das Bild dabei weichzeichnen. Die Grenze greift heute also bei KEINER
 * Datei — sie ist der Deckel für das nächste 4000-px-Foto aus der Kamera.
 *
 * Nebenbefund fürs Protokoll: mit maximal 749 px Kantenlänge reichen die
 * Vorlagen für das Hauptbild auf einem Retina-Display NICHT aus; der Browser
 * skaliert dort hoch. Das ist kein Fehler dieses Scripts, sondern die
 * Auflösung der Quellen. Bessere Fotos schliessen die Lücke ohne Codeänderung.
 *
 * QUALITÄT 82. Über dem sharp-Default (80), weil auf den Vorlagen Verpackungs-
 * aufdrucke mit feiner Schrift zu sehen sind. Aus demselben Grund JPEG ohne
 * Chroma-Unterabtastung (4:4:4): 4:2:0 zerlegt gerade farbige Kanten und
 * kleine Schrift, was auf einem Papers-Heftchen sofort auffällt.
 *
 * ZWEI FORMATE. WebP ist das Bild, das in Medusa landet und ausgeliefert wird.
 * Daneben entsteht eine Fassung im breit unterstützten Ursprungsformat
 * (JPEG, bzw. PNG wenn das Bild wirklich transparent ist) als Rückfallebene
 * für alles, was kein WebP verdaut — etwa Produktdaten-Feeds. Welche Datei wo
 * landet, entscheidet import-product-images.ts.
 */

import { readFileSync, mkdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import sharp from "sharp";

const MAX_EDGE = 1200;
const QUALITY = 82;

const [srcDir, outDir, mapFile] = process.argv.slice(2);

if (!srcDir || !outDir || !mapFile) {
  console.error(
    "Aufruf: node scripts/prepare-product-images.mjs <quellordner> <zielordner> <mapping.json>",
  );
  process.exit(1);
}

const mapping = JSON.parse(readFileSync(resolve(mapFile), "utf8"));
const wanted = [...new Set(mapping.produkte.flatMap((p) => p.bilder))];

mkdirSync(resolve(outDir), { recursive: true });

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

let inTotal = 0;
let outTotal = 0;
const missing = [];

for (const file of wanted) {
  const src = resolve(srcDir, file);
  if (!existsSync(src)) {
    missing.push(file);
    continue;
  }

  const stem = basename(file, extname(file));
  const srcSize = statSync(src).size;
  inTotal += srcSize;

  // `rotate()` ohne Argument wendet die EXIF-Orientierung an und entfernt sie.
  // Ohne diesen Schritt steht ein mit dem Telefon quer aufgenommenes Foto in
  // manchen Browsern auf dem Kopf.
  const pipeline = () =>
    sharp(src)
      .rotate()
      .resize({
        width: MAX_EDGE,
        height: MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      });

  const webp = await pipeline().webp({ quality: QUALITY }).toBuffer();
  writeFileSync(join(resolve(outDir), `${stem}.webp`), webp);

  // Transparenz nur dort behalten, wo sie wirklich benutzt wird. gizeh-dw.png
  // etwa HAT einen Alphakanal, ist aber vollflächig deckend — als PNG wären
  // das 254 kB für nichts.
  const { isOpaque } = await sharp(src).stats();
  const fallbackExt = isOpaque ? "jpg" : "png";
  const fallback = isOpaque
    ? await pipeline()
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: QUALITY, mozjpeg: true, chromaSubsampling: "4:4:4" })
        .toBuffer()
    : await pipeline().png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(join(resolve(outDir), `${stem}.${fallbackExt}`), fallback);

  outTotal += webp.length + fallback.length;

  const meta = await sharp(webp).metadata();
  console.log(
    `${file.padEnd(34)} ${String(srcSize).padStart(7)} B  ->  ` +
      `${meta.width}x${meta.height}  webp ${kb(webp.length).padStart(9)}  ` +
      `${fallbackExt} ${kb(fallback.length).padStart(9)}`,
  );
}

// Das Mapping wandert unverändert neben die Bilder: import-product-images.ts
// bekommt damit einen einzigen Ordner als Argument, und auf der VPS ist
// nachvollziehbar, welche Zuordnung zu diesen Dateien gehört.
writeFileSync(
  join(resolve(outDir), "..", basename(mapFile)),
  JSON.stringify(mapping, null, 2) + "\n",
);

console.log("");
console.log(`${wanted.length - missing.length} Vorlagen verarbeitet.`);
console.log(`Quellen ${kb(inTotal)}  ->  Varianten ${kb(outTotal)}`);
if (missing.length) {
  console.error(`FEHLEND im Quellordner: ${missing.join(", ")}`);
  process.exitCode = 1;
}
