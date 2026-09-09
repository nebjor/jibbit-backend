/**
 * Unit-Tests fuer den optimized-file-Provider (Bildoptimierung beim Upload).
 *
 * Getestet wird gegen echte Dateien in einem Temp-Verzeichnis und mit echtem
 * sharp — genau der Codepfad, der auch im Betrieb laeuft. Die Testbilder
 * werden zur Laufzeit mit sharp erzeugt.
 */
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import OptimizedFileService, {
  sniffRasterImage,
} from "../modules/optimized-file/service"

// AVIF-Kodierung braucht spuerbar Zeit — grosszuegiges Limit statt Flakes.
jest.setTimeout(60_000)

const BACKEND_URL = "http://localhost:9000/static"

let uploadDir: string

const makeService = (opts: Record<string, unknown> = {}) =>
  new OptimizedFileService(
    { logger: { warn: jest.fn() } },
    {
      upload_dir: uploadDir,
      private_upload_dir: uploadDir,
      backend_url: BACKEND_URL,
      ...opts,
    } as any
  )

const sharpLib = async () => (await import("sharp")).default

/** Erzeugt ein JPEG mit Farbverlauf in gewuenschter Groesse. */
async function makeJpeg(width: number, height: number): Promise<Buffer> {
  const sharp = await sharpLib()
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 180, g: 120, b: 40 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
}

/**
 * Minimales animiertes GIF (1x1, zwei Frames), von Hand zusammengesetzt.
 * Zwei Frames genuegen, damit `pages > 1` greift bzw. — falls der
 * GIF-Parser die Datei verschmaeht — der Fallback dasselbe tut: durchreichen.
 */
function makeAnimatedGif(): Buffer {
  const header = Buffer.from("GIF89a", "latin1")
  // 1x1, globale Farbtabelle mit 2 Eintraegen
  const lsd = Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00])
  const gct = Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff])
  const netscape = Buffer.concat([
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from("NETSCAPE2.0", "latin1"),
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
  ])
  const frame = Buffer.concat([
    // Graphics Control Extension, 0.1 s Verzoegerung
    Buffer.from([0x21, 0xf9, 0x04, 0x04, 0x0a, 0x00, 0x00, 0x00]),
    // Image Descriptor 1x1 @ 0,0
    Buffer.from([0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    // LZW-Daten (min. Code-Groesse 2)
    Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00]),
  ])
  const trailer = Buffer.from([0x3b])
  return Buffer.concat([header, lsd, gct, netscape, frame, frame, trailer])
}

/** Liest die abgelegte Datei zu einem Upload-Ergebnis. */
async function storedFile(result: { key: string }): Promise<Buffer> {
  return fs.readFile(path.join(uploadDir, result.key))
}

beforeEach(async () => {
  uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "optimized-file-test-"))
})

afterEach(async () => {
  await fs.rm(uploadDir, { recursive: true, force: true })
})

describe("sniffRasterImage", () => {
  it("erkennt Formate am Inhalt, nicht an der Endung", async () => {
    expect(sniffRasterImage(await makeJpeg(8, 8))).toBe("jpeg")
    expect(sniffRasterImage(Buffer.from("a,b,c\n1,2,3\n4,5,6\n"))).toBeNull()
    expect(sniffRasterImage(Buffer.from("%PDF-1.7 ...........").subarray(0))).toBeNull()
    expect(sniffRasterImage(makeAnimatedGif())).toBe("gif")
    expect(
      sniffRasterImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))
    ).toBeNull()
  })
})

