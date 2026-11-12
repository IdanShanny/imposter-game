const prisma = require('../db');

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function quotePgIdentifier(name) {
    return `"${String(name).replace(/"/g, '""')}"`;
}

async function listPublicTables() {
    const rows = await prisma.$queryRaw`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name ASC
    `;
    return rows.map((row) => row.table_name);
}

async function fetchTableRows(tableName) {
    const tables = await listPublicTables();
    if (!tables.includes(tableName)) {
        return null;
    }
    const sql = `SELECT * FROM ${quotePgIdentifier(tableName)}`;
    return prisma.$queryRawUnsafe(sql);
}

function rowsToPlainText(rows) {
    if (!rows || rows.length === 0) {
        return '(empty table)\n';
    }
    const lines = rows.map((row) =>
        JSON.stringify(row, (_key, value) => {
            if (typeof value === 'bigint') {
                return value.toString();
            }
            if (value instanceof Date) {
                return value.toISOString();
            }
            return value;
        }),
    );
    return `${lines.join('\n')}\n`;
}

function registerDbViewerRoutes(app) {
    app.get('/db', async (req, res) => {
        try {
            const tables = await listPublicTables();
            const items = tables
                .map((name) => {
                    const href = `/db/${encodeURIComponent(name)}`;
                    return `<li><a href="${href}">${escapeHtml(name)}</a></li>`;
                })
                .join('\n');
            res.type('html').send(`<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Database tables</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.5; }
    h1 { font-size: 1.25rem; }
    a { color: #a31c1c; }
  </style>
</head>
<body>
  <h1>Database tables</h1>
  <p><a href="/">← Back to app</a></p>
  <ul>${items || '<li>(no tables)</li>'}</ul>
</body>
</html>`);
        } catch (err) {
            console.error('DB viewer index failed:', err);
            res.status(500).type('text/plain').send('Failed to list tables.\n');
        }
    });

    app.get('/db/:tableName', async (req, res) => {
        try {
            const tableName = decodeURIComponent(req.params.tableName);
            const rows = await fetchTableRows(tableName);
            if (rows === null) {
                res.status(404).type('text/plain').send('Table not found.\n');
                return;
            }
            const body = [
                `Table: ${tableName}`,
                `Rows: ${rows.length}`,
                '---',
                rowsToPlainText(rows),
            ].join('\n');
            res.type('text/plain; charset=utf-8').send(body);
        } catch (err) {
            console.error('DB viewer table failed:', err);
            res.status(500).type('text/plain').send('Failed to load table.\n');
        }
    });
}

module.exports = { registerDbViewerRoutes };
