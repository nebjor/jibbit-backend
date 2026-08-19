import { AbstractNotificationProviderService, MedusaError } from "@medusajs/framework/utils"
import type { Logger } from "@medusajs/framework/types"
import type {
  ProviderSendNotificationDTO,
  ProviderSendNotificationResultsDTO,
} from "@medusajs/types"
import nodemailer, { type Transporter } from "nodemailer"

/**
 * E-Mail-Versand über SMTP.
 *
 * Medusa v2 bringt Notification-Provider für SendGrid und einen lokalen
 * Log-Provider mit — für SMTP gibt es keinen. Der lokale Provider ist hier
 * ausserdem ausdrücklich unbrauchbar: er schreibt `JSON.stringify(data)` ins
 * Log, und bei einer Passwort-E-Mail stünde damit ein gültiges Reset-Token in
 * der Logdatei. Deshalb dieser Provider.
 *
 * ER RENDERT NICHTS. Betreff und Text kommen fertig in `notification.content`
 * an. Das ist Absicht: `content` hat im Notification-Model keine Spalte und
 * wird deshalb NICHT in der Datenbank abgelegt, `data` dagegen schon. Wer hier
 * eine Template-Engine einbaut, die aus `data` rendert, verschiebt damit
 * automatisch alle Werte — auch Tokens — in die Datenbank.
 */

export interface SmtpOptions {
  host?: string
  port?: number
  user?: string
  pass?: string
  /** Absender, z.B. "jibbit <noreply@jibbit.ch>". */
  from?: string
  /** Implizites TLS (Port 465). Bei 587 bleibt es aus, dort greift STARTTLS. */
  secure?: boolean
}

type InjectedDependencies = { logger: Logger }

class SmtpNotificationProviderService extends AbstractNotificationProviderService {
  static identifier = "smtp"

  protected readonly logger_: Logger
  protected readonly options_: SmtpOptions
  protected transporter_: Transporter | null = null

  constructor({ logger }: InjectedDependencies, options: SmtpOptions) {
    super()
    this.logger_ = logger
    this.options_ = options ?? {}
  }

  /**
   * Bewusst KEINE Prüfung auf gesetztes SMTP hier.
   *
   * `validateOptions` läuft beim Start des Servers. Würde sie ohne SMTP
   * werfen, liesse sich der Stack lokal und im Container-Build gar nicht mehr
   * hochfahren — und die Storefront soll ohne Mailkonto entwickelbar bleiben.
   * Die fehlende Konfiguration fällt stattdessen beim ersten Versand auf, laut
   * und mit klarer Meldung.
   */
  static validateOptions(): void {}

  private transporter(): Transporter {
    if (this.transporter_) return this.transporter_

    const { host, port, user, pass, secure } = this.options_
    if (!host) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "SMTP_HOST ist nicht gesetzt — es kann keine E-Mail versendet werden."
      )
    }

    const resolvedPort = port ?? 587
    this.transporter_ = nodemailer.createTransport({
      host,
      port: resolvedPort,
      // Port 465 spricht von der ersten Sekunde an TLS, 587 startet im Klartext
      // und schaltet per STARTTLS um. `requireTLS` erzwingt, dass diese
      // Umschaltung auch wirklich passiert — ohne das würde nodemailer bei
      // einem Server ohne STARTTLS still unverschlüsselt weitersenden.
      secure: secure ?? resolvedPort === 465,
      requireTLS: !(secure ?? resolvedPort === 465),
      auth: user ? { user, pass } : undefined,
    })
    return this.transporter_
  }

  async send(
    notification: ProviderSendNotificationDTO
  ): Promise<ProviderSendNotificationResultsDTO> {
    if (!notification?.to) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Notification ohne Empfänger."
      )
    }

    const content = notification.content
    if (!content?.subject || !(content.text || content.html)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Notification "${notification.template}" hat keinen gerenderten Inhalt (content.subject + content.text/html).`
      )
    }

    const from = notification.from || this.options_.from
    if (!from) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "SMTP_FROM ist nicht gesetzt — ohne Absenderadresse nimmt kein Mailserver die Nachricht an."
      )
    }

    const info = await this.transporter().sendMail({
      from,
      to: notification.to,
      subject: content.subject,
      text: content.text || undefined,
      html: content.html || undefined,
    })

    // Kein Empfänger, kein Betreff, kein Inhalt im Log. Die Vorlage genügt, um
    // einen Versandfehler zuzuordnen; die Adresse ist ein Personendatum und
    // hat in einer Logdatei nichts verloren, die niemand je wieder löscht.
    this.logger_.info(`[smtp] Vorlage "${notification.template}" versendet.`)

    return { id: typeof info?.messageId === "string" ? info.messageId : undefined }
  }
}

export default SmtpNotificationProviderService