describe("OptimizedFileService", () => {
  it("verkleinert grosse Bilder auf die maximale Kantenlaenge und speichert AVIF", async () => {
    const sharp = await sharpLib()
    const service = makeService() // Vorgaben: avif, 2000 px
    const original = await makeJpeg(3000, 1200)

    const result = await service.upload({
      filename: "produktfoto.jpg",
      mimeType: "image/jpeg",
      content: original.toString("base64"),
      access: "public",
    })

    expect(result.key.endsWith(".avif")).toBe(true)
    const stored = await storedFile(result)
    const meta = await sharp(stored).metadata()
    expect(["avif", "heif"]).toContain(meta.format)
    expect(meta.width).toBe(2000)
    expect(meta.height).toBe(800)
  })

  it("Endung und zurueckgegebene URL passen zur abgelegten Datei", async () => {
    const service = makeService()
    const original = await makeJpeg(2500, 2500)

    const result = await service.upload({
      filename: "kamera-bild.JPG",
      mimeType: "image/jpeg",
      content: original.toString("base64"),
      access: "public",
    })

    // URL = backend_url + "/" + key — und die Datei liegt unter key.
    expect(result.url).toBe(`${BACKEND_URL}/${result.key}`)
    expect(result.key.endsWith(".avif")).toBe(true)
    await expect(
      fs.access(path.join(uploadDir, result.key))
    ).resolves.toBeUndefined()
  })

  it("skaliert kleine Bilder niemals hoch", async () => {
    const sharp = await sharpLib()
    const service = makeService({ image_format: "webp" })
    const original = await makeJpeg(640, 480)

    const result = await service.upload({
      filename: "klein.jpg",
      mimeType: "image/jpeg",
      content: original.toString("base64"),
      access: "public",
    })

    const meta = await sharp(await storedFile(result)).metadata()
    expect(meta.width).toBe(640)
    expect(meta.height).toBe(480)
    expect(meta.format).toBe("webp")
    expect(result.key.endsWith(".webp")).toBe(true)
  })

  it("reicht Nicht-Bilder byte-identisch durch", async () => {
    const service = makeService()
    const csv = "sku,menge\nRAW-KSS,25\nOCB-SLIM,100\n"

    const result = await service.upload({
      filename: "import.csv",
      mimeType: "text/csv",
      content: Buffer.from(csv).toString("base64"),
      access: "private",
    })

    expect(result.key.endsWith(".csv")).toBe(true)
    expect((await storedFile(result)).toString("utf8")).toBe(csv)
  })

  it("speichert bei kaputter Bilddatei das Original statt gar nichts", async () => {
    const service = makeService()
    // JPEG-Magic-Bytes, danach Muell: wird als Bild erkannt, sharp scheitert.
    const broken = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from("das ist kein echtes jpeg, nur kaputte bytes ".repeat(10)),
    ])

    const result = await service.upload({
      filename: "kaputt.jpg",
      mimeType: "image/jpeg",
      content: broken.toString("base64"),
      access: "public",
    })

    expect(result.key.endsWith(".jpg")).toBe(true)
    expect((await storedFile(result)).equals(broken)).toBe(true)
  })

  it("reicht animierte GIFs unveraendert durch", async () => {
    const service = makeService()
    const gif = makeAnimatedGif()

    const result = await service.upload({
      filename: "sticker.gif",
      mimeType: "image/gif",
      content: gif.toString("base64"),
      access: "public",
    })

    expect(result.key.endsWith(".gif")).toBe(true)
    expect((await storedFile(result)).equals(gif)).toBe(true)
  })

  it("laesst Bilder in Ruhe, die schon im Zielformat und klein genug sind", async () => {
    const sharp = await sharpLib()
    const service = makeService({ image_format: "webp" })
    const alreadyGood = await sharp(await makeJpeg(800, 600))
      .webp({ quality: 70 })
      .toBuffer()

    const result = await service.upload({
      filename: "fertig.webp",
      mimeType: "image/webp",
      content: alreadyGood.toString("base64"),
      access: "public",
    })

    expect(result.key.endsWith(".webp")).toBe(true)
    expect((await storedFile(result)).equals(alreadyGood)).toBe(true)
  })

  it("laesst sich mit UPLOAD_IMAGE_FORMAT=off komplett abschalten", async () => {
    const service = makeService({ image_format: "off" })
    const original = await makeJpeg(3000, 1200)

    const result = await service.upload({
      filename: "unangetastet.jpg",
      mimeType: "image/jpeg",
      content: original.toString("base64"),
      access: "public",
    })

    expect(result.key.endsWith(".jpg")).toBe(true)
    expect((await storedFile(result)).equals(original)).toBe(true)
  })

  it("respektiert eine eigene maximale Kantenlaenge", async () => {
    const sharp = await sharpLib()
    const service = makeService({
      image_format: "webp",
      image_max_dimension: "1500",
    })
    const original = await makeJpeg(2400, 1600)

    const result = await service.upload({
      filename: "gross.jpg",
      mimeType: "image/jpeg",
      content: original.toString("base64"),
      access: "public",
    })

    const meta = await sharp(await storedFile(result)).metadata()
    expect(meta.width).toBe(1500)
    expect(meta.height).toBe(1000)
  })
})
