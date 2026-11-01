const { pickRandomRound } = require('./prompts');

const rooms = new Map();

const MAX_NAME_LENGTH = 20;
const MAX_ANSWER_LENGTH = 120;
const MIN_PLAYERS_TO_START = 3;

function normalizeName(name) {
    return String(name || '').trim().slice(0, MAX_NAME_LENGTH);
}

function normalizeAnswer(text) {
    return String(text || '').trim().slice(0, MAX_ANSWER_LENGTH);
}

function generateRoomCode() {
    let code;
    do {
        code = String(Math.floor(10000 + Math.random() * 90000));
    } while (rooms.has(code));
    return code;
}

function playersPayload(room) {
    return Array.from(room.players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
    }));
}

function broadcastPlayers(io, room) {
    io.to(room.code).emit('room:players', {
        code: room.code,
        phase: room.phase,
        players: playersPayload(room),
        minPlayersToStart: MIN_PLAYERS_TO_START,
    });
}

function broadcastPhase(io, room) {
    io.to(room.code).emit('game:phase', {
        code: room.code,
        phase: room.phase,
    });
}

function broadcastAnswerProgress(io, room) {
    const total = room.players.size;
    const submitted = room.round ? room.round.answers.size : 0;
    io.to(room.code).emit('game:answerProgress', {
        submitted,
        total,
        allSubmitted: submitted >= total,
    });
}

function roomSnapshot(room, isHost) {
    return {
        code: room.code,
        phase: room.phase,
        players: playersPayload(room),
        isHost,
        minPlayersToStart: MIN_PLAYERS_TO_START,
    };
}

function sendPromptsToPlayers(io, room, round) {
    for (const [socketId] of room.players) {
        const isImposter = socketId === room.round.imposterSocketId;
        const question = isImposter ? round.imposterQuestion : round.realQuestion;
        const playerSocket = io.sockets.sockets.get(socketId);
        if (playerSocket) {
            playerSocket.emit('game:yourPrompt', { question });
        }
    }
}

function beginRound(io, room) {
    const round = pickRandomRound();
    const playerIds = Array.from(room.players.keys());
    const imposterSocketId = playerIds[Math.floor(Math.random() * playerIds.length)];

    room.round = {
        roundId: round.id,
        imposterSocketId,
        answers: new Map(),
    };
    room.phase = 'ANSWER';

    broadcastPhase(io, room);
    sendPromptsToPlayers(io, room, round);
    broadcastAnswerProgress(io, room);
}

function startGame(socket, io) {
    const code = socket.data.roomCode;
    if (!code) {
        return { error: 'אינך בחדר' };
    }

    const room = rooms.get(code);
    if (!room) {
        return { error: 'חדר לא נמצא' };
    }

    if (room.hostSocketId !== socket.id) {
        return { error: 'רק המארח יכול להתחיל את המשחק' };
    }

    if (room.phase !== 'LOBBY') {
        return { error: 'המשחק כבר התחיל' };
    }

    if (room.players.size < MIN_PLAYERS_TO_START) {
        return { error: `נדרשים לפחות ${MIN_PLAYERS_TO_START} שחקנים` };
    }

    beginRound(io, room);
    return { room };
}

function submitAnswer(socket, io, text) {
    const code = socket.data.roomCode;
    if (!code) {
        return { error: 'אינך בחדר' };
    }

    const room = rooms.get(code);
    if (!room || !room.round) {
        return { error: 'אין סיבוב פעיל' };
    }

    if (room.phase !== 'ANSWER') {
        return { error: 'לא בשלב תשובות' };
    }

    const player = room.players.get(socket.id);
    if (!player) {
        return { error: 'שחקן לא נמצא' };
    }

    if (room.round.answers.has(socket.id)) {
        return { error: 'כבר שלחת תשובה' };
    }

    const answerText = normalizeAnswer(text);
    if (!answerText) {
        return { error: 'נא להזין תשובה' };
    }

    room.round.answers.set(socket.id, {
        name: player.name,
        text: answerText,
    });

    broadcastAnswerProgress(io, room);
    return { ok: true };
}

function createRoom(socket, playerName) {
    const name = normalizeName(playerName);
    if (!name) {
        return { error: 'נא להזין שם תקין' };
    }

    const code = generateRoomCode();
    const room = {
        code,
        hostSocketId: socket.id,
        phase: 'LOBBY',
        players: new Map(),
        round: null,
    };

    room.players.set(socket.id, {
        id: socket.id,
        name,
        isHost: true,
    });

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;

    return { room, isHost: true };
}

function joinRoom(socket, code, playerName) {
    const name = normalizeName(playerName);
    if (!name) {
        return { error: 'נא להזין שם תקין' };
    }

    const normalizedCode = String(code || '').trim();
    if (!/^\d{5}$/.test(normalizedCode)) {
        return { error: 'קוד חדר חייב להיות 5 ספרות' };
    }

    const room = rooms.get(normalizedCode);
    if (!room) {
        return { error: 'חדר לא נמצא' };
    }

    if (room.phase !== 'LOBBY') {
        return { error: 'המשחק כבר התחיל' };
    }

    for (const player of room.players.values()) {
        if (player.name.toLowerCase() === name.toLowerCase() && player.id !== socket.id) {
            return { error: 'השם כבר תפוס בחדר זה' };
        }
    }

    const isHost = room.hostSocketId === socket.id;
    room.players.set(socket.id, {
        id: socket.id,
        name,
        isHost,
    });

    socket.join(normalizedCode);
    socket.data.roomCode = normalizedCode;

    return { room, isHost };
}

function leaveRoom(io, socket) {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    delete socket.data.roomCode;

    if (!room) return;

    room.players.delete(socket.id);
    socket.leave(code);

    if (room.players.size === 0) {
        rooms.delete(code);
        return;
    }

    if (room.hostSocketId === socket.id) {
        const nextHost = room.players.values().next().value;
        if (nextHost) {
            room.hostSocketId = nextHost.id;
            nextHost.isHost = true;
            for (const player of room.players.values()) {
                player.isHost = player.id === room.hostSocketId;
            }
        }
    }

    broadcastPlayers(io, room);
    if (room.round && room.phase === 'ANSWER') {
        broadcastAnswerProgress(io, room);
    }
}

function registerRoomHandlers(io, socket) {
    socket.on('room:create', ({ playerName }) => {
        const result = createRoom(socket, playerName);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
            return;
        }

        socket.emit('room:created', roomSnapshot(result.room, result.isHost));
        broadcastPlayers(io, result.room);
    });

    socket.on('room:join', ({ code, playerName }) => {
        const result = joinRoom(socket, code, playerName);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
            return;
        }

        socket.emit('room:joined', roomSnapshot(result.room, result.isHost));
        broadcastPlayers(io, result.room);
    });

    socket.on('game:start', () => {
        const result = startGame(socket, io);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
            return;
        }
    });

    socket.on('game:submitAnswer', ({ text }) => {
        const result = submitAnswer(socket, io, text);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
            return;
        }
        socket.emit('game:answerAccepted');
    });

    socket.on('disconnect', () => {
        leaveRoom(io, socket);
    });
}

module.exports = { registerRoomHandlers };
