#!/usr/bin/env sh
set -e
cd "$(dirname "$0")/.."
if [ -z "$DATABASE_URL" ]; then
  echo "FATAL: Set DATABASE_URL on this Render service (Environment) to your Postgres connection string."
  exit 1
fi
npx prisma migrate deploy
exec node server.js
