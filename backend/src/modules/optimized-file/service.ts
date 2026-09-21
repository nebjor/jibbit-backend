import path from "node:path"

import { LocalFileService } from "@medusajs/file-local"
import type { FileTypes, LocalFileServiceOptions, Logger } from "@medusajs/framework/types"
/**
 * Speichert hochgeladene Rasterbilder einheitlich als WebP (max. 2000 px,
 * Qualitaet 85). WebP statt AVIF: AVIF braucht auf der 1-vCPU-VPS pro Foto
 * mehrere Sekunden, und next/image in der Storefront rechnet ohnehin jedes
 * Bild in WebP um. Nicht-Bilder, SVG, animierte Bilder und alles, was sharp
 * nicht verarbeiten kann, werden unveraendert gespeichert.
 */

export const MAX_DIMENSION = 2000
export const WEBP_QUALITY = 85

const CONVERTIBLE = new Set(["jpeg", "png", "webp", "avif", "heif", "tiff", "gif"])

export default class OptimizedFileService extends LocalFileService {
  static identifier = "localfs-optimized"

  protected readonly log_: Pick<Logger, "warn">

  constructor(cradle: { logger?: Logger }, options: LocalFileServiceOptions) {
    super(cradle, options)
    this.log_ = cradle?.logger ?? console
  }

  async upload(
    file: FileTypes.ProviderUploadFileDTO
  ): Promise<FileTypes.ProviderFileResultDTO> {
    return super.upload((await this.toWebp(file)) ?? file)
  }

  protected async toWebp(
    file: FileTypes.ProviderUploadFileDTO
  ): Promise<FileTypes.ProviderUploadFileDTO | null> {
    if (!file?.content || !file.filename) {
      return null
    }
    const input = Buffer.from(file.content, "base64")
    if (input.toString("base64") !== file.content) {
      return null
    }

    const sharp = await import("sharp")
      .then((m) => m.default)
      .catch((e) => {
        this.log_.warn(`[optimized-file] sharp nicht ladbar, Original gespeichert: ${e}`)
        return null
      })
    const meta = sharp && (await sharp(input).metadata().catch(() => null))
    if (!sharp || !meta || !CONVERTIBLE.has(meta.format ?? "") || (meta.pages ?? 1) > 1) {
      return null
    }
    if (
      meta.format === "webp" &&
      (meta.width ?? Infinity) <= MAX_DIMENSION &&
      (meta.height ?? Infinity) <= MAX_DIMENSION
    ) {
      return null
    }

    try {
      const output = await sharp(input)
        .rotate()
        .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer()
      const { dir, name } = path.parse(file.filename)
      return {
        ...file,
        filename: path.join(dir, `${name}.webp`),
        mimeType: "image/webp",
        content: output.toString("base64"),
      }
    } catch (e) {
      this.log_.warn(
        `[optimized-file] "${file.filename}" nicht konvertiert, Original gespeichert: ${
          e instanceof Error ? e.message : e
        }`
      )
      return null
    }
  }
}
