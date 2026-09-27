#!/usr/bin/env bash
# Bring a fresh clone (or a fresh cloud session) to a state where tests run.
# Idempotent: safe to re-run. See docs/deployment-architecture.md §2.
set -euo pipefail
cd "$(dirname "$0")/.."

log() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }

[ -f .env ] || { log "creating .env from .env.example"; cp .env.example .env; }

log "installing dependencies"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  log "starting docker dependencies (postgres, redis, minio, mailhog)"
  docker compose -f infra/docker/compose.yml up -d
  log "waiting for postgres"
  for _ in $(seq 1 30); do
    docker compose -f infra/docker/compose.yml exec -T postgres pg_isready -U leados -d leados >/dev/null 2>&1 && break
    sleep 1
  done
else
  log "docker unavailable — expecting postgres and redis to be reachable per .env"
fi

log "generating prisma client"
pnpm db:generate

log "applying migrations"
pnpm db:deploy

log "seeding"
pnpm db:seed

log "ready:  pnpm dev   |   pnpm test   |   pnpm test:int"
