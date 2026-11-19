let prisma = null;

if (process.env.DATABASE_URL) {
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
}

module.exports = prisma;
