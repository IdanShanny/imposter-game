#!/usr/bin/env sh
cd "$(dirname "$0")/.."
if [ -n "$DATABASE_URL" ]; then
  npx prisma migrate deploy || echo "WARN: prisma migrate deploy failed; starting anyway"
else
  echo "WARN: DATABASE_URL unset — running without database"
fi
exec node server.js
