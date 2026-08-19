#!/usr/bin/env bash
#
# Frische Ubuntu-VPS -> lauffähiger jibbit-Stack.
#
# Installiert Docker aus dem offiziellen Repository (NICHT aus Ubuntus
# docker.io-Paket: das ist regelmässig Jahre alt und bringt kein
# `docker compose` als Plugin mit), legt die Verzeichnisstruktur an und klont
# beide Repositories nebeneinander — docker-compose.yml baut die Storefront
# aus ../jibbit-frontend.
#
# Nutzung auf der VPS:
#   curl -fsSL https://raw.githubusercontent.com/nebjor/medusa-ecom/main/scripts/vps-bootstrap.sh | bash
# oder nach dem Klonen:
#   sudo bash scripts/vps-bootstrap.sh
#
# Das Script ist idempotent: mehrfaches Ausführen ist unschädlich.
# Es startet NICHTS — dafür fehlen noch die Secrets in .env, und ein Stack,
# der mit Platzhalter-Secrets hochkommt, ist gefährlicher als keiner.

set -euo pipefail

REPO_OWNER="${REPO_OWNER:-nebjor}"
TARGET_DIR="${TARGET_DIR:-/opt/jibbit}"
RUN_USER="${SUDO_USER:-${USER:-root}}"

log()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!  %s\033[0m\n' "$*"; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Bitte mit sudo ausführen." >&2
    exit 1
  fi
}

# ─── Docker ──────────────────────────────────────────────────────────────────

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker ist bereits installiert ($(docker --version))"
    return
  fi

  log "Docker installieren"

  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg git

  install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.asc ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
  fi

  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin

  systemctl enable --now docker

  if [ "$RUN_USER" != "root" ]; then
    usermod -aG docker "$RUN_USER"
    warn "Benutzer '$RUN_USER' zur Gruppe docker hinzugefügt — einmal ab- und wieder anmelden, sonst braucht jeder docker-Befehl weiter sudo."
  fi
}

# ─── Swap ────────────────────────────────────────────────────────────────────

# Auf kleinen VPS (2 GB) reicht der Speicher fuer `next build` und
# `medusa build` nicht: beide Builds laufen hier auf der Kiste, und der
# OOM-Killer trifft sie mitten im Bundling. Ein Swapfile faengt das ab.
#
# Es ersetzt kein RAM — der Build wird auf einem Kern spuerbar langsamer.
# Aber er laeuft durch, statt nach zehn Minuten abzubrechen.
ensure_swap() {
  local total_mb swap_mb
  total_mb=$(free -m | awk '/^Mem:/{print $2}')
  swap_mb=$(free -m | awk '/^Swap:/{print $2}')

  if [ "$swap_mb" -gt 0 ]; then
    log "Swap vorhanden (${swap_mb} MB) — nicht angefasst"
    return
  fi

  if [ "$total_mb" -ge 3500 ]; then
    log "${total_mb} MB RAM, kein Swap noetig"
    return
  fi

  log "Nur ${total_mb} MB RAM und kein Swap — 4 GB Swapfile anlegen"

  if [ ! -f /swapfile ]; then
    fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

  # Erst auslagern, wenn es wirklich eng wird. Der Default (60) wuerde auf
  # einer Datenbank-Kiste unnoetig viel in den Swap schieben.
  sysctl -q vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf

  free -h | sed 's/^/  /'
}

# ─── Firewall ────────────────────────────────────────────────────────────────

configure_firewall() {
  command -v ufw >/dev/null 2>&1 || { warn "ufw nicht vorhanden, Firewall übersprungen"; return; }

  log "Firewall: 22, 80, 443 öffnen"
  ufw allow 22/tcp   >/dev/null
  ufw allow 80/tcp   >/dev/null
  ufw allow 443/tcp  >/dev/null

  # Postgres (5432) und Redis (6379) bleiben ZU. Beide sind in
  # docker-compose.yml auf den Host gemappt — auf einer öffentlichen VPS ist
  # das eine offene Datenbank, sobald die Firewall aus ist. Siehe Hinweis am
  # Ende dieses Scripts.
  ufw --force enable >/dev/null
  ufw status numbered | head -20
}

# ─── Repositories ────────────────────────────────────────────────────────────

clone_repos() {
  log "Repositories nach $TARGET_DIR"
  mkdir -p "$TARGET_DIR"

  for repo in medusa-ecom jibbit-frontend; do
    if [ -d "$TARGET_DIR/$repo/.git" ]; then
      echo "  $repo existiert bereits — übersprungen"
    else
      git clone --depth 1 "https://github.com/${REPO_OWNER}/${repo}.git" \
        "$TARGET_DIR/$repo"
    fi
  done

  chown -R "$RUN_USER":"$RUN_USER" "$TARGET_DIR"
}

