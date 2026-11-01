const crypto = require('crypto');
const { pickRandomRound } = require('./prompts');

const rooms = new Map();

const MAX_NAME_LENGTH = 20;
const MAX_ANSWER_LENGTH = 120;
const MIN_PLAYERS_TO_START = 3;
const DISCONNECT_GRACE_MS = 5 * 60 * 1000;

function createPlayerId() {
    return crypto.randomUUID();
}

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
        id: p.playerId,
        name: p.name,
        isHost: p.isHost,
        connected: p.connected,
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

function discussAnswersPayload(room) {
    const answers = [];
    for (const [playerId] of room.players) {
        const entry = room.round?.answers.get(playerId);
        if (entry) {
            answers.push({
                playerId,
                name: entry.name,
                text: entry.text,
            });
        }
    }
    return answers;
}

function broadcastDiscussAnswers(io, room) {
    io.to(room.code).emit('game:answers', {
        answers: discussAnswersPayload(room),
    });
}

function beginDiscussPhase(io, room) {
    room.phase = 'DISCUSS';
    broadcastDiscussAnswers(io, room);
    broadcastPhase(io, room);
}

function maybeAdvanceToDiscuss(io, room) {
    if (room.phase !== 'ANSWER' || !room.round) return;
    if (room.round.answers.size < room.players.size) return;
    beginDiscussPhase(io, room);
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

function roomSnapshot(room, playerId) {
    const player = room.players.get(playerId);
    return {
        code: room.code,
        phase: room.phase,
        players: playersPayload(room),
        isHost: room.hostPlayerId === playerId,
        sessionToken: playerId,
        minPlayersToStart: MIN_PLAYERS_TO_START,
    };
}

function attachSocketToPlayer(socket, room, player) {
    player.socketId = socket.id;
    player.connected = true;
    if (player.disconnectTimer) {
        clearTimeout(player.disconnectTimer);
        player.disconnectTimer = null;
    }
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.playerId;
}

function sendPromptsToPlayers(io, room) {
    if (!room.round) return;
    for (const player of room.players.values()) {
        if (!player.connected || !player.socketId) continue;
        const isImposter = player.playerId === room.round.imposterPlayerId;
        const question = isImposter ? room.round.imposterQuestion : room.round.realQuestion;
        const playerSocket = io.sockets.sockets.get(player.socketId);
        if (playerSocket) {
            playerSocket.emit('game:yourPrompt', { question });
        }
    }
}

function syncGameStateToPlayer(io, room, playerId) {
    const player = room.players.get(playerId);
    if (!player?.socketId) return;

    const playerSocket = io.sockets.sockets.get(player.socketId);
    if (!playerSocket) return;

    playerSocket.emit('room:restored', roomSnapshot(room, playerId));

    if (room.phase === 'ANSWER' && room.round) {
        playerSocket.emit('game:phase', { code: room.code, phase: room.phase });
        const isImposter = playerId === room.round.imposterPlayerId;
        const question = isImposter ? room.round.imposterQuestion : room.round.realQuestion;
        playerSocket.emit('game:yourPrompt', { question });
        if (room.round.answers.has(playerId)) {
            playerSocket.emit('game:answerAccepted');
        }
        playerSocket.emit('game:answerProgress', {
            submitted: room.round.answers.size,
            total: room.players.size,
            allSubmitted: room.round.answers.size >= room.players.size,
        });
    } else if (room.phase === 'DISCUSS' && room.round) {
        playerSocket.emit('game:answers', { answers: discussAnswersPayload(room) });
        playerSocket.emit('game:phase', { code: room.code, phase: room.phase });
    }
}

function beginRound(io, room) {
    const round = pickRandomRound();
    const playerIds = Array.from(room.players.keys());
    const imposterPlayerId = playerIds[Math.floor(Math.random() * playerIds.length)];

    room.round = {
        roundId: round.id,
        imposterPlayerId,
        realQuestion: round.realQuestion,
        imposterQuestion: round.imposterQuestion,
        answers: new Map(),
    };
    room.phase = 'ANSWER';

    broadcastPhase(io, room);
    sendPromptsToPlayers(io, room);
    broadcastAnswerProgress(io, room);
}

function startGame(socket, io) {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!code || !playerId) {
        return { error: 'אינך בחדר' };
    }

    const room = rooms.get(code);
    if (!room) {
        return { error: 'חדר לא נמצא' };
    }

    if (room.hostPlayerId !== playerId) {
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
    const playerId = socket.data.playerId;
    if (!code || !playerId) {
        return { error: 'אינך בחדר' };
    }

    const room = rooms.get(code);
    if (!room || !room.round) {
        return { error: 'אין סיבוב פעיל' };
    }

    if (room.phase !== 'ANSWER') {
        return { error: 'לא בשלב תשובות' };
    }

    const player = room.players.get(playerId);
    if (!player) {
        return { error: 'שחקן לא נמצא' };
    }

    if (room.round.answers.has(playerId)) {
        return { error: 'כבר שלחת תשובה' };
    }

    const answerText = normalizeAnswer(text);
    if (!answerText) {
        return { error: 'נא להזין תשובה' };
    }

    room.round.answers.set(playerId, {
        name: player.name,
        text: answerText,
    });

    broadcastAnswerProgress(io, room);
    maybeAdvanceToDiscuss(io, room);
    return { ok: true };
}

function createRoom(socket, playerName) {
    const name = normalizeName(playerName);
    if (!name) {
        return { error: 'נא להזין שם תקין' };
    }

    const playerId = createPlayerId();
    const code = generateRoomCode();
    const room = {
        code,
        hostPlayerId: playerId,
        phase: 'LOBBY',
        players: new Map(),
        round: null,
    };

    room.players.set(playerId, {
        playerId,
        name,
        isHost: true,
        socketId: null,
        connected: false,
        disconnectTimer: null,
    });

    rooms.set(code, room);
    attachSocketToPlayer(socket, room, room.players.get(playerId));

    return { room, playerId };
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
        if (player.name.toLowerCase() === name.toLowerCase()) {
            return { error: 'השם כבר תפוס בחדר זה' };
        }
    }

    const playerId = createPlayerId();
    room.players.set(playerId, {
        playerId,
        name,
        isHost: false,
        socketId: null,
        connected: false,
        disconnectTimer: null,
    });

    attachSocketToPlayer(socket, room, room.players.get(playerId));

    return { room, playerId };
}

