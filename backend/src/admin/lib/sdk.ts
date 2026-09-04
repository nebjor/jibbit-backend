/**
 * JS-SDK-Client für Admin-Erweiterungen. Immer diesen Client verwenden,
 * nie fetch() direkt — das SDK setzt Session-Cookie und Auth-Header.
 */
import Medusa from "@medusajs/js-sdk"

export const sdk = new Medusa({
  baseUrl: import.meta.env.VITE_BACKEND_URL || "/",
  debug: import.meta.env.DEV,
  auth: {
    type: "session",
  },
})
