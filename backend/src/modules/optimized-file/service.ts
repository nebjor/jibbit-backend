import path from "node:path"

import { LocalFileService } from "@medusajs/file-local"
import type { FileTypes, LocalFileServiceOptions } from "@medusajs/framework/types"

/**
 * File-Provider, der hochgeladene BILDER vor dem Ablegen verkleinert und
 * neu kodiert (Vorgabe: max. 2000 px Kantenlaenge, AVIF) — alles andere
 * laeuft unveraendert durch.
 *
 * WARUM EIN EIGENER PROVIDER UND KEIN EINGRIFF IN DIE UPLOAD-ROUTE:
 * Die Admin-Oberflaeche laedt ueber POST /admin/uploads hoch; die Route
 * reicht die Dateien an `uploadFilesWorkflow` weiter, und der ruft am Ende
 * `upload()` des konfigurierten File-Providers auf. Wer hier einhaengt,
 * erwischt JEDEN Weg — Admin-UI, Workflows, eigene Skripte —, ohne eine
 * Core-Route zu duplizieren, die bei jedem Medusa-Update davonlaufen kann.
 * Der Provider erbt vom offiziellen `LocalFileService`; Ablage, URLs,
 * Loeschen und Streams bleiben exakt dessen Verhalten.
 *
 * GRUNDSAETZE (in dieser Reihenfolge wichtiger als jede Optimierung):
 *  1. Ein Fehlschlag der Optimierung darf den Upload NIE verschlucken —
 *     dann wird das Original gespeichert. Auch wenn sharp selbst nicht
 *     laedt (z.B. fehlende Binaries im Container), bleibt der Upload heil.
 *  2. Ob etwas ein Bild ist, entscheidet der INHALT (Magic Bytes), nicht
 *     die Dateiendung. PDFs, CSVs usw. gehen byte-identisch durch.
 *  3. Animierte GIFs/WebPs (mehrere Frames) werden unveraendert
 *     durchgereicht — eine naive Konvertierung machte daraus ein Standbild.
 *  4. Wird konvertiert, passen Dateiname, Endung und zurueckgegebene URL
 *     zum neuen Inhalt (aus `foto.jpg` wird `<ts>-foto.avif`).
 *  5. Es wird niemals hochskaliert, und ein Ergebnis, das GROESSER waere
 *     als das Original, wird verworfen (dann bleibt das Original).
 */

const OUTPUT_FORMATS = ["avif", "webp", "jpeg", "png"] as const
export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

const FORMAT_EXTENSION: Record<OutputFormat, string> = {
  avif: ".avif",
  webp: ".webp",
  jpeg: ".jpg",
  png: ".png",
}

const FORMAT_MIME: Record<OutputFormat, string> = {
  avif: "image/avif",
  webp: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png",
}

/**
 * Qualitaets-Vorgaben je Format, wenn UPLOAD_IMAGE_QUALITY nicht gesetzt
 * ist. Entsprechen den sharp-Defaults — die Skalen der Formate sind NICHT
 * vergleichbar (AVIF 50 sieht besser aus als JPEG 50).
 */
const FORMAT_DEFAULT_QUALITY: Record<OutputFormat, number> = {
  avif: 50,
  webp: 80,
  jpeg: 80,
  png: 80,
}

const DEFAULT_MAX_DIMENSION = 2000

export type OptimizedFileServiceOptions = LocalFileServiceOptions & {
  /**
   * Zielformat: avif | webp | jpeg | png — oder off/none/original, um die
   * Optimierung komplett abzuschalten. Leer/ungueltig => avif.
   */
  image_format?: string
  /** 1–100. Leer/ungueltig => sharp-Default des Zielformats. */
  image_quality?: string | number
  /** Maximale Kantenlaenge in Pixeln. Leer/ungueltig => 2000. */
  image_max_dimension?: string | number
}

type MinimalLogger = {
  warn: (msg: string) => void
}

/**
 * Erkennt Rasterbild-Formate am Dateiinhalt. Bewusst KEIN SVG (Vektor,
 * bleibt unangetastet) und bewusst konservativ: Was hier nicht erkannt
 * wird, laeuft unveraendert durch.
 */