# ─── Konfiguration vorbereiten ───────────────────────────────────────────────

prepare_env() {
  local env_file="$TARGET_DIR/medusa-ecom/.env"
  if [ -f "$env_file" ]; then
    log ".env existiert bereits — nicht angefasst"
    return
  fi

  log ".env aus .env.example anlegen, Secrets erzeugen"
  cp "$TARGET_DIR/medusa-ecom/.env.example" "$env_file" 2>/dev/null || touch "$env_file"

  # Zufällige Secrets statt Platzhalter. Ein Stack, der mit "supersecret"
  # hochkommt, ist schlimmer als einer, der gar nicht startet.
  {
    echo ""
    echo "# Von vps-bootstrap.sh erzeugt am $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "JWT_SECRET=$(openssl rand -hex 32)"
    echo "COOKIE_SECRET=$(openssl rand -hex 32)"
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo ""
    # Platzhalter, damit ueberhaupt gebaut werden kann.
    #
    # STATIC_TENANTS ist in docker-compose.yml als ${VAR:?...} deklariert, und
    # Compose interpoliert die GANZE Datei bei jedem Unterbefehl — auch bei
    # `docker compose build`. Ohne einen Wert bricht schon der erste Build ab,
    # mit einem Variablenfehler statt einer Bauausgabe.
    #
    # Der echte Wert braucht den Publishable Key, den es erst nach dem ersten
    # Medusa-Start gibt. Ein leeres Array loest das: parseStaticTenants()
    # liefert dafuer eine leere Tabelle, wirft nicht, und jeder Host laeuft in
    # 404 — die sichere Richtung. Vor dem Start der Storefront ersetzen.
    echo "STATIC_TENANTS=[]"
  } >> "$env_file"

  chmod 600 "$env_file"
  chown "$RUN_USER":"$RUN_USER" "$env_file"
}

# ─── Hauptlauf ───────────────────────────────────────────────────────────────

require_root
ensure_swap
install_docker
configure_firewall
clone_repos
prepare_env

cat <<EOF

$(printf '\033[1m')Bootstrap fertig.$(printf '\033[0m')

Docker: $(docker --version)
Compose: $(docker compose version --short 2>/dev/null || echo '?')
Verzeichnis: $TARGET_DIR

Noch von Hand, in dieser Reihenfolge:

 1. DNS auf diese VPS zeigen lassen — sonst schlägt Let's Encrypt fehl:
      jibbit.ch, www.jibbit.ch, api.jibbit.ch  ->  $(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || echo '<IP dieser VPS>')

 2. $TARGET_DIR/medusa-ecom/.env ausfüllen:
      PAYREXX_*        Zugangsdaten
      SMTP_*           Mailversand
      STORE_CORS       https://jibbit.ch
      ADMIN_CORS       https://api.jibbit.ch
      AUTH_CORS        https://jibbit.ch,https://api.jibbit.ch
      MEDUSA_BACKEND_URL  https://api.jibbit.ch
      STORE_URL        https://jibbit.ch
      NODE_ENV         production

 3. STATIC_TENANTS steht als Platzhalter "[]" in der .env — nur damit
    `docker compose build` ueberhaupt durchlaeuft. Solange er dort steht,
    antwortet die Storefront auf JEDEN Host mit 404. Vor ihrem Start durch
    den echten Wert ersetzen; der Publishable Key kommt aus dem Medusa-Admin
    und existiert erst nach Schritt 5:

      STATIC_TENANTS='[{"id":"jibbit","host":"jibbit.ch","aliases":["www.jibbit.ch"],"backendUrl":"http://medusa:9000","publishableKey":"pk_...","theme":{"storeName":"jibbit","domain":"jibbit.ch","themeColor":"#F6F5F3"}}]'

 4. cd $TARGET_DIR/medusa-ecom && docker compose up -d postgres redis medusa

 5. Migrationen, Seed, Admin-Benutzer:
      docker compose exec medusa npx medusa db:migrate
      docker compose exec medusa npx medusa exec ./src/scripts/seed.ts
      docker compose exec medusa npx medusa user -e du@example.ch -p '<passwort>'
    Publishable Key aus https://api.jibbit.ch/app -> Einstellungen holen,
    in STATIC_TENANTS eintragen (Schritt 3).

 6. docker compose up -d

$(printf '\033[33m')Vorher noch prüfen:$(printf '\033[0m')
  docker-compose.yml mappt Postgres (5432) und Redis (6379) auf den Host.
  Auf einer öffentlichen VPS ist das eine erreichbare Datenbank, sobald die
  Firewall einmal aus ist. Für Produktion beide "ports:"-Einträge entfernen —
  medusa erreicht sie ohnehin über das Compose-Netz. Solange jibbit-platform
  keine Tenants provisioniert, braucht sie niemand von aussen.
EOF
