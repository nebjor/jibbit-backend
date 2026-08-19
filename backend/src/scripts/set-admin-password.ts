/**
 * Setzt das Passwort eines bestehenden Admin-Benutzers neu.
 *
 * WARUM ES DIESES SCRIPT GIBT
 * Medusas Admin-Oberfläche bietet unter "Profile settings" keine Möglichkeit,
 * das eigene Passwort zu ändern. Und `medusa user` legt nur an: es ruft
 * `create-users-workflow` plus `authService.register` und scheitert, sobald die
 * Adresse schon existiert — ein Passwortwechsel ist damit nicht möglich.
 *
 * Der vorgesehene Weg über die API (`POST /auth/user/emailpass/reset-password`
 * und `/update`) verlangt ein Token, das per E-Mail zugestellt wird. Solange
 * kein Notification-Provider konfiguriert ist, kommt dieses Token nirgends an.
 * Für den Betreiber einer frisch aufgesetzten Instanz gibt es also sonst
 * keinen Weg zurück ins Konto.
 *
 * Verwendung (im Container):
 *   npx medusa exec ./src/scripts/set-admin-password.js \
 *     email=du@example.ch password='NeuesPasswort'
 *
 * Achtung: `medusa exec` lehnt Argumente mit führenden Strichen ab
 * (yargs `.strict()`), deshalb die Schreibweise `name=wert` — siehe
 * script-args.ts.
 */

import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

import { parseScriptArgs } from "./script-args"

/**
 * Mindestlänge, damit hier nicht versehentlich ein Passwort landet, das
 * schwächer ist als das, was ersetzt wird.
 */
const MIN_LENGTH = 12

export default async function setAdminPassword({ container, args }: ExecArgs) {
  const logger = container.resolve("logger")
  const opts = parseScriptArgs(args)

  const email = opts.value("email")
  const password = opts.value("password")

  if (!email || !password) {
    logger.error(
      "Aufruf: npx medusa exec ./src/scripts/set-admin-password.js " +
        "email=du@example.ch password='NeuesPasswort'",
    )
    return
  }

  if (password.length < MIN_LENGTH) {
    logger.error(
      `Passwort zu kurz (${password.length} Zeichen, mindestens ${MIN_LENGTH}).`,
    )
    return
  }

  const userService = container.resolve(Modules.USER)
  const authService = container.resolve(Modules.AUTH)

  // Erst prüfen, ob es den Benutzer überhaupt gibt. Ohne diese Prüfung würde
  // updateProvider bei einem Tippfehler in der Adresse stillschweigend eine
  // Identität anlegen oder ins Leere laufen — und der Betreiber stünde weiter
  // ohne Zugang da, ohne zu wissen warum.
  const users = await userService.listUsers({ email })
  if (!users.length) {
    logger.error(`Kein Admin-Benutzer mit der Adresse ${email} gefunden.`)

    const all = await userService.listUsers({})
    if (all.length) {
      logger.info("Vorhandene Adressen:")
      for (const u of all) {
        logger.info(`  ${u.email}`)
      }
    } else {
      logger.info(
        "Es gibt überhaupt keinen Admin-Benutzer. Mit `npx medusa user " +
          "-e adresse -p passwort` einen anlegen.",
      )
    }
    return
  }

  // entity_id ist bei emailpass die E-Mail-Adresse, nicht die Benutzer-ID:
  // der Provider reicht sie unverändert an authIdentityService.update() weiter.
  const result = await authService.updateProvider("emailpass", {
    entity_id: email,
    password,
  })

  if (!result.success) {
    logger.error(`Passwort nicht gesetzt: ${result.error}`)
    return
  }

  // Bewusst ohne das Passwort im Klartext — Scriptausgaben landen in
  // Container-Logs und in der Shell-Historie.
  logger.info(`Passwort für ${email} neu gesetzt.`)
}
