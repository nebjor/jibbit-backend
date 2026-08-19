import { AbstractNotificationProviderService, MedusaError } from "@medusajs/framework/utils"
import type { Logger, NotificationTypes } from "@medusajs/framework/types"
import nodemailer, { type Transporter } from "nodemailer"

type InjectedDependencies = {
  logger: Logger
}

export type SmtpOptions = {
  host: string
  port?: number
  /** true = implicit TLS (port 465). false = STARTTLS (587). Defaults to port === 465. */
  secure?: boolean
  user?: string
  pass?: string
  /** Default From: header, e.g. "jibbit.ch <shop@jibbit.ch>" */
  from: string
}

/**
 * SMTP-Versand über nodemailer.
 *
 * Warum eigener Provider und nicht @medusajs/notification-sendgrid:
 * jibbit verschickt über Infomaniak (Schweizer Hosting) per klassischem SMTP.
 * Die vorhandenen SMTP_*-Variablen in .env bleiben damit unverändert gültig.
 *
 * Templating: dieser Provider rendert NICHT. Der Aufrufer liefert den fertigen
 * Inhalt in `content` ({ subject, html, text }) — siehe src/subscribers/order-placed.ts.
 * `template` wird nur fürs Logging verwendet. Das erspart eine Template-Engine
 * im Container und hält den Provider auf einer Aufgabe: zustellen.
 */
class SmtpNotificationProviderService extends AbstractNotificationProviderService {
  static identifier = "smtp"

  protected logger_: Logger
  protected options_: SmtpOptions
  protected transporter_: Transporter

  constructor({ logger }: InjectedDependencies, options: SmtpOptions) {
    super()

    this.logger_ = logger
    this.options_ = options

    const port = options.port ?? 587

    this.transporter_ = nodemailer.createTransport({
      host: options.host,
      port,
      // 465 = implizites TLS, sonst STARTTLS auf 587
      secure: options.secure ?? port === 465,
      ...(options.user
        ? { auth: { user: options.user, pass: options.pass } }
        : {}),
    })
  }

  static validateOptions(options: Record<string, unknown>): void | never {
    if (!options.host) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "SMTP: `host` fehlt in den Provider-Optionen (SMTP_HOST)."
      )
    }

    if (!options.from) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "SMTP: `from` fehlt in den Provider-Optionen (SMTP_FROM)."
      )
    }

    // Auth ist optional (interne Relays kennen keine), aber halb gesetzt ist
    // immer ein Konfigurationsfehler und äussert sich sonst erst beim Senden.
    if (Boolean(options.user) !== Boolean(options.pass)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "SMTP: `user` und `pass` müssen zusammen gesetzt sein (SMTP_USER / SMTP_PASS)."
      )
    }
  }

  async send(
    notification: NotificationTypes.ProviderSendNotificationDTO
  ): Promise<NotificationTypes.ProviderSendNotificationResultsDTO> {
    if (!notification) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "SMTP: keine Notification übergeben."
      )
    }

    const content = notification.content

    if (!content?.subject || (!content.html && !content.text)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `SMTP: content.subject und content.html oder content.text sind Pflicht ` +
          `(template "${notification.template}").`
      )
    }

    const info = await this.transporter_.sendMail({
      from: notification.from || this.options_.from,
      to: notification.to,
      subject: content.subject,
      text: content.text,
      html: content.html,
      ...(notification.attachments?.length
        ? {
            attachments: notification.attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              contentType: a.content_type,
              encoding: "base64" as const,
            })),
          }
        : {}),
    })

    this.logger_.info(
      `SMTP: "${notification.template}" an ${notification.to} gesendet (${info.messageId}).`
    )

    return { id: info.messageId }
  }
}

export default SmtpNotificationProviderService
