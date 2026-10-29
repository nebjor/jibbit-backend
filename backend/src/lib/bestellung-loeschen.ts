/**
 * «Bestellung endgültig löschen» — reine Entscheidungslogik, ohne Datenbank.
 *
 * Medusas «Stornieren» geht bei einer Bestellung mit versandter Lieferung
 * nicht («All fulfillments must be canceled before canceling an order»), und
 * eine versandte Lieferung lässt sich nicht stornieren. Für Testbestellungen
 * braucht der Shop-Inhaber trotzdem einen Weg. Dieser Weg ist bewusst NICHT
 * `cancelOrderWorkflow`, denn der erstattet erfasste Zahlungen immer
 * (Rückerstattung lässt sich dort nicht abwählen) und bricht bei einer
 * versandten Lieferung ab. Stattdessen setzt der Workflow die Einzelschritte
 * selbst zusammen; was davon gilt, entscheidet diese Datei.
 *
 * Reihenfolge der Wirkung (siehe workflows/bestellung-loeschen):
 *   1. offene (nicht versandte) Lieferungen stornieren — Medusa legt dabei
 *      Bestand und Reservierung zurück,
 *   2. versandte Ware optional zurück ins Lager buchen,
 *   3. restliche Reservierungen der Bestellung löschen,
 *   4. nicht erfasste Zahlungen abbrechen,
 *   5. erfasste Zahlungen optional zurückerstatten (echtes Geld!),
 *   6. Bestellung weich löschen (`deleted_at`): sie verschwindet aus Listen,
 *      Dashboard und Berichten; die Zeilen bleiben in der Datenbank.
 */

/** Position einer Lieferung. `inventory_item_id` ist null bei Artikeln ohne Bestandsführung. */
export type LieferPosition = {
  line_item_id: string
  inventory_item_id: string | null
  quantity: number
}

export type LieferungSicht = {
  id: string
  location_id: string | null
  canceled_at: string | Date | null
  shipped_at: string | Date | null
  items: LieferPosition[]
}

export type ZahlungSicht = {
  id: string
  /** Summe der Erfassungen (captures), in Hauptwährung. */
  erfasst: number
  /** Summe der Rückerstattungen. */
  erstattet: number
  currency_code: string | null
}

export type BestellLage = {
  id: string
  display_id: number
  /** Status der Bestellung; «canceled» heisst: bereits storniert. */
  status: string
  line_item_ids: string[]
  lieferungen: LieferungSicht[]
  zahlungen: ZahlungSicht[]
}

export type LoeschOptionen = {
  bestaetigung: string
  zahlung_erstatten: boolean
  ware_zurueck_ins_lager: boolean
}

export type LagerRueckbuchung = {
  inventory_item_id: string
  location_id: string
  menge: number
}

export type LoeschPlan = {
  order_id: string
  display_id: number
  /** Nicht versandte, nicht stornierte Lieferungen: werden storniert. */
  lieferungen_stornieren: string[]
  /** Versandte Lieferungen (bleiben als Datensatz; Ware ist beim Kunden). */
  lieferungen_versandt: string[]
  /** Nur gefüllt mit `ware_zurueck_ins_lager`; zusammengefasst je Artikel und Lager. */
  lager_zurueckbuchen: LagerRueckbuchung[]
  /** Zahlungen ohne Erfassung: werden beim Anbieter abgebrochen. */
  zahlungen_abbrechen: string[]
  /** Je Zahlung der Betrag, der zurückerstattet wird (leer ohne Häkchen). */
  erstattungen: { payment_id: string; amount: number }[]
  /** Summe von `erstattungen`. */
  erstattung_betrag: number
  /** Erfasster, aber NICHT zurückerstatteter Betrag: bleibt beim Shop. */
  nicht_erstattet_betrag: number
  currency_code: string | null
  line_item_ids: string[]
  /** Kurze Hinweise für die Vorschau im Dialog. */
  hinweise: string[]
}

export type LoeschEntscheid = { ok: true; plan: LoeschPlan } | { ok: false; fehler: string }

