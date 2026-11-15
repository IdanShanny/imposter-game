const prisma = require('../db');

const DB_FAVICON_LINK =
    '<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🗄️</text></svg>">';

const DB_PAGE_STYLES = `
    body { font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.5; }
    h1 { font-size: 1.25rem; }
    a { color: #a31c1c; }
    pre { white-space: pre-wrap; word-break: break-word; font-size: 0.875rem; }
    ul ul { margin: 0.35rem 0 0.5rem 0; font-size: 0.95rem; }
    ul ul li { margin: 0.25rem 0; color: #444; }
`;

function renderDbHtmlDocument(title, bodyHtml) {
    return `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  ${DB_FAVICON_LINK}
  <style>${DB_PAGE_STYLES}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function renderDbPlainTextPage(title, plainText) {
    const body = `
  <p><a href="/db">← Database tables</a> · <a href="/">App</a></p>
  <pre>${escapeHtml(plainText)}</pre>`;
    return renderDbHtmlDocument(title, body);
}

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

const KNOWN_GAME_TYPES = ['imposter', 'toDavar', 'whoSaid'];

async function fetchRoomGameTypeDistribution() {
    const groups = await prisma.room.groupBy({
        by: ['gameType'],
        _count: { _all: true },
    });
    const counts = Object.fromEntries(KNOWN_GAME_TYPES.map((t) => [t, 0]));
    let other = 0;
    for (const row of groups) {
        const key = row.gameType || '(unset)';
        const n = row._count._all;
        if (Object.prototype.hasOwnProperty.call(counts, key)) {
            counts[key] = n;
        } else {
            other += n;
        }
    }
    const total = Object.values(counts).reduce((s, n) => s + n, 0) + other;
    return { counts, other, total };
}

async function fetchToDavarWordsByGame() {
    const rooms = await prisma.room.findMany({
        where: { gameType: 'toDavar' },
        orderBy: { createdAt: 'asc' },
        select: {
            code: true,
            createdAt: true,
            rounds: {
                orderBy: { startedAt: 'asc' },
                select: {
                    answers: {
                        orderBy: { submittedAt: 'asc' },
                        select: { text: true, submittedAt: true },
                    },
                },
            },
        },
    });
    return rooms.map((room) => {
        const words = room.rounds
            .flatMap((round) => round.answers)
            .sort((a, b) => a.submittedAt - b.submittedAt)
            .map((a) => a.text);
        return {
            code: room.code,
            createdAt: room.createdAt,
            words,
        };
    });
}

function formatShare(count, total) {
    if (!total) {
        return '(0%)';
    }
    const pct = (count / total) * 100;
    return `(${pct.toFixed(1)}%)`;
}

function distributionToPlainText({ counts, other, total }) {
    const lines = ['Room count by game type', '---', ''];
    for (const gameType of KNOWN_GAME_TYPES) {
        const n = counts[gameType];
        lines.push(`${gameType}: ${n} ${formatShare(n, total)}`);
    }
    if (other > 0) {
        lines.push(`other: ${other} ${formatShare(other, total)}`);
    }
    lines.push('', `Total: ${total}`, '');
    return lines.join('\n');
}

function toDavarWordsToPlainText(games) {
    const lines = [
        "To'Davar words by game (submission order, earliest → latest)",
        '---',
        '',
    ];
    if (games.length === 0) {
        lines.push('(no To\'Davar rooms yet)', '');
        return lines.join('\n');
    }
    for (const game of games) {
        const when = game.createdAt instanceof Date
            ? game.createdAt.toISOString()
            : String(game.createdAt);
        lines.push(`Room ${game.code} (created ${when})`);
        if (game.words.length === 0) {
            lines.push('  (no answers recorded)');
        } else {
            lines.push(`  ${game.words.join(', ')}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

function renderDbIndexList(tables) {
    const reportRoomDistribution = '/db/Room/Distribution';
    const reportToDavarWords = '/db/Answer/todavar-words';

    return tables
        .map((name) => {
            const href = `/db/${encodeURIComponent(name)}`;
            let extra = '';
            if (name === 'Room') {
                extra = `
    <ul>
      <li><a href="${reportRoomDistribution}">Distribution</a> — room count by game type</li>
    </ul>`;
            } else if (name === 'Answer') {
                extra = `
    <ul>
      <li><a href="${reportToDavarWords}">To'Davar words (chronological)</a> — words per game, in entry order</li>
    </ul>`;
            }
            return `<li><a href="${href}">${escapeHtml(name)}</a>${extra}</li>`;
        })
        .join('\n');
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
            const items = renderDbIndexList(tables);
            const indexBody = `
  <h1>Database tables</h1>
  <p><a href="/">← Back to app</a></p>
  <ul>${items || '<li>(no tables)</li>'}</ul>`;
            res.type('html').send(renderDbHtmlDocument('Database tables', indexBody));
        } catch (err) {
            console.error('DB viewer index failed:', err);
            res.status(500).type('text/plain').send('Failed to list tables.\n');
        }
    });

    app.get('/db/Room/Distribution', async (req, res) => {
        try {
            const data = await fetchRoomGameTypeDistribution();
            const title = 'Room distribution';
            res.type('html').send(
                renderDbPlainTextPage(title, distributionToPlainText(data)),
            );
        } catch (err) {
            console.error('DB report room distribution failed:', err);
            res.status(500).type('text/plain').send('Failed to load report.\n');
        }
    });

    app.get('/db/Answer/todavar-words', async (req, res) => {
        try {
            const games = await fetchToDavarWordsByGame();
            const title = "To'Davar words";
            res.type('html').send(
                renderDbPlainTextPage(title, toDavarWordsToPlainText(games)),
            );
        } catch (err) {
            console.error('DB report toDavar words failed:', err);
            res.status(500).type('text/plain').send('Failed to load report.\n');
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
            res.type('html').send(
                renderDbPlainTextPage(`Table: ${tableName}`, body),
            );
        } catch (err) {
            console.error('DB viewer table failed:', err);
            res.status(500).type('text/plain').send('Failed to load table.\n');
        }
    });
}

module.exports = { registerDbViewerRoutes };