export function sniffRasterImage(buf: Buffer): string | null {
  if (buf.length < 12) {
    return null
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "jpeg"
  }
  if (
    buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "png"
  }
  const head6 = buf.toString("latin1", 0, 6)
  if (head6 === "GIF87a" || head6 === "GIF89a") {
    return "gif"
  }
  if (
    buf.toString("latin1", 0, 4) === "RIFF" &&
    buf.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp"
  }
  if (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  ) {
    return "tiff"
  }
  if (buf.toString("latin1", 4, 8) === "ftyp") {
    const brand = buf.toString("latin1", 8, 12)
    if (brand === "avif" || brand === "avis") {
      return "avif"
    }
    if (["heic", "heix", "heim", "heis", "hevc", "mif1", "msf1"].includes(brand)) {
      // HEIC (iPhone-Fotos): sharp kann das mit den Standard-Binaries NICHT
      // dekodieren — der Versuch schlaegt fehl und das Original wird
      // gespeichert. Genau das gewollte Verhalten, darum trotzdem melden.
      return "heif"
    }
  }
  return null
}

export default class OptimizedFileService extends LocalFileService {
  static identifier = "localfs-optimized"

  protected readonly targetFormat_: OutputFormat | null
  protected readonly quality_: number
  protected readonly qualityExplicit_: boolean
  protected readonly maxDimension_: number
  protected readonly log_: MinimalLogger

  private sharpPromise_?: Promise<any | null>

  constructor(cradle: Record<string, unknown>, options: OptimizedFileServiceOptions) {
    super(cradle as any, options)

    this.log_ = (cradle?.logger as MinimalLogger | undefined) ?? console

    // ── Zielformat ────────────────────────────────────────────────────
    const rawFormat = String(options?.image_format ?? "")
      .trim()
      .toLowerCase()
    if (!rawFormat) {
      this.targetFormat_ = "avif"
    } else if (["off", "none", "original"].includes(rawFormat)) {
      this.targetFormat_ = null
    } else {
      const normalized = rawFormat === "jpg" ? "jpeg" : rawFormat
      if ((OUTPUT_FORMATS as readonly string[]).includes(normalized)) {
        this.targetFormat_ = normalized as OutputFormat
      } else {
        this.log_.warn(
          `[optimized-file] Unbekanntes UPLOAD_IMAGE_FORMAT "${rawFormat}" — es gilt die Vorgabe "avif". Gueltig: ${OUTPUT_FORMATS.join(", ")}, off.`
        )
        this.targetFormat_ = "avif"
      }
    }

    // ── Qualitaet ─────────────────────────────────────────────────────
    const rawQuality = options?.image_quality
    const parsedQuality =
      rawQuality === undefined || rawQuality === null || rawQuality === ""
        ? NaN
        : Number(rawQuality)
    if (Number.isInteger(parsedQuality) && parsedQuality >= 1 && parsedQuality <= 100) {
      this.quality_ = parsedQuality
      this.qualityExplicit_ = true
    } else {
      if (!Number.isNaN(parsedQuality)) {
        this.log_.warn(
          `[optimized-file] UPLOAD_IMAGE_QUALITY "${rawQuality}" ist keine ganze Zahl 1–100 — es gilt die Format-Vorgabe.`
        )
      }
      this.quality_ = this.targetFormat_
        ? FORMAT_DEFAULT_QUALITY[this.targetFormat_]
        : FORMAT_DEFAULT_QUALITY.avif
      this.qualityExplicit_ = false
    }

    // ── Maximale Kantenlaenge ─────────────────────────────────────────
    const rawMax = options?.image_max_dimension
    const parsedMax =
      rawMax === undefined || rawMax === null || rawMax === "" ? NaN : Number(rawMax)
    if (Number.isInteger(parsedMax) && parsedMax > 0) {
      this.maxDimension_ = parsedMax
    } else {
      if (!Number.isNaN(parsedMax)) {
        this.log_.warn(
          `[optimized-file] UPLOAD_IMAGE_MAX_DIMENSION "${rawMax}" ist keine positive ganze Zahl — es gilt die Vorgabe ${DEFAULT_MAX_DIMENSION}.`
        )
      }
      this.maxDimension_ = DEFAULT_MAX_DIMENSION
    }
  }

  async upload(
    file: FileTypes.ProviderUploadFileDTO
  ): Promise<FileTypes.ProviderFileResultDTO> {
    // optimizeImage wirft nie — bei jedem Problem kommt null zurueck und
    // das Original wird gespeichert.
    const optimized = await this.optimizeImage(file)
    return super.upload(optimized ?? file)
  }

