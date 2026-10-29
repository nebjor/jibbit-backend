import type { MedusaRequest } from "@medusajs/framework/http"

const IP_LIKE = /^[0-9a-fA-F:.]{3,45}$/

function header(req: MedusaRequest, name: string): string | undefined {
  const value = req.headers?.[name]
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined
}

/**
 * Wer ruft an? Schlüssel für Zähler, nie fürs Log.
 *
 * Die Storefront ruft vom Server aus auf; von aussen sähe die Route immer
 * dieselbe Adresse. Sie reicht die Adresse des Besuchers deshalb in
 * `x-jibbit-client-ip` mit — der Aufruf braucht den geheimen Publishable Key,
 * der Header ist also nicht frei von aussen setzbar. Ohne den Header gilt der
 * letzte Eintrag von `x-forwarded-for` (vom nächsten Proxy angehängt), sonst
 * die Socket-Adresse. Findet sich nichts Brauchbares, liefert die Funktion
 * `undefined` und der Zähler lehnt ab.
 */
export function clientKey(req: MedusaRequest): string | undefined {
  const hint = header(req, "x-jibbit-client-ip")
  if (hint && IP_LIKE.test(hint)) return hint

  const forwarded = header(req, "x-forwarded-for")
  const last = forwarded?.split(",").pop()?.trim()
  if (last && IP_LIKE.test(last)) return last

  const ip = (req as { ip?: string }).ip
  return ip && IP_LIKE.test(ip) ? ip : undefined
}
