/**
 * Produktbilder hochladen und den Produkten zuordnen.
 *
 * PROBELAUF IST DER NORMALFALL — ohne das Wort `schreiben` wird nichts
 * hochgeladen und nichts geschrieben (Hintergrund: script-args.ts):
 *
 *   docker compose cp ./backend/media medusa:/app/media
 *   docker compose exec medusa npx medusa exec \
 *     ./src/scripts/import-product-images.js \
 *     /app/media/product-images.json
 *
 * Hochladen — `schreiben` als ERSTES Argument gleich nach dem Script-Pfad:
 *
 *   docker compose exec medusa npx medusa exec \
 *     ./src/scripts/import-product-images.js schreiben \
 *     /app/media/product-images.json
 *
 * Argumente OHNE Bindestrich-Präfix — `medusa exec` lehnt unbekannte Optionen
 * ab, siehe script-args.ts. Unbekannte oder vertippte Argumente brechen den
 * Lauf ab, bevor etwas gelesen oder geschrieben wird.
 *
 * Optionen:
 *   schreiben      wirklich hochladen und schreiben. Ohne dieses Wort:
 *                  Probelauf.
 *   dry-run        ausdrücklicher Probelauf — ohne Wirkung, bleibt erlaubt
 *   dir=<pfad>     Ordner mit den aufbereiteten Varianten.
 *                  Default: <ordner der json>/produktbilder
 *   allow-internal-url
 *                  Bild-URLs auf localhost o.ä. zulassen, obwohl
 *                  NODE_ENV=production ist. Nur für Test- und Vorschauboxen
 *                  ohne eigene API-Domain — im echten Betrieb bedeutet eine
 *                  solche URL, dass die Bilder im Medusa-Admin und in jedem
 *                  Produktdaten-Feed tot sind. Die Storefront selbst kommt
 *                  auch damit zurecht, weil sie nur den Pfad hinter /static/
 *                  auswertet (siehe jibbit-frontend/lib/media.ts).
 *
 * ─── Woher die Dateien kommen ──────────────────────────────────────────
 * NICHT aus dem kDrive und nicht in Originalgrösse. Die Vorlagen laufen einmal
 * durch scripts/prepare-product-images.mjs; das Ergebnis liegt unter
 * backend/media/produktbilder im Repository. Der Laufzeitcontainer enthält
 * dieses Verzeichnis NICHT — `medusa build` kopiert aus src/ ausschliesslich
 * kompilierte .js-Dateien, sonst nichts. Deshalb der `docker compose cp`
 * oben; genauso wie beim Katalogimport mit odoo-export.
 *
 * ─── Welche Variante wohin ─────────────────────────────────────────────
 * In `images` und `thumbnail` steht die WebP-Fassung — das ist das Bild, das
 * die Storefront ausliefert. Die JPEG/PNG-Rückfallebene wird ebenfalls
 * hochgeladen und ihre URL in `metadata.image_sources` vermerkt, damit sie für
 * alles greifbar bleibt, was kein WebP verdaut (Produktdaten-Feeds etwa) und
 * nicht als verwaister Blob im Dateispeicher endet.
 *
 * ─── Idempotenz ────────────────────────────────────────────────────────
 * Der zweite Lauf legt nichts doppelt an. Der Schlüssel dafür ist
 * `product.metadata.image_sources` — eine Abbildung
 *
 *   { "elements-kss-front.jpg": { image: "…/17…-elements-kss-front.webp",
 *                                 fallback: "…/17…-elements-kss-front.jpg" } }
 *
 * also QUELLDATEINAME -> hochgeladene URLs. Warum nicht einfach "hat schon
 * Bilder, überspringen"? Zwei Gründe:
 *
 *   1. Wächst die Zuordnung um ein weiteres Foto für ein Produkt, das bereits
 *      eines hat, muss der Lauf genau dieses eine ergänzen.
 *   2. Über die gespeicherte URL allein liesse sich nicht deduplizieren: der
 *      local-Provider stellt jedem Schlüssel `Date.now()` voran, dieselbe
 *      Quelldatei ergibt beim zweiten Upload also einen anderen Dateinamen.
 *
 * `thumbnail` wird ausdrücklich auf das ERSTE Bild der Zuordnung gesetzt und
 * nicht aus `images[0]` abgeleitet — die Reihenfolge der Bilderliste ist nach
 * einem Update nicht garantiert.
 */

