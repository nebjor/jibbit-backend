import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import sharp from "sharp"

import OptimizedFileService from "../modules/optimized-file/service"

jest.setTimeout(30_000)

const BACKEND_URL = "http://localhost:9000/static"

let uploadDir: string
let warn: jest.Mock

const makeService = () =>
  new OptimizedFileService({ logger: { warn } as any }, {
    upload_dir: uploadDir,
    private_upload_dir: uploadDir,
    backend_url: BACKEND_URL,
  })

const makeJpeg = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 180, g: 120, b: 40 } } })
    .jpeg({ quality: 90 })
    .toBuffer()

function makeAnimatedGif(): Buffer {
  const frame = Buffer.from([
    0x21, 0xf9, 0x04, 0x04, 0x0a, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x44, 0x01, 0x00,
  ])
  return Buffer.concat([
    Buffer.from("GIF89a", "latin1"),
    Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff]),
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from("NETSCAPE2.0", "latin1"),
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
    frame,
    frame,
    Buffer.from([0x3b]),
  ])
}

const upload = (filename: string, content: Buffer, mimeType = "image/jpeg") =>
  makeService().upload({ filename, mimeType, content: content.toString("base64"), access: "public" })

const stored = (result: { key: string }) => fs.readFile(path.join(uploadDir, result.key))

beforeEach(async () => {
  uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "optimized-file-test-"))
  warn = jest.fn()
})

afterEach(async () => {
  await fs.rm(uploadDir, { recursive: true, force: true })
})

describe("OptimizedFileService", () => {
  it("verkleinert grosse Bilder auf 2000 px und speichert WebP", async () => {
    const result = await upload("produktfoto.JPG", await makeJpeg(3000, 1200))

    expect(result.key.endsWith("-produktfoto.webp")).toBe(true)
    expect(result.url).toBe(`${BACKEND_URL}/${result.key}`)
    const meta = await sharp(await stored(result)).metadata()
    expect(meta).toMatchObject({ format: "webp", width: 2000, height: 800 })
  })

  it("skaliert kleine Bilder nicht hoch, speichert sie aber ebenfalls als WebP", async () => {
    const result = await upload("klein.jpg", await makeJpeg(640, 480))

    const meta = await sharp(await stored(result)).metadata()
    expect(meta).toMatchObject({ format: "webp", width: 640, height: 480 })
  })

  it("behaelt die Transparenz von PNGs", async () => {
    const png = await sharp({
      create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer()

    const result = await upload("freisteller.png", png, "image/png")

    const meta = await sharp(await stored(result)).metadata()
    expect(meta).toMatchObject({ format: "webp", hasAlpha: true })
  })

  it("konvertiert AVIF-Uploads ebenfalls zu WebP", async () => {
    const avif = await sharp(await makeJpeg(64, 64)).avif({ effort: 0 }).toBuffer()

    const result = await upload("alt.avif", avif, "image/avif")

    expect(result.key.endsWith(".webp")).toBe(true)
    expect((await sharp(await stored(result)).metadata()).format).toBe("webp")
  })

  it("laesst WebP innerhalb der Kantenlaenge unangetastet", async () => {
    const webp = await sharp(await makeJpeg(800, 600)).webp({ quality: 70 }).toBuffer()

    const result = await upload("fertig.webp", webp, "image/webp")

    expect((await stored(result)).equals(webp)).toBe(true)
  })

  it("reicht Nicht-Bilder, SVG und animierte GIFs byte-identisch durch", async () => {
    const cases: [string, Buffer][] = [
      ["import.csv", Buffer.from("sku,menge\nRAW-KSS,25\n")],
      ["logo.svg", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>")],
      ["sticker.gif", makeAnimatedGif()],
    ]
    for (const [filename, content] of cases) {
      const result = await upload(filename, content, "application/octet-stream")
      expect(path.extname(result.key)).toBe(path.extname(filename))
      expect((await stored(result)).equals(content)).toBe(true)
    }
  })

  it("speichert bei kaputter Bilddatei das Original", async () => {
    const broken = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from("kein echtes jpeg ".repeat(20)),
    ])

    const result = await upload("kaputt.jpg", broken)

    expect(result.key.endsWith(".jpg")).toBe(true)
    expect((await stored(result)).equals(broken)).toBe(true)
  })
})
