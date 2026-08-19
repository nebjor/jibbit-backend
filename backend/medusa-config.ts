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
      resolve: '@medusajs/medusa/notification',
      options: {
        providers: [
          {
            // Ohne SMTP_HOST wird nur ins Log geschrieben statt versendet —
            // so laufen lokale Tests und CI ohne Mailserver durch.
            resolve: process.env.SMTP_HOST
              ? './src/modules/smtp'
              : '@medusajs/medusa/notification-local',
            id: process.env.SMTP_HOST ? 'smtp' : 'local',
            options: {
              channels: ['email'],
              host: process.env.SMTP_HOST,
              port: process.env.SMTP_PORT
                ? Number(process.env.SMTP_PORT)
                : undefined,
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS,
              from: process.env.SMTP_FROM,
            },
          },
        ],
      },
    },
  ],
})
