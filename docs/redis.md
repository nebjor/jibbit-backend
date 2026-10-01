# Redis im Betrieb

Redis läuft als Dienst `redis` im Compose (`redis:7-alpine`, Volume `redis_data`). Der Medusa-Container bekommt
`REDIS_URL=redis://redis:6379`. Konfiguriert wird in `backend/src/lib/redis-modules.ts`, eingebunden in
`backend/medusa-config.ts`.

## Was auf Redis läuft

| Teil | Modul | Auf Redis | Wozu |
|---|---|---|---|
| Sessions (Admin-Login) | `projectConfig.redisUrl` | ja (schon vorher) | Anmeldung überlebt einen Neustart von Medusa. |
| Event-Bus | `@medusajs/medusa/event-bus-redis` | ja (neu) | Ereignisse wie `order.placed` liegen als Job in Redis, bis ein Subscriber sie verarbeitet hat. |
| Workflow-Engine | `@medusajs/medusa/workflow-engine-redis` | ja (neu) | Wiederholungen und Timeouts von Workflow-Schritten, geplante Jobs (`src/jobs/`). |
| Locking | `@medusajs/medusa/locking` mit Provider `locking-redis` | ja (neu) | Sperren beim Reservieren von Lagerbestand und im Checkout. |
| Cache (`cache-inmemory`) | Standardmodul | nein | Seit Medusa 2.11 abgelöst, der Kern benutzt es nicht mehr. |
| Caching (`@medusajs/medusa/caching`) | nicht geladen | nein | Nur aktiv mit dem Feature-Flag `MEDUSA_FF_CACHING` (in 2.13.6 als «WIP» markiert). Ein Cache gehört ausserdem nicht in ein Redis mit `noeviction`. |

Alle Pakete sind Abhängigkeiten von `@medusajs/medusa`. Es kommt kein neues Paket dazu.

**Ohne `REDIS_URL`** (lokale Entwicklung, Unit-Tests, `medusa build`) lädt Medusa wie bisher seine In-Memory-Module.

## Was sich dadurch ändert

- **Ereignisse überleben einen Neustart.** Wird der Medusa-Container neu gestartet, während ein Ereignis wartet oder
  gerade verarbeitet wird, holt der Server es nach dem Start nach. Vorher war es weg, und mit ihm die Mail.
- **Keine automatische Wiederholung bei Mail-Fehlern.** Die Mail-Subscriber fangen ihre Fehler selbst ab und werfen
  nie (`backend/src/lib/notify.ts`). Für den Event-Bus gilt das Ereignis damit als erledigt, auch wenn der SMTP-Server
  nicht erreichbar war. Der Fehler steht wie bisher im Log unter `[notify]`. `attempts` ist deshalb bewusst nicht
  gesetzt: Wer Wiederholungen will, muss zuerst jeden Subscriber gegen Doppelversand absichern.
- **Ein Job kann doppelt laufen.** Stirbt der Prozess mitten in der Verarbeitung, startet BullMQ den Job nach dem
  Neustart noch einmal. Eine Mail, die kurz vor dem Absturz schon draussen war, geht dann ein zweites Mal raus. Die
  Versandbestätigung ist dagegen abgesichert (siehe `docs/e-mails.md`), die anderen Mails nicht.
- **Skripte (`medusa exec`) verarbeiten keine Ereignisse mehr selbst.** `medusa exec` läuft im Modus `server`, ohne
  Worker. Löst ein Skript ein Ereignis aus, für das es einen Subscriber gibt, landet es in Redis, und der **laufende
  Medusa-Server** verarbeitet es. Vorher lief der Subscriber im Skript-Prozess oder gar nicht, weil das Skript sich
  vorher beendete. Praktisch heisst das: Ein Skript, das Bestellungen, Einladungen oder Sendungen anlegt, löst jetzt
  zuverlässig die zugehörigen Mails aus. Läuft kein Server, warten die Ereignisse in Redis, bis einer startet.
- **Skripte und `db:migrate` bleiben nicht hängen.** Beide beenden sich mit `process.exit()`, offene
  Redis-Verbindungen halten den Prozess nicht am Leben.

## Aufbewahrung von Jobs

| Job | Verbleib |
|---|---|
| Ereignis erledigt | sofort gelöscht. Die Daten von `auth.password_reset` enthalten das Reset-Token, deshalb wird nichts aufbewahrt. |
| Ereignis fehlgeschlagen | höchstens 7 Tage und höchstens 500 Stück (`removeOnFail`). |
| Workflow-Jobs | räumt das Modul selbst auf. |

## Persistenz und Speicher

Der Dienst startet mit (`docker-compose.yml`):

```
redis-server --appendonly yes --appendfsync everysec --maxmemory 128mb --maxmemory-policy noeviction
```

- **AOF (`appendonly yes`, `everysec`):** Bei einem Absturz von Redis geht höchstens die letzte Sekunde verloren. Die
  RDB-Snapshots des Images bleiben zusätzlich aktiv. Beides liegt im Volume `redis_data` unter `/data`
  (`dump.rdb`, `appendonlydir/`).
- **`noeviction`:** Redis löscht bei vollem Speicher nichts. Schreibzugriffe schlagen dann mit
  `OOM command not allowed` fehl. Das ist Absicht: Jede andere Policy dürfte wartende Jobs löschen.
- **`maxmemory`:** Vorgabe 128 MB, über `REDIS_MAXMEMORY` in der `.env` änderbar. Der Shop braucht wenige MB.
- **Platz auf der Platte:** Die AOF-Datei wird von Redis selbst neu geschrieben, sobald sie sich verdoppelt hat
  (ab 64 MB). Bei dieser Datenmenge bleibt sie im einstelligen MB-Bereich.

