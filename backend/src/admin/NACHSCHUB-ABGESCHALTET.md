# Nachschub (Nachbestellungen) — derzeit abgeschaltet

Die Nachschubsteuerung (Menüpunkt «Nachschub» mit der Einkaufsliste und der
Abschnitt «Nachschub» an der Produktseite: Lieferanten, Meldebestand,
Status «nachbestellen») ist vorerst aus dem Admin genommen. Der Code bleibt
im Repo.

## Wie abgeschaltet

Medusa sammelt Admin-Erweiterungen beim Build aus `src/admin/routes` und
`src/admin/widgets` ein — **Ordner, deren Name mit `_` beginnt, werden dabei
übersprungen** (`crawl()` in `@medusajs/admin-vite-plugin`:
`exclude((dirName) => dirName.startsWith("_"))`). Das gilt nur für Ordner,
nicht für Dateinamen. Deshalb:

| aktiv (vorher)                          | abgeschaltet (jetzt)                               |
| --------------------------------------- | -------------------------------------------------- |
| `src/admin/routes/nachschub/page.tsx`   | `src/admin/routes/_nachschub/page.tsx`             |
| `src/admin/widgets/nachschub-widget.tsx`| `src/admin/widgets/_disabled/nachschub-widget.tsx` |

Ein Env-Schalter geht hier nicht: der Menüpunkt wird beim Build per
AST-Analyse aus `defineRouteConfig({ label })` erzeugt, zur Laufzeit lässt
er sich nicht mehr entfernen.

Unverändert und weiter aktiv:

- `src/lib/nachschub.ts` — reine Funktionen, auch von der Middleware und
  den Unit-Tests genutzt.
- `src/api/middlewares.ts` → `validateNachschubBody`: prüft bei
  `POST /admin/products*` weiterhin, dass Lieferanten-Adressen in der
  metadata nur http(s) sind. Die Daten bleiben in der Datenbank, also bleibt
  auch der Schutz.
- `src/scripts/nachschub-report.ts` — läuft nur, wenn man ihn von Hand mit
  `medusa exec` startet.
- `src/admin/lib/nachschub-daten.ts`, `src/admin/components/lieferant-link.tsx`
  — werden von nichts mehr importiert und landen nicht im Bundle.

Daten: keine Tabellen, keine Migrationen. Lieferanten und Meldebestände
liegen in `product.metadata.suppliers` bzw. `variant.metadata.reorder_point`
und bleiben unangetastet.

## Wieder einschalten

Entweder den Abschalt-Commit zurücknehmen (`git revert <commit>`), oder von
Hand im Ordner `backend/`:

```sh
git mv src/admin/routes/_nachschub src/admin/routes/nachschub
git mv src/admin/widgets/_disabled/nachschub-widget.tsx src/admin/widgets/nachschub-widget.tsx
```

Dann im Widget die vier relativen Imports um eine Ebene kürzen
(`../../../lib/nachschub` → `../../lib/nachschub`,
`../../components/…` → `../components/…`, `../../lib/nachschub-daten` →
`../lib/nachschub-daten`, `../../lib/sdk` → `../lib/sdk`), die
«DERZEIT ABGESCHALTET»-Hinweise in beiden Dateien und diese Datei löschen
und das Backend neu bauen (`npm run build`) — ohne neuen Build bleibt das
Admin-Bundle, wie es ist.
