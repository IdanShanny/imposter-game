const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const PORT = process.env.PORT || 3000;
const VERSION = '0.3.0';

const server = http.createServer(app);
const io = new Server(server);

io.on('connection', (socket) => {
    console.log(`חיבור Socket.io: ${socket.id}`);
    socket.on('disconnect', (reason) => {
        console.log(`ניתוק Socket.io: ${socket.id} (${reason})`);
    });
});

app.get('/api/health', (req, res) => {
    res.json({ ok: true, version: VERSION });
});

// פקודה שאומרת לשרת: כל הקבצים בתיקיית public (כמו ה-index.html) זמינים לציבור
app.use(express.static('public'));

server.listen(PORT, () => {
    console.log(`השרת רץ בהצלחה! היכנס לדפדפן בכתובת: http://localhost:${PORT}`);
});