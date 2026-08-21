import { join } from 'node:path'

import { loadEnv, defineConfig } from '@medusajs/framework/utils'

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
 * PSP-IDs kommen als kommaseparierte Liste aus der Umgebung (z.B. "1,17").
 * IDs für TWINT und Powerpay: https://developers.payrexx.com/reference/retrieve-all-payment-providers
 */
const enabledPsps = (process.env.PAYREXX_ENABLED_PSPS || '')
  .split(',')
  .map((id) => Number(id.trim()))
  .filter((id) => Number.isFinite(id) && id > 0)

module.exports = defineConfig({
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
            resolve: '@medusajs/medusa/file-local',
            id: 'local',
            options: {
              upload_dir: uploadDir,
              // Private Dateien landen beim local-Provider ohnehin im selben
              // Verzeichnis (der Provider kann es nicht anders); explizit
              // gesetzt, damit sie nicht in einem zweiten, nicht gemounteten
              // Ordner verschwinden.
              private_upload_dir: uploadDir,
              backend_url: fileBackendUrl,
            },
          },
        ],
      },
    },
    {
      resolve: '@medusajs/medusa/payment',
      options: {
        providers: [
          {
            resolve: './src/modules/payrexx',
            id: 'payrexx',
            options: {
              instance: process.env.PAYREXX_INSTANCE,
              apiSecret: process.env.PAYREXX_API_SECRET,
              webhookSecret: process.env.PAYREXX_WEBHOOK_SECRET,
              // Leer = api.payrexx.com. zahls.ch ist ein White-Label derselben
              // Plattform und spricht dieselbe API unter eigenem Host:
              //   PAYREXX_API_BASE_URL=https://api.zahls.ch/v1.0/
              // Siehe docs/payrexx-go-live.md §0.
              apiBaseUrl: process.env.PAYREXX_API_BASE_URL,
              enabledPsps,
            },
          },
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
              // Medusa v2 rechnet in Dezimalbeträgen, nicht in Rappen:
              // 9 = CHF 9.00, 100 = CHF 100.00
              fixedPrice: 9,
              freeShippingThreshold: 100,
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