function rejoinRoom(socket, code, playerName, sessionToken) {
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

    const player = room.players.get(sessionToken);
    if (!player || player.name.toLowerCase() !== name.toLowerCase()) {
        return { error: 'לא ניתן להתחבר מחדש לחדר' };
    }

    attachSocketToPlayer(socket, room, player);
    return { room, playerId: player.playerId };
}

function removePlayerFromRoom(io, room, playerId) {
    const player = room.players.get(playerId);
    if (!player) return;

    if (player.disconnectTimer) {
        clearTimeout(player.disconnectTimer);
        player.disconnectTimer = null;
    }

    room.players.delete(playerId);

    if (room.round?.answers.has(playerId)) {
        room.round.answers.delete(playerId);
    }

    if (room.players.size === 0) {
        rooms.delete(room.code);
        return;
    }

    if (room.hostPlayerId === playerId) {
        const nextHost = room.players.values().next().value;
        if (nextHost) {
            room.hostPlayerId = nextHost.playerId;
            for (const p of room.players.values()) {
                p.isHost = p.playerId === room.hostPlayerId;
            }
        }
    }

    broadcastPlayers(io, room);
    if (room.round && room.phase === 'ANSWER') {
        broadcastAnswerProgress(io, room);
    }
}

function handleDisconnect(io, socket) {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!code || !playerId) return;

    const room = rooms.get(code);
    if (!room) return;

    const player = room.players.get(playerId);
    if (!player) return;

    player.connected = false;
    player.socketId = null;
    delete socket.data.roomCode;
    delete socket.data.playerId;

    player.disconnectTimer = setTimeout(() => {
        const currentRoom = rooms.get(code);
        if (!currentRoom) return;
        const currentPlayer = currentRoom.players.get(playerId);
        if (currentPlayer && !currentPlayer.connected) {
            removePlayerFromRoom(io, currentRoom, playerId);
        }
    }, DISCONNECT_GRACE_MS);

    broadcastPlayers(io, room);
}

function registerRoomHandlers(io, socket) {
    socket.on('room:create', ({ playerName }) => {
        const result = createRoom(socket, playerName);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
            return;
        }

        socket.emit('room:created', roomSnapshot(result.room, result.playerId));
        broadcastPlayers(io, result.room);
    });

    socket.on('room:join', ({ code, playerName }) => {
        const result = joinRoom(socket, code, playerName);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
            return;
        }

        socket.emit('room:joined', roomSnapshot(result.room, result.playerId));
        broadcastPlayers(io, result.room);
    });

    socket.on('room:rejoin', ({ code, playerName, sessionToken }) => {
        const result = rejoinRoom(socket, code, playerName, sessionToken);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
            return;
        }

        syncGameStateToPlayer(io, result.room, result.playerId);
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
        handleDisconnect(io, socket);
    });
}

module.exports = { registerRoomHandlers };
