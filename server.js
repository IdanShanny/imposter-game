const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
app.set('trust proxy', 1);
const { registerRoomHandlers } = require('./game/rooms');

const PORT = process.env.PORT || 3000;
const VERSION = '2.1.4';

const server = http.createServer(app);
const io = new Server(server, {
    pingTimeout: 60000,
    pingInterval: 25000,
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception (process kept alive):', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection (process kept alive):', reason);
});

io.on('connection', (socket) => {
    console.log(`חיבור Socket.io: ${socket.id}`);
    registerRoomHandlers(io, socket);
    socket.on('disconnect', (reason) => {
        console.log(`ניתוק Socket.io: ${socket.id} (${reason})`);
    });
});

app.get('/api/health', (req, res) => {
    res.json({ ok: true, version: VERSION });
});

function buildJoinUrl(req, code) {
    const publicUrl = process.env.PUBLIC_URL;
    if (publicUrl) {
        return `${publicUrl.replace(/\/$/, '')}/?code=${code}`;
    }
    const proto = req.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol;
    const host = req.get('host');
    return `${proto}://${host}/?code=${code}`;
}

app.get('/api/join-url', (req, res) => {
    const code = String(req.query.code || '').trim();
    if (!/^\d{5}$/.test(code)) {
        return res.status(400).json({ error: 'invalid code' });
    }
    res.json({ url: buildJoinUrl(req, code) });
});

app.get('/api/qr.png', async (req, res) => {
    const code = String(req.query.code || '').trim();
    if (!/^\d{5}$/.test(code)) {
        return res.sendStatus(400);
    }
    try {
        const url = buildJoinUrl(req, code);
        const png = await QRCode.toBuffer(url, { margin: 1, width: 280 });
        res.type('png');
        res.send(png);
    } catch (err) {
        console.error('QR generation failed:', err);
        res.sendStatus(500);
    }
});

// פקודה שאומרת לשרת: כל הקבצים בתיקיית public (כמו ה-index.html) זמינים לציבור
app.use(express.static('public'));

server.listen(PORT, () => {
    console.log(`השרת רץ בהצלחה! היכנס לדפדפן בכתובת: http://localhost:${PORT}`);
});