/** Rundet auf Rappen, damit Gleitkomma-Reste nicht als Betrag erscheinen. */
const rappen = (n: number) => Math.round(n * 100) / 100

export function istStorniert(lage: Pick<BestellLage, "status">): boolean {
  return lage.status === "canceled"
}

/**
 * Entscheidet, was beim Löschen geschieht. Wirft nie; Verweigerungen kommen
 * als `{ ok: false, fehler }` mit deutschem Text zurück.
 *
 * Verweigert wird nur, wenn die Bestätigung nicht der Bestellnummer
 * entspricht. Alles andere ist erlaubt, die Folgen stehen im Plan.
 */
export function entscheideBestellungLoeschen(
  lage: BestellLage,
  optionen: LoeschOptionen
): LoeschEntscheid {
  const erwartet = String(lage.display_id)
  if (optionen.bestaetigung.trim().replace(/^#/, "") !== erwartet) {
    return {
      ok: false,
      fehler: `Bestätigung stimmt nicht: Zum Löschen muss die Bestellnummer ${erwartet} eingegeben werden.`,
    }
  }

  const aktiv = lage.lieferungen.filter((l) => !l.canceled_at)
  const versandt = aktiv.filter((l) => l.shipped_at)
  // Eine stornierte Bestellung hat keine offenen Lieferungen mehr; Medusa
  // würde das Stornieren einer Lieferung dort ohnehin verweigern.
  const offen = istStorniert(lage) ? [] : aktiv.filter((l) => !l.shipped_at)

  const lager = new Map<string, LagerRueckbuchung>()
  if (optionen.ware_zurueck_ins_lager) {
    for (const l of versandt) {
      if (!l.location_id) continue
      for (const p of l.items) {
        if (!p.inventory_item_id || p.quantity <= 0) continue
        const key = `${p.inventory_item_id}|${l.location_id}`
        const alt = lager.get(key)
        if (alt) alt.menge += p.quantity
        else {
          lager.set(key, {
            inventory_item_id: p.inventory_item_id,
            location_id: l.location_id,
            menge: p.quantity,
          })
        }
      }
    }
  }

  const zahlungen_abbrechen = lage.zahlungen.filter((z) => z.erfasst <= 0).map((z) => z.id)
  const erstattbar = rappen(
    lage.zahlungen.reduce((s, z) => s + Math.max(0, z.erfasst - z.erstattet), 0)
  )
  const erstattungen = optionen.zahlung_erstatten
    ? lage.zahlungen
        .map((z) => ({ payment_id: z.id, amount: rappen(z.erfasst - z.erstattet) }))
        .filter((e) => e.amount > 0)
    : []
  const erstattung_betrag = rappen(erstattungen.reduce((s, e) => s + e.amount, 0))
  const nicht_erstattet_betrag = optionen.zahlung_erstatten ? 0 : erstattbar

  const hinweise: string[] = []
  if (versandt.length > 0 && !optionen.ware_zurueck_ins_lager) {
    hinweise.push(
      "Versandte Ware wird nicht ins Lager zurückgebucht; der Bestand bleibt unverändert."
    )
  }
  if (optionen.ware_zurueck_ins_lager && versandt.length === 0) {
    hinweise.push("Es gibt keine versandte Lieferung; nichts wird ins Lager zurückgebucht.")
  }
  if (nicht_erstattet_betrag > 0) {
    hinweise.push(
      "Die Zahlung wird nicht zurückerstattet. Das Geld bleibt beim Shop; gelöscht wird nur die Bestellung."
    )
  }

  return {
    ok: true,
    plan: {
      order_id: lage.id,
      display_id: lage.display_id,
      lieferungen_stornieren: offen.map((l) => l.id),
      lieferungen_versandt: versandt.map((l) => l.id),
      lager_zurueckbuchen: [...lager.values()],
      zahlungen_abbrechen,
      erstattungen,
      erstattung_betrag,
      nicht_erstattet_betrag,
      currency_code: lage.zahlungen[0]?.currency_code ?? null,
      line_item_ids: lage.line_item_ids,
      hinweise,
    },
  }
}