import { readFileSync, existsSync } from "node:fs"
import { basename, dirname, extname, join, resolve } from "node:path"

import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  updateProductsWorkflow,
  uploadFilesWorkflow,
} from "@medusajs/medusa/core-flows"

import { applyHint, parseScriptArgs, resolveRunMode } from "./script-args"

/** Welche Varianten prepare-product-images.mjs erzeugt, in Reihenfolge der Suche. */
const FALLBACK_EXTENSIONS = [".jpg", ".png"]

const MIME_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
}

/** Ein Eintrag aus product-images.json. */
type ImageMapping = {
  produkte: { product: string; bilder: string[] }[]
  nicht_zugeordnet?: { datei: string; grund: string }[]
  ohne_bild?: string[]
}

/** Was in product.metadata.image_sources landet. */
type UploadedSource = { image: string; fallback?: string }
type ImageSources = Record<string, UploadedSource>

type ProductRow = {
  id: string
  title: string
  thumbnail: string | null
  metadata: Record<string, unknown> | null
  images: { url: string }[] | null
}

/** Hostnamen, die nur auf der Maschine selbst gelten. */
const LOOPBACK = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "medusa"]

/**
 * Die URL, unter der die Bilder später abrufbar sein werden — und die
 * einzige Angabe in diesem Lauf, die sich HINTERHER NICHT MEHR KORRIGIEREN
 * LÄSST.
 *
 * Medusa schreibt beim Upload eine absolute URL in die Datenbank, gebildet aus
 * `backend_url` des file-Moduls (siehe medusa-config.ts, gespeist aus
 * MEDUSA_BACKEND_URL). Ist der Wert falsch, sind alle Bilder tot und müssen
 * neu hochgeladen werden — kein Update-Script repariert das, weil die alten
 * Dateien unter alten Schlüsseln im Dateispeicher liegen bleiben.
 *
 * Deshalb hier eine harte Prüfung statt eines Satzes in der Anleitung: der
 * Default des Providers ist `http://localhost:9000/static`, und der greift
 * still, wenn MEDUSA_BACKEND_URL in der .env fehlt.
 */
function checkBackendUrl(allowInternal: boolean): { base: string; error?: string } {
  const raw = process.env.MEDUSA_BACKEND_URL
  const isProduction = process.env.NODE_ENV === "production" && !allowInternal

  if (!raw?.trim()) {
    return {
      base: "http://localhost:9000/static",
      error: isProduction
        ? "MEDUSA_BACKEND_URL ist nicht gesetzt. Die Bild-URLs wuerden auf " +
          "http://localhost:9000 zeigen und waeren von aussen nicht abrufbar."
        : undefined,
    }
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return {
      base: raw,
      error: `MEDUSA_BACKEND_URL ist keine gueltige URL: "${raw}"`,
    }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { base: raw, error: `MEDUSA_BACKEND_URL braucht http oder https: "${raw}"` }
  }

  const base = `${raw.replace(/\/+$/, "")}/static`

  if (isProduction && LOOPBACK.includes(url.hostname)) {
    return {
      base,
      error:
        `MEDUSA_BACKEND_URL zeigt auf "${url.hostname}" — das gilt nur ` +
        "innerhalb der Maschine bzw. des Docker-Netzes. Browser koennten die " +
        "Bilder nie laden. Erwartet wird die oeffentliche Adresse, etwa " +
        "https://api-test.jibbit.ch.",
    }
  }

  return { base }
}

/** Bereits vermerkte Uploads, defensiv gelesen — metadata ist freies JSON. */
function readImageSources(metadata: Record<string, unknown> | null): ImageSources {
  const raw = metadata?.image_sources
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {}
  }

  const out: ImageSources = {}
  for (const [source, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as Partial<UploadedSource> | null
    if (entry && typeof entry.image === "string" && entry.image) {
      out[source] = {
        image: entry.image,
        ...(typeof entry.fallback === "string" && entry.fallback
          ? { fallback: entry.fallback }
          : {}),
      }
    }
  }
  return out
}

