const rooms = new Map();

const MAX_NAME_LENGTH = 20;
const MIN_PLAYERS_TO_START = 3;

function normalizeName(name) {
    return String(name || '').trim().slice(0, MAX_NAME_LENGTH);
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

function roomSnapshot(room, isHost) {
    return {
        code: room.code,
        phase: room.phase,
        players: playersPayload(room),
        isHost,
        minPlayersToStart: MIN_PLAYERS_TO_START,
    };
}

function startGame(socket) {
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

    room.phase = 'STARTING';
    return { room };
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
        const result = startGame(socket);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
            return;
        }
        broadcastPhase(io, result.room);
    });

    socket.on('disconnect', () => {
        leaveRoom(io, socket);
    });
}

module.exports = { registerRoomHandlers };