  /**
   * Liefert eine optimierte Kopie der Datei — oder null, wenn nichts zu
   * tun ist (kein Bild, animiert, Optimierung abgeschaltet) oder etwas
   * schiefging (dann mit Warnung im Log).
   */
  protected async optimizeImage(
    file: FileTypes.ProviderUploadFileDTO
  ): Promise<FileTypes.ProviderUploadFileDTO | null> {
    const format = this.targetFormat_
    if (!format || !file?.content || !file.filename) {
      return null
    }

    try {
      const original = this.decodeContent(file.content)
      const kind = sniffRasterImage(original)
      if (!kind) {
        return null
      }

      const sharp = await this.loadSharp()
      if (!sharp) {
        return null
      }

      const metadata = await sharp(original).metadata()

      // Mehrseitig/animiert (GIF, animiertes WebP): nicht anfassen — eine
      // naive Konvertierung machte daraus ein Standbild.
      if ((metadata.pages ?? 1) > 1) {
        return null
      }

      // Schon im Zielformat und innerhalb der Kantenlaenge? Dann nicht neu
      // kodieren — jede weitere verlustbehaftete Runde kostet nur Qualitaet.
      const width = metadata.width ?? 0
      const height = metadata.height ?? 0
      if (
        kind === format &&
        width > 0 &&
        height > 0 &&
        width <= this.maxDimension_ &&
        height <= this.maxDimension_
      ) {
        return null
      }

      // .rotate() ohne Argument backt die EXIF-Orientierung ein — die
      // Ausgabeformate tragen keine EXIF-Daten mehr, sonst laegen
      // Hochformat-Fotos ploetzlich quer.
      let pipeline = sharp(original)
        .rotate()
        .resize({
          width: this.maxDimension_,
          height: this.maxDimension_,
          fit: "inside",
          withoutEnlargement: true,
        })

      switch (format) {
        case "avif":
          pipeline = pipeline.avif({ quality: this.quality_ })
          break
        case "webp":
          pipeline = pipeline.webp({ quality: this.quality_ })
          break
        case "jpeg":
          pipeline = pipeline.jpeg({ quality: this.quality_ })
          break
        case "png":
          // PNG-"Qualitaet" heisst bei sharp Palettenreduktion — nur
          // anwenden, wenn ausdruecklich eine Qualitaet gesetzt wurde.
          pipeline = this.qualityExplicit_
            ? pipeline.png({ quality: this.quality_, palette: true })
            : pipeline.png()
          break
      }

      const converted: Buffer = await pipeline.toBuffer()

      // Kein Gewinn (z.B. winzige, bereits perfekt komprimierte Datei):
      // Original behalten, statt Platz zu verschwenden.
      if (converted.length >= original.length) {
        return null
      }

      const parsed = path.parse(file.filename)
      const filename = path.join(
        parsed.dir,
        `${parsed.name}${FORMAT_EXTENSION[format]}`
      )

      return {
        ...file,
        filename,
        mimeType: FORMAT_MIME[format],
        content: converted.toString("base64"),
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.log_.warn(
        `[optimized-file] "${file.filename}" konnte nicht optimiert werden — das Original wird unveraendert gespeichert. (${message})`
      )
      return null
    }
  }

  /**
   * sharp wird verzoegert geladen: Scheitert das native Modul (etwa weil im
   * Container die musl-Binaries fehlen), faellt nur die Optimierung aus —
   * der Server startet, und Uploads speichern das Original.
   */
  protected async loadSharp(): Promise<any | null> {
    if (this.sharpPromise_ === undefined) {
      this.sharpPromise_ = import("sharp")
        .then((mod: any) => mod?.default ?? mod)
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e)
          this.log_.warn(
            `[optimized-file] sharp laesst sich nicht laden — Bilder werden unveraendert gespeichert. (${message})`
          )
          return null
        })
    }
    return this.sharpPromise_
  }

  /**
   * Dieselbe Dekodier-Heuristik wie im LocalFileService: Der Workflow
   * liefert base64, andere Aufrufer teils UTF-8. Damit sieht die
   * Optimierung exakt die Bytes, die sonst auf der Platte landen wuerden.
   */
  protected decodeContent(content: string): Buffer {
    try {
      const decoded = Buffer.from(content, "base64")
      if (decoded.toString("base64") === content) {
        return decoded
      }
      return Buffer.from(content, "utf8")
    } catch {
      return Buffer.from(content, "binary")
    }
  }
}
