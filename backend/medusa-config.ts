import { join } from 'node:path'

import { loadEnv, defineConfig } from '@medusajs/framework/utils'

import {
  buildZahlsProviderOptions,
  isZahlsPluginConfigured,
  missingZahlsPluginEnv,
} from './src/lib/zahls-plugin'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

/**
 * Wohin das file-Modul Produktbilder schreibt — und warum das hier stehen MUSS.
 *
 * Medusa serviert hochgeladene Dateien mit einer fest verdrahteten Zeile:
 *
 *   app.use("/static", express.static(path.join(baseDir, "static")))
 *   (@medusajs/framework/dist/http/express-loader.js)
 *
 * `baseDir` ist das Verzeichnis, aus dem medusa-config geladen wurde — im
 * Container /app. Der Auslieferungspfad ist also IMMER <baseDir>/static und
 * nicht konfigurierbar.
 *
 * Der Ablageort dagegen schon: `@medusajs/file-local` nimmt
 * `options.upload_dir`, sonst `path.join(process.cwd(), "static")`. Und genau
 * da lauert die Falle — `process.cwd()` ist NICHT garantiert /app. Wer
 *
 *   docker compose exec -w /tmp medusa npx medusa exec ./src/scripts/...
 *
 * ausführt, lädt in /tmp/static hoch, bekommt aber eine URL auf /static/…
 * zurück: die Datei ist weg, sobald der Container neu startet, und schon
 * vorher liefert der Server 404. Deshalb wird der Pfad hier ABSOLUT gesetzt.
 *
 * Damit hochgeladene Bilder einen `docker compose up` überleben, muss das
 * Volume auf genau dieses Verzeichnis zeigen — siehe docker-compose.yml,
 * `medusa_data:/app/static`. Ein Volume auf /app/uploads (so stand es hier
 * ursprünglich) fängt nichts auf: dorthin schreibt niemand.
 */
const uploadDir = process.env.MEDUSA_UPLOAD_DIR || join(process.cwd(), 'static')

/**
 * Absolute URL, unter der die Bilder später abrufbar sind. Sie wird beim
 * Upload in die Datenbank geschrieben und ist danach nicht mehr aus der
 * Umgebung korrigierbar — ein falscher Wert bedeutet, alle Bilder neu
 * hochzuladen. Der Default zeigt auf die lokale Entwicklungsinstanz.
 */
const fileBackendUrl = `${(
  process.env.MEDUSA_BACKEND_URL || 'http://localhost:9000'
).replace(/\/+$/, '')}/static`

/**
 * zahls.ch über das OFFIZIELLE Plugin (@zahls/medusa-plugin).
 *
 * Der Provider wird NUR registriert, wenn ZAHLS_INSTANCE, ZAHLS_API_KEY und
 * ZAHLS_WEBHOOK_SECRET alle gesetzt sind. Grund: `validateOptions()` im
 * Plugin wirft bei jedem fehlenden Wert bereits beim Laden des
 * Payment-Moduls — ein halb gefülltes .env würde den ganzen Shop am Start
 * hindern.
 * Ohne vollständige Werte startet Medusa deshalb normal, nur eben ohne den
 * zahls.ch-Provider; die Warnung unten sagt im Log, was fehlt.
 *
 * Provider-Kennung: pp_zahls_zahls (siehe src/lib/zahls-plugin.ts).
 * Webhook-Adresse:  https://<API_DOMAIN>/hooks/payment/zahls_zahls
 */
const zahlsConfigured = isZahlsPluginConfigured(process.env)
if (!zahlsConfigured) {
  const missing = missingZahlsPluginEnv(process.env)
  // console statt Logger: der Medusa-Logger existiert an dieser Stelle noch
  // nicht — medusa-config wird vor allen Loadern ausgewertet.
  console.warn(
    `[zahls.ch] Provider nicht registriert — es fehlt: ${missing.join(', ')}. ` +
      `Der Shop startet ohne zahls.ch-Zahlarten (Plugin-Checkout).`
  )
}

