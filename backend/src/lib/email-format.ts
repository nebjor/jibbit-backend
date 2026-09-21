/** Pfad, unter dem Medusa das Admin-Dashboard ausliefert (`admin.path`, Vorgabe "/app"). */
export const ADMIN_PATH = "/app"

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * Betrag im Schweizer Format, "CHF 1’234.50". Bewusst ohne Intl: dessen
 * Leerzeichen zwischen Währung und Betrag hängt von der ICU-Version ab.
 */
export function formatChf(value: unknown): string {
  const n = Number(value ?? 0)
  const [int, dec] = (Number.isFinite(n) ? Math.abs(n) : 0).toFixed(2).split(".")
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, "’")
  return `CHF ${n < 0 ? "-" : ""}${grouped}.${dec}`
}

/**
 * Absolute URL auf `path` unter `base`. Wirft, wenn `base` fehlt oder kein
 * http(s)-Ursprung ist: lieber keine E-Mail als eine mit kaputtem Link.
 */
export function absoluteUrl(base: string | undefined, envName: string, path: string): URL {
  if (!base?.trim()) {
    throw new Error(`${envName} ist nicht gesetzt — ohne Basis-URL lässt sich kein Link bauen.`)
  }
  let origin: URL
  try {
    origin = new URL(base)
  } catch {
    throw new Error(`${envName} ist keine gültige URL.`)
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") {
    throw new Error(`${envName} muss http oder https sein.`)
  }
  return new URL(path, origin)
}

export function adminUrl(backendUrl: string | undefined, path: string): URL {
  return absoluteUrl(backendUrl, "MEDUSA_BACKEND_URL", `${ADMIN_PATH}${path}`)
}
