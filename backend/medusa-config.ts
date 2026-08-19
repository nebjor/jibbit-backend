import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

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
