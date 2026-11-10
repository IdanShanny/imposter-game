#!/usr/bin/env sh
set -e
cd "$(dirname "$0")/.."
npm ci
# generate only validates schema/env; no DB connection needed
export DATABASE_URL="${DATABASE_URL:-postgresql://build:build@127.0.0.1:5432/build?schema=public}"
npx prisma generate