export default async function importProductImages({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const opts = parseScriptArgs(args)

  // Modus und Argumente ZUERST — ohne `schreiben` bleibt alles ein Probelauf.
  const mode = resolveRunMode(
    opts,
    { values: ["dir"], flags: ["allow-internal-url"], file: ".json" },
    logger
  )
  if (!mode) {
    return
  }
  const { dryRun } = mode

  const mappingFile = opts.file(".json")
  if (!mappingFile) {
    logger.error("Pfad zu product-images.json fehlt.")
    return
  }

  const imageDir = resolve(
    opts.value("dir") ?? join(dirname(resolve(mappingFile)), "produktbilder")
  )

  // VOR allem anderen: eine falsche Backend-URL ist hinterher nicht mehr
  // reparierbar. Lieber hier abbrechen als 30 Dateien mit toten URLs anlegen.
  const backendUrl = checkBackendUrl(opts.flag("allow-internal-url"))
  if (backendUrl.error) {
    logger.error(backendUrl.error)
    logger.error(
      "Nichts hochgeladen. Die URL wird beim Upload in die Datenbank " +
        "geschrieben und ist danach nur durch erneutes Hochladen aller Bilder " +
        "zu aendern."
    )
    return
  }
  logger.info(`Bild-URLs werden lauten: ${backendUrl.base}/<datei>`)

  const mapping: ImageMapping = JSON.parse(readFileSync(resolve(mappingFile), "utf8"))

  if (!mapping.produkte?.length) {
    logger.warn("Die Zuordnung enthält keine Produkte.")
    return
  }

  if (!existsSync(imageDir)) {
    logger.error(
      `Bildordner nicht gefunden: ${imageDir}\n` +
        "Im Container liegt er nicht automatisch vor — vorher:\n" +
        "  docker compose cp ./backend/media medusa:/app/media"
    )
    return
  }

  // ─── Produkte laden und über den Titel zuordnen ───────────────
  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "title", "thumbnail", "metadata", "images.*"],
  })

  const byTitle = new Map<string, ProductRow>()
  for (const p of products as ProductRow[]) {
    byTitle.set(p.title, p)
  }

  const notFound: string[] = []
  const missingFiles: string[] = []
  const unchanged: string[] = []
  /** Was tatsächlich geschrieben werden soll. */
  const planned: {
    product: ProductRow
    /** Quelldateien in der Reihenfolge der Zuordnung. */
    sources: string[]
    /** Quelldateien, für die noch nichts hochgeladen wurde. */
    toUpload: string[]
  }[] = []

  for (const entry of mapping.produkte) {
    const product = byTitle.get(entry.product)
    if (!product) {
      notFound.push(entry.product)
      continue
    }

    const known = readImageSources(product.metadata)
    const sources: string[] = []
    const toUpload: string[] = []

    for (const file of entry.bilder) {
      const stem = basename(file, extname(file))
      const primary = join(imageDir, `${stem}.webp`)

      if (!known[file] && !existsSync(primary)) {
        // Fehlende Vorlage ist ein Fehler des Aufbereitungsschritts, kein
        // Grund, den Rest des Laufs abzubrechen.
        missingFiles.push(`${entry.product}: ${stem}.webp`)
        continue
      }

      sources.push(file)
      if (!known[file]) {
        toUpload.push(file)
      }
    }

    if (!sources.length) {
      continue
    }

    // Nichts zu tun, wenn alle Bilder schon hochgeladen sind UND Bilderliste
    // sowie Vorschaubild bereits genau so am Produkt hängen. Ohne diese
    // Prüfung würde jeder Lauf die Bildzeilen löschen und neu anlegen.
    const desiredUrls = sources.map((s) => known[s]?.image)
    const currentUrls = (product.images ?? []).map((i) => i.url)
    const alreadyCorrect =
      !toUpload.length &&
      desiredUrls.length === currentUrls.length &&
      desiredUrls.every((url, i) => url === currentUrls[i]) &&
      product.thumbnail === desiredUrls[0]

    if (alreadyCorrect) {
      unchanged.push(entry.product)
      continue
    }

    planned.push({ product, sources, toUpload })
  }

  // ─── Bericht vor dem Schreiben ────────────────────────────────
  if (notFound.length) {
    logger.warn(
      `${notFound.length} Produkte aus der Zuordnung gibt es im Shop nicht ` +
        "(Titel muss exakt übereinstimmen):"
    )
    notFound.forEach((n) => logger.warn(`  ${n}`))
  }

  if (missingFiles.length) {
    logger.warn(`${missingFiles.length} aufbereitete Dateien fehlen in ${imageDir}:`)
    missingFiles.forEach((m) => logger.warn(`  ${m}`))
  }

  if (unchanged.length) {
    logger.info(`${unchanged.length} Produkte sind bereits aktuell — nichts zu tun.`)
  }

  const matched = mapping.produkte.length - notFound.length
  logger.info(
    `${matched} von ${byTitle.size} Produkten haben ein Foto; ` +
      `${byTitle.size - matched} bekommen den generierten Platzhalter der ` +
      "Storefront."
  )

  if (!planned.length) {
    logger.info("Nichts anzulegen.")
    return
  }

  if (dryRun) {
    logger.info("— Probelauf, es wird nichts hochgeladen und nichts geschrieben —")
    for (const p of planned) {
      logger.info(`  ${p.product.title}`)
      for (const s of p.sources) {
        const mark = p.toUpload.includes(s) ? "neu " : "hat "
        logger.info(`     ${mark}${s}${s === p.sources[0] ? "   (Vorschaubild)" : ""}`)
      }
    }
    const uploads = planned.reduce((n, p) => n + p.toUpload.length, 0)
    logger.info(
      `Würde ${uploads} Bilder hochladen (je eine WebP- und eine ` +
        `Rückfall-Fassung) und ${planned.length} Produkte aktualisieren.`
    )
    logger.info(applyHint(args))
    return
  }

  // ─── Hochladen und zuordnen ───────────────────────────────────
  let uploadedCount = 0

  for (const { product, sources, toUpload } of planned) {
    const known = readImageSources(product.metadata)

    for (const file of toUpload) {
      const stem = basename(file, extname(file))

      const fallbackExt = FALLBACK_EXTENSIONS.find((ext) =>
        existsSync(join(imageDir, `${stem}${ext}`))
      )

      const toSend = [
        { path: join(imageDir, `${stem}.webp`), name: `${stem}.webp` },
        ...(fallbackExt
          ? [
              {
                path: join(imageDir, `${stem}${fallbackExt}`),
                name: `${stem}${fallbackExt}`,
              },
            ]
          : []),
      ]

      const { result } = await uploadFilesWorkflow(container).run({
        input: {
          files: toSend.map((f) => ({
            filename: f.name,
            mimeType: MIME_TYPES[extname(f.name)] ?? "application/octet-stream",
            content: readFileSync(f.path).toString("base64"),
            access: "public" as const,
          })),
        },
      })

      known[file] = {
        image: result[0].url,
        ...(result[1] ? { fallback: result[1].url } : {}),
      }
      uploadedCount += result.length
    }

    const urls = sources.map((s) => known[s].image)

    await updateProductsWorkflow(container).run({
      input: {
        products: [
          {
            id: product.id,
            thumbnail: urls[0],
            images: urls.map((url) => ({ url })),
            // Bestehende Metadaten mitnehmen: `metadata` wird als Ganzes
            // ersetzt, nicht zusammengeführt. Ohne das Spread wäre etwa ein
            // im Admin gepflegtes `brand` nach diesem Lauf weg.
            metadata: { ...(product.metadata ?? {}), image_sources: known },
          },
        ],
      },
    })

    logger.info(
      `${product.title}: ${urls.length} Bilder, Vorschaubild ${basename(urls[0])}`
    )
  }

  logger.info(
    `${uploadedCount} Dateien hochgeladen, ${planned.length} Produkte aktualisiert.`
  )
}
