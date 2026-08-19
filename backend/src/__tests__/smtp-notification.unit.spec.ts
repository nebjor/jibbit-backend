/**
 * Tests für den SMTP-Notification-Provider
 * (backend/src/modules/smtp/service.ts).
 *
 * nodemailer wird gemockt, nicht gegen einen echten Mailserver getestet: der
 * Test prüft, dass wir die RICHTIGEN Felder übergeben (Empfänger, Absender,
 * Betreff, text UND html) und dass unvollständige Konfiguration früh knallt
 * statt erst beim ersten echten Versand. Ob nodemailer SMTP korrekt spricht,
 * ist Vertrauen in nodemailer, nicht Teil dieses Moduls.
 *
 * Der Versand über eine echte SMTP-Verbindung wurde einmalig gegen einen
 * Wegwerf-Server verifiziert (multipart/alternative, Empfänger und Absender
 * korrekt auf der Leitung) — das gehört aber nicht in einen Unit-Test.
 */

// Die Mocks MÜSSEN in der Factory entstehen: der Import unten wird über die
// const-Deklarationen gehoben, laedt service.ts, das nodemailer verlangt — die
// Factory laeuft also, bevor eine aeussere const initialisiert ist (TDZ).
jest.mock("nodemailer", () => {
  const sendMail = jest.fn()
  const createTransport = jest.fn(() => ({ sendMail }))
  return {
    __esModule: true,
    default: { createTransport },
    createTransport,
    __sendMail: sendMail,
  }
})

import SmtpNotificationProviderService from "../modules/smtp/service"

const nodemailerMock = jest.requireMock("nodemailer") as {
  createTransport: jest.Mock
  __sendMail: jest.Mock
}
const mockCreateTransport = nodemailerMock.createTransport
const mockSendMail = nodemailerMock.__sendMail

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as never

const OPTIONS = {
  host: "mail.infomaniak.com",
  port: 587,
  user: "shop@jibbit.ch",
  pass: "geheim",
  from: "jibbit.ch <noreply@jibbit.ch>",
}

const CONTENT = {
  subject: "Neue Bestellung #1042",
  text: "2x dubi Aktivkohlefilter",
  html: "<p>2x dubi Aktivkohlefilter</p>",
}

beforeEach(() => {
  mockSendMail.mockReset()
  mockSendMail.mockResolvedValue({ messageId: "<abc@jibbit.ch>" })
  mockCreateTransport.mockClear()
})

describe("validateOptions", () => {
  it("verlangt einen Host", () => {
    expect(() =>
      SmtpNotificationProviderService.validateOptions({ from: "a@b.ch" })
    ).toThrow(/host/i)
  })

  it("verlangt einen Absender", () => {
    expect(() =>
      SmtpNotificationProviderService.validateOptions({ host: "mail.x.ch" })
    ).toThrow(/from/i)
  })

  it("lehnt halb gesetzte Auth ab — sonst scheitert erst der Versand", () => {
    expect(() =>
      SmtpNotificationProviderService.validateOptions({
        host: "mail.x.ch",
        from: "a@b.ch",
        user: "wer",
      })
    ).toThrow(/user.*pass|pass.*user/i)
  })

  it("akzeptiert eine vollständige Konfiguration", () => {
    expect(() =>
      SmtpNotificationProviderService.validateOptions(OPTIONS)
    ).not.toThrow()
  })
})

describe("Transport-Aufbau", () => {
  it("nutzt STARTTLS auf 587", () => {
    new SmtpNotificationProviderService({ logger }, OPTIONS)
    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false })
    )
  })

  it("nutzt implizites TLS auf 465", () => {
    new SmtpNotificationProviderService({ logger }, { ...OPTIONS, port: 465 })
    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true })
    )
  })

  it("sendet ohne Auth, wenn keine Zugangsdaten gesetzt sind", () => {
    new SmtpNotificationProviderService(
      { logger },
      { host: "relay.intern", from: "a@b.ch" }
    )
    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.not.objectContaining({ auth: expect.anything() })
    )
  })
})

describe("send", () => {
  const service = () => new SmtpNotificationProviderService({ logger }, OPTIONS)

  it("übergibt Empfänger, Betreff, Text und HTML", async () => {
    await service().send({
      to: "demo@example.com",
      channel: "email",
      template: "order-placed-owner",
      content: CONTENT,
    })

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "demo@example.com",
        from: OPTIONS.from,
        subject: CONTENT.subject,
        text: CONTENT.text,
        html: CONTENT.html,
      })
    )
  })

  it("gibt die messageId zurück", async () => {
    const res = await service().send({
      to: "a@b.ch",
      channel: "email",
      template: "t",
      content: CONTENT,
    })

    expect(res).toEqual({ id: "<abc@jibbit.ch>" })
  })

  it("lässt einen abweichenden Absender gewinnen", async () => {
    await service().send({
      to: "a@b.ch",
      from: "support@jibbit.ch",
      channel: "email",
      template: "t",
      content: CONTENT,
    })

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "support@jibbit.ch" })
    )
  })

  it("wirft ohne Betreff", async () => {
    await expect(
      service().send({
        to: "a@b.ch",
        channel: "email",
        template: "t",
        content: { text: "ohne Betreff" },
      })
    ).rejects.toThrow(/subject/i)
    expect(mockSendMail).not.toHaveBeenCalled()
  })

  it("wirft, wenn weder html noch text gesetzt ist", async () => {
    await expect(
      service().send({
        to: "a@b.ch",
        channel: "email",
        template: "t",
        content: { subject: "nur Betreff" },
      })
    ).rejects.toThrow()
    expect(mockSendMail).not.toHaveBeenCalled()
  })

  it("reicht Anhänge im nodemailer-Format durch", async () => {
    await service().send({
      to: "a@b.ch",
      channel: "email",
      template: "t",
      content: CONTENT,
      attachments: [
        { filename: "rechnung.pdf", content: "JVBER", content_type: "application/pdf" },
      ],
    })

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            filename: "rechnung.pdf",
            contentType: "application/pdf",
          }),
        ],
      })
    )
  })
})