module.exports = defineConfig({
  plugins: [
    // Offizielles zahls.ch-Plugin. Der Eintrag lädt die Plugin-Ressourcen
    // (Admin-Erweiterungen; API-Routen bringt es keine mit) — der
    // Payment-Provider selbst wird unten im payment-Modul registriert.
    {
      resolve: '@zahls/medusa-plugin',
      options: {},
    },
  ],
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,

    // Medusa erzwingt bei NODE_ENV=production eine SSL-Verbindung zur
    // Datenbank. Laeuft Postgres im selben Docker-Netz — also ohne TLS —
    // scheitert damit JEDE Migration:
    //
    //   Error: The server does not support SSL connections
    //   Some migrations failed to run: (25x)
    //
    // Zurueck bleibt eine Datenbank mit genau einer Tabelle,
    // mikro_orm_migrations. Der Server startet danach nicht mehr und meldet
    // "relation tax_provider does not exist" — ein Symptom, das weit weg von
    // der Ursache liegt und leicht als Datenbankproblem missverstanden wird.
    //
    // Im Compose-Betrieb ist unverschluesselt richtig: die Verbindung
    // verlaesst das Docker-Netz nicht. Bei einer verwalteten Datenbank
    // DATABASE_SSL=true setzen.
    databaseDriverOptions:
      process.env.DATABASE_SSL === "true"
        ? { connection: { ssl: { rejectUnauthorized: false } } }
        : { connection: { ssl: false } },
    ...(process.env.REDIS_URL ? { redisUrl: process.env.REDIS_URL } : {}),
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    },
  },
  modules: [
    // Ohne diesen Eintrag lädt Medusa das file-Modul zwar mit dem
    // local-Provider vor, aber mit dessen Defaults: Ablage relativ zu
    // process.cwd() und backend_url = http://localhost:9000/static. Beides ist
    // im Container falsch. Siehe die Kommentare bei `uploadDir` oben.
    {
      resolve: '@medusajs/medusa/file',
      options: {
        providers: [
          {
            // Eigener Provider, der vom offiziellen local-Provider ERBT und
            // nur eines dazutut: hochgeladene Bilder werden vor dem Ablegen
            // verkleinert und neu kodiert (Vorgabe: max. 2000 px, AVIF).
            // Nicht-Bilder, animierte GIFs und alles, was sich nicht sauber
            // konvertieren laesst, landet unveraendert auf der Platte —
            // ein Upload geht dadurch NIE verloren.
            // Grundsaetze und Details: src/modules/optimized-file/service.ts
            resolve: './src/modules/optimized-file',
            id: 'local',
            options: {
              upload_dir: uploadDir,
              // Private Dateien landen beim local-Provider ohnehin im selben
              // Verzeichnis (der Provider kann es nicht anders); explizit
              // gesetzt, damit sie nicht in einem zweiten, nicht gemounteten
              // Ordner verschwinden.
              private_upload_dir: uploadDir,
              backend_url: fileBackendUrl,
              // Bildoptimierung beim Upload. Jede Variable ist optional und
              // hat eine vernuenftige Vorgabe (avif / Format-Default / 2000).
              // UPLOAD_IMAGE_FORMAT=off schaltet die Optimierung ganz ab.
              // WICHTIG: Werte muessen auch in docker-compose.yml unter
              // environment: stehen, sonst erreichen sie den Container nie.
              image_format: process.env.UPLOAD_IMAGE_FORMAT,
              image_quality: process.env.UPLOAD_IMAGE_QUALITY,
              image_max_dimension: process.env.UPLOAD_IMAGE_MAX_DIMENSION,
            },
          },
        ],
      },
    },
    {
      resolve: '@medusajs/medusa/payment',
      options: {
        providers: [
          // zahls.ch (offizielles Plugin) — nur bei vollständiger
          // Konfiguration, siehe Kommentar bei `zahlsConfigured` oben.
          ...(zahlsConfigured
            ? [
                {
                  resolve: '@zahls/medusa-plugin/providers/zahls',
                  id: 'zahls',
                  options: buildZahlsProviderOptions(process.env),
                },
              ]
            : []),
        ],
      },
    },
    {
      resolve: '@medusajs/medusa/fulfillment',
      options: {
        providers: [
          {
            resolve: './src/modules/swiss-shipping',
            id: 'swiss-shipping',
            options: {
              // Dezimalbeträge (4.5 = CHF 4.50), wie AGB Ziffer 6.
              // Muss mit SHIPPING in lib/config.ts der Storefront übereinstimmen.
              price: 4.5,
              freeShippingThreshold: 69,
            },
          },
        ],
      },
    },
    {
      // Ohne Notification-Modul kommt die Passwort-zurücksetzen-E-Mail
      // nirgends an: `generateResetPasswordTokenWorkflow` feuert nur das
      // Ereignis `auth.password_reset`, den Versand muss das Projekt selbst
      // stellen. Bis hierher war gar kein Modul konfiguriert.
      //
      // WARUM NICHT `@medusajs/notification-local`: der schreibt
      // `JSON.stringify(notification.data)` ins Log. Bei dieser einen Vorlage
      // stünde damit ein 15 Minuten lang gültiges Reset-Token in der
      // Logdatei — ein Zugang zum Kundenkonto, den niemand mehr löscht.
      resolve: '@medusajs/medusa/notification',
      options: {
        providers: [
          {
            resolve: './src/modules/smtp-notification',
            id: 'smtp',
            options: {
              // Ein Provider muss die Kanäle nennen, die er bedient. Ohne
              // `channels` findet das Modul beim Versand keinen zuständigen
              // Provider und die Notification schlägt mit
              // "Could not find a notification provider for channel: email" fehl.
              channels: ['email'],
              host: process.env.SMTP_HOST,
              port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS,
              from: process.env.SMTP_FROM,
              // Nur für einen lokalen Mailfänger. Bei NODE_ENV=production
              // ignoriert der Provider den Schalter hart.
              allowInsecure: process.env.SMTP_ALLOW_INSECURE === 'true',
            },
          },
        ],
      },
    },
  ],
})