Das Volume `redis_data` ist **nicht** im Backup. Das ist in Ordnung: Verloren gingen Sessions (neu anmelden) und
Ereignisse, die in diesem Moment warten.

## Auf dem Server prüfen

### 1. Beim Start im Log

```bash
docker compose logs medusa | grep -i -E "redis|event bus|locking"
```

Erwartet:

```
Connection to Redis in module 'event-bus-redis' established
[Workflow-engine-redis] Connection to Redis in module 'workflow-engine-redis' established
[Workflow-engine-redis] Connection to Redis PubSub in module 'workflow-engine-redis' established
Connection to Redis in "locking-redis" provider established
```

Für das Locking gibt es keine eigene Zeile «Using ... as default»: Medusa schreibt sie nur, wenn kein Provider
ausdrücklich als Standard gesetzt ist.

**Nicht** mehr erscheinen darf:

```
Local Event Bus installed. This is not recommended for production.
Locking module: Using "in-memory" as default.
```

Steht das noch da, ist `REDIS_URL` im Container leer: `docker compose exec medusa printenv REDIS_URL`.

### 2. Einstellungen von Redis

```bash
docker compose exec redis redis-cli config get appendonly          # yes
docker compose exec redis redis-cli config get maxmemory-policy    # noeviction
docker compose exec redis redis-cli config get maxmemory           # 134217728
docker compose exec redis redis-cli info persistence | grep -E "aof_enabled|aof_last_write_status"
docker compose exec redis redis-cli info memory | grep -E "used_memory_human|maxmemory_human"
```

### 3. Schlüssel und Warteschlangen

```bash
# Übersicht, welche Arten von Schlüsseln es gibt (SCAN, blockiert Redis nicht)
docker compose exec redis redis-cli --scan --count 1000 | sed -E 's/:[^:]*$//' | sort | uniq -c | sort -rn | head

# Event-Bus: wartende, laufende, fehlgeschlagene Jobs
docker compose exec redis redis-cli llen  "RedisEventBusService:events-queue:wait"
docker compose exec redis redis-cli zcard "RedisEventBusService:events-queue:prioritized"
docker compose exec redis redis-cli llen  "RedisEventBusService:events-queue:active"
docker compose exec redis redis-cli zcard "RedisEventBusService:events-queue:failed"

# Workflow-Engine und geplante Jobs
docker compose exec redis redis-cli --scan --pattern "bull:medusa-workflows*" | head
```

Im Ruhezustand stehen alle vier Zähler des Event-Bus auf 0. Ereignisse mit Priorität (das ist die Regel) stehen in
`prioritized`, nicht in `wait`.

### 4. Ein Ereignis verfolgen

Im Admin das Passwort eines vorhandenen Benutzers zurücksetzen lassen oder eine Testbestellung aufgeben. Im Log steht
dann:

```
Processing order.placed (priority: 100) which has 1 subscribers
```

Diese Zeile schreibt nur der Redis-Event-Bus.

### Lokal geprüft (29.09.2026, Medusa 2.13.6, Redis 7 mit den Optionen oben)

- Start mit `REDIS_URL`: die vier Verbindungszeilen erscheinen, `/health` antwortet 200.
- Start ohne `REDIS_URL`: «Local Event Bus installed» und «Using "in-memory" as default», wie bisher.
- `medusa db:migrate` und `medusa exec` mit `REDIS_URL` beenden sich sauber (Exit 0).
- Ein per `medusa exec` ausgelöstes `auth.password_reset` lag ohne laufenden Server in `prioritized`, überstand
  `docker restart` von Redis und wurde beim nächsten Start des Servers verarbeitet. Danach waren alle Zähler 0.

## Was bei einem Neustart passiert

| Neustart von | Folge |
|---|---|
| Medusa (`docker compose up -d --build medusa`, Absturz) | Der Worker beendet laufende Jobs, soweit er Zeit hat. Wartende Ereignisse bleiben in Redis und laufen nach dem Start. Ein abgebrochener Job wird nach rund 30 Sekunden als hängengeblieben erkannt und noch einmal gestartet. |
| Redis (`docker compose restart redis`) | Redis lädt die AOF-Datei, die Warteschlangen sind wieder da. Medusa verbindet sich von selbst neu, im Log stehen in der Zwischenzeit Verbindungsfehler. Anfragen, die in diesen Sekunden ein Ereignis auslösen oder eine Sperre brauchen, können fehlschlagen. |
| ganze VPS | Compose startet Redis vor Medusa (`depends_on: service_healthy`). Danach wie oben. |
| Redis-Volume gelöscht (`docker compose down -v`) | Sessions und wartende Ereignisse sind weg. Geplante Jobs legt Medusa beim Start neu an. |

## Redis ist nicht erreichbar

Medusa startet trotzdem, die Module melden den Fehler im Log (`An error occurred while connecting to Redis ...`) und
versuchen es weiter. Solange Redis fehlt, schlagen Aktionen fehl, die ein Ereignis auslösen oder eine Sperre brauchen
— also auch der Checkout. Redis ist damit so wichtig wie die Datenbank.

**Notausgang:** In `docker-compose.yml` beim Dienst `medusa` die Zeile `REDIS_URL` auskommentieren und
`docker compose up -d medusa`. Der Shop läuft dann wieder mit den In-Memory-Modulen (und ohne Redis-Sessions).
