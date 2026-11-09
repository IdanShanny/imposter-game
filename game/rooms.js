const crypto = require('crypto');
const { pickRandomRound } = require('./prompts');

const rooms = new Map();

const MAX_NAME_LENGTH = 20;
const MAX_ANSWER_LENGTH = 120;
const MIN_PLAYERS_TO_START = 3;
const DISCONNECT_GRACE_MS = 5 * 60 * 1000;

function minPlayersForGameType(gameType) {
    return gameType === 'toDavar' ? 2 : MIN_PLAYERS_TO_START;
}

function normalizeGameType(value) {
    if (value === 'whoSaid' || value === 'toDavar') {
        return value;
    }
    return 'imposter';
}

function rosterRoundKey(room) {
    return `${rosterKey(room)}|${room.gameType || 'imposter'}`;
}

function shufflePlayerIds(playerIds) {
    const list = [...playerIds];
    for (let i = list.length - 1; i > 0; i -= 1) {
        const j = crypto.randomInt(0, i + 1);
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

/** Same player names in a new room — avoid repeating last round / imposter */
const lastRoundIdByRoster = new Map();
const lastImposterNameByRoster = new Map();

function rosterKey(room) {
    return Array.from(room.players.values())
        .map((p) => p.name.toLowerCase())
        .sort()
        .join('|');
}

function createPlayerId() {
    return crypto.randomUUID();
}

function normalizeName(name) {
    return String(name || '').trim().slice(0, MAX_NAME_LENGTH);
}

function normalizeAnswer(text) {
    return String(text || '').trim().slice(0, MAX_ANSWER_LENGTH);
}

function normalizeToDavarWord(text) {
    const normalized = normalizeAnswer(text)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase('he');
    if (normalized.length > 4 && normalized.endsWith('ים')) {
        return normalized.slice(0, -2);
    }
    return normalized;
}

function isSingleWord(text) {
    return normalizeAnswer(text).split(/\s+/).filter(Boolean).length === 1;
}

/** Compare answers for "who said?" duplicate matching */
function normalizeAnswerForCompare(text) {
    return String(text || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function whoSaidCorrectTargetIds(room, authorId) {
    const entry = room.round?.answers.get(authorId);
    if (!entry) {
        return new Set(authorId ? [authorId] : []);
    }
    const key = normalizeAnswerForCompare(entry.text);
    const ids = new Set();
    for (const [playerId, answerEntry] of room.round.answers) {
        if (normalizeAnswerForCompare(answerEntry.text) === key) {
            ids.add(playerId);
        }
    }
    return ids;
}

function isWhoSaidGuessCorrect(room, authorId, targetId) {
    return whoSaidCorrectTargetIds(room, authorId).has(targetId);
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
        minPlayersToStart: minPlayersForGameType(room.gameType),
    });
}

function phasePayload(room) {
    return {
        code: room.code,
        phase: room.phase,
        gameType: room.gameType || 'imposter',
        roundId: room.round?.roundId ?? null,
    };
}

function broadcastPhase(io, room) {
    io.to(room.code).emit('game:phase', phasePayload(room));
}

function questionForPlayer(room, playerId) {
    if (!room.round) {
        return null;
    }
    if (room.gameType === 'whoSaid') {
        return room.round.realQuestion;
    }
    const isImposter = playerId === room.round.imposterPlayerId;
    return isImposter ? room.round.imposterQuestion : room.round.realQuestion;
}

function emitPromptToPlayer(io, room, playerId) {
    if (room.phase !== 'ANSWER' || !room.round) {
        return false;
    }
    const player = room.players.get(playerId);
    if (!player?.socketId) {
        return false;
    }
    const playerSocket = io.sockets.sockets.get(player.socketId);
    if (!playerSocket) {
        return false;
    }
    const question = questionForPlayer(room, playerId);
    if (!question) {
        return false;
    }
    const isImposter =
        room.gameType === 'imposter' &&
        playerId === room.round.imposterPlayerId;
    playerSocket.emit('game:yourPrompt', {
        question,
        roundId: room.round.roundId,
        isImposter,
    });
    return true;
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
    if (room.round) {
        room.round.votes = new Map();
    }
    broadcastDiscussAnswers(io, room);
    broadcastVoteProgress(io, room);
    broadcastPhase(io, room);
}

function currentWhoSaidAuthorId(room) {
    return room.round?.guessOrder?.[room.round.guessIndex] ?? null;
}

function whoSaidExpectedGuessCount(room) {
    const authorId = currentWhoSaidAuthorId(room);
    let count = 0;
    for (const player of room.players.values()) {
        if (player.playerId === authorId) {
            continue;
        }
        if (!player.connected) {
            continue;
        }
        count += 1;
    }
    return count;
}

function toDavarExpectedSubmissionCount(room) {
    return room.players.size;
}

function whoSaidRevealPayload(room) {
    const scores = new Map(room.round.guessScores || []);
    for (const playerId of room.players.keys()) {
        if (!scores.has(playerId)) {
            scores.set(playerId, 0);
        }
    }
    let maxScore = 0;
    for (const score of scores.values()) {
        if (score > maxScore) {
            maxScore = score;
        }
    }
    const winners = [];
    for (const [playerId, score] of scores) {
        if (score === maxScore) {
            winners.push({
                playerId,
                name: room.players.get(playerId)?.name || '—',
                score,
            });
        }
    }

    const tallies = voteTargetsPayload(room).map((p) => ({
        playerId: p.playerId,
        name: p.name,
        answer: room.round.answers.get(p.playerId)?.text || '',
        timesCorrectlyGuessed: room.round.timesIdentified?.get(p.playerId) || 0,
        correctGuesses: scores.get(p.playerId) || 0,
    }));

    return {
        gameType: 'whoSaid',
        winners,
        maxScore,
        tallies,
        realQuestion: room.round.realQuestion,
    };
}

function buildYourPreviousGuessFeedback(room, viewerPlayerId) {
    const authorId = room.round.lastResultAuthorId;
    if (!authorId || !room.round.lastResultGuesses) {
        return null;
    }
    if (viewerPlayerId === authorId) {
        return null;
    }
    const correctTargets = whoSaidCorrectTargetIds(room, authorId);
    for (const [guesserId, targetId] of room.round.lastResultGuesses) {
        if (guesserId !== viewerPlayerId) {
            continue;
        }
        return {
            correct: correctTargets.has(targetId),
            authorName: room.players.get(authorId)?.name || '—',
        };
    }
    return null;
}

function buildWhoSaidLastResult(room) {
    const authorId = room.round.lastResultAuthorId;
    if (!authorId) {
        return null;
    }
    const authorName = room.players.get(authorId)?.name || '—';
    const answerText = room.round.answers.get(authorId)?.text || '';
    const correctTargets = whoSaidCorrectTargetIds(room, authorId);
    const guessRows = [];
    for (const [guesserId, targetId] of room.round.lastResultGuesses || []) {
        guessRows.push({
            guesserName: room.players.get(guesserId)?.name || '—',
            guessedName: room.players.get(targetId)?.name || '—',
            correct: correctTargets.has(targetId),
        });
    }
    return { answerText, authorName, guesses: guessRows };
}

function buildWhoSaidStepPayload(room, viewerPlayerId) {
    const authorId = currentWhoSaidAuthorId(room);
    const answerEntry = authorId ? room.round.answers.get(authorId) : null;
    const lastRoundResult = buildWhoSaidLastResult(room);
    const stepTotal = room.round.guessOrder.length;
    const stepIndex = room.round.guessIndex + 1;

    return {
        stepIndex,
        stepTotal,
        guessIndex: room.round.guessIndex,
        gameType: 'whoSaid',
        answerText: answerEntry?.text || '',
        lastRoundResult,
        yourPreviousGuess: buildYourPreviousGuessFeedback(room, viewerPlayerId),
        players: playersPayload(room),
        guessProgress: {
            submitted: room.round.currentGuesses.size,
            total: whoSaidExpectedGuessCount(room),
        },
        isAuthor: viewerPlayerId === authorId,
    };
}

function emitWhoSaidStepToPlayer(io, room, playerId) {
    const player = room.players.get(playerId);
    if (!player?.socketId) {
        return false;
    }
    const playerSocket = io.sockets.sockets.get(player.socketId);
    if (!playerSocket) {
        return false;
    }
    playerSocket.emit('game:whoSaidStep', buildWhoSaidStepPayload(room, playerId));
    return true;
}

function broadcastWhoSaidStep(io, room) {
    for (const player of room.players.values()) {
        emitWhoSaidStepToPlayer(io, room, player.playerId);
    }
    broadcastWhoSaidGuessProgress(io, room);
}

function broadcastWhoSaidGuessProgress(io, room) {
    io.to(room.code).emit('game:voteProgress', {
        gameType: 'whoSaid',
        submitted: room.round.currentGuesses.size,
        total: whoSaidExpectedGuessCount(room),
    });
}

function completeWhoSaidStep(io, room) {
    const authorId = currentWhoSaidAuthorId(room);
    room.round.lastResultAuthorId = authorId;
    room.round.lastResultGuesses = Array.from(room.round.currentGuesses.entries());
    const correctTargets = whoSaidCorrectTargetIds(room, authorId);

    for (const [guesserId, targetId] of room.round.currentGuesses) {
        if (!correctTargets.has(targetId)) {
            continue;
        }
        const prev = room.round.guessScores.get(guesserId) || 0;
        room.round.guessScores.set(guesserId, prev + 1);
        for (const playerId of correctTargets) {
            const identified = room.round.timesIdentified.get(playerId) || 0;
            room.round.timesIdentified.set(playerId, identified + 1);
        }
    }

    room.round.guessIndex += 1;
    room.round.currentGuesses = new Map();

    if (room.round.guessIndex >= room.round.guessOrder.length) {
        beginRevealPhase(io, room);
        return;
    }

    broadcastWhoSaidStep(io, room);
}

function beginWhoSaidGuessPhase(io, room) {
    room.phase = 'DISCUSS';
    const playerIds = Array.from(room.players.keys());
    room.round.guessOrder = shufflePlayerIds(playerIds);
    room.round.guessIndex = 0;
    room.round.guessScores = new Map();
    room.round.timesIdentified = new Map();
    room.round.currentGuesses = new Map();
    room.round.lastResultAuthorId = null;
    room.round.lastResultGuesses = null;
    for (const id of playerIds) {
        room.round.guessScores.set(id, 0);
        room.round.timesIdentified.set(id, 0);
    }
    broadcastWhoSaidStep(io, room);
    broadcastPhase(io, room);
}

function submitWhoSaidGuess(socket, io, targetPlayerId) {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!code || !playerId) {
        return { error: 'אינך בחדר' };
    }

    const room = rooms.get(code);
    if (!room?.round || room.gameType !== 'whoSaid') {
        return { error: 'אין סיבוב פעיל' };
    }

    if (room.phase !== 'DISCUSS') {
        return { error: 'לא בשלב ניחושים' };
    }

    const authorId = currentWhoSaidAuthorId(room);
    if (!authorId) {
        return { error: 'אין תשובה פעילה' };
    }

    if (playerId === authorId) {
        return { error: 'לא ניתן לנחש על התשובה שלך' };
    }

    if (targetPlayerId === playerId) {
        return { error: 'לא ניתן לנחש את עצמך' };
    }

    if (!room.players.has(targetPlayerId)) {
        return { error: 'שחקן לא תקין' };
    }

    if (room.round.currentGuesses.has(playerId)) {
        return { error: 'כבר שלחת ניחוש' };
    }

    room.round.currentGuesses.set(playerId, targetPlayerId);
    broadcastWhoSaidGuessProgress(io, room);

    const expected = whoSaidExpectedGuessCount(room);
    const stepComplete =
        expected === 0 ||
        room.round.currentGuesses.size >= expected;
    if (stepComplete) {
        completeWhoSaidStep(io, room);
    }

    return { ok: true, stepComplete };
}

function voteTargetsPayload(room) {
    return Array.from(room.players.values()).map((p) => ({
        playerId: p.playerId,
        name: p.name,
    }));
}

function broadcastVoteProgress(io, room) {
    io.to(room.code).emit('game:voteProgress', {
        submitted: room.round.votes.size,
        total: room.players.size,
    });
}

function revealPayload(room) {
    if (room.gameType === 'toDavar') {
        return toDavarRevealPayload(room);
    }
    if (room.gameType === 'whoSaid') {
        return whoSaidRevealPayload(room);
    }

    const imposter = room.players.get(room.round.imposterPlayerId);
    const voteCounts = new Map();
    for (const targetId of room.round.votes.values()) {
        voteCounts.set(targetId, (voteCounts.get(targetId) || 0) + 1);
    }

    const tallies = voteTargetsPayload(room)
        .map((p) => {
            const answerEntry = room.round.answers.get(p.playerId);
            const votedForId = room.round.votes.get(p.playerId);
            const votedForName = votedForId
                ? room.players.get(votedForId)?.name || '—'
                : null;
            return {
                playerId: p.playerId,
                name: p.name,
                answer: answerEntry?.text || '',
                votes: voteCounts.get(p.playerId) || 0,
                isImposter: p.playerId === room.round.imposterPlayerId,
                votedForName,
            };
        })
        .sort((a, b) => b.votes - a.votes);

    const imposterVoteCount = voteCounts.get(room.round.imposterPlayerId) || 0;
    let topVotes = 0;
    for (const count of voteCounts.values()) {
        if (count > topVotes) topVotes = count;
    }
    const civiliansWin = imposterVoteCount > 0 && imposterVoteCount === topVotes;

    return {
        gameType: 'imposter',
        imposters: imposter
            ? [{ playerId: imposter.playerId, name: imposter.name }]
            : [],
        tallies,
        civiliansWin,
        realQuestion: room.round.realQuestion,
        imposterQuestion: room.round.imposterQuestion,
    };
}

function broadcastReveal(io, room) {
    io.to(room.code).emit('game:reveal', revealPayload(room));
}

function broadcastPlayAgainProgress(io, room) {
    const total = room.rematchRosterSize ?? room.players.size;
    io.to(room.code).emit('game:playAgainProgress', {
        interested: room.playAgainReady.size,
        total,
    });
}

function canStartRematch(room) {
    if (room.phase !== 'REVEAL' || !room.rematchRosterSize) {
        return false;
    }
    if (room.players.size !== room.rematchRosterSize) {
        return false;
    }
    if (room.playAgainReady.size !== room.players.size) {
        return false;
    }
    for (const playerId of room.players.keys()) {
        if (!room.playAgainReady.has(playerId)) {
            return false;
        }
    }
    return true;
}

function disbandRoom(io, room, message) {
    const code = room.code;
    for (const player of room.players.values()) {
        if (player.disconnectTimer) {
            clearTimeout(player.disconnectTimer);
            player.disconnectTimer = null;
        }
        if (!player.socketId) continue;
        const playerSocket = io.sockets.sockets.get(player.socketId);
        if (!playerSocket) continue;
        playerSocket.emit('room:disbanded', { message });
        delete playerSocket.data.roomCode;
        delete playerSocket.data.playerId;
        playerSocket.leave(code);
    }
    rooms.delete(code);
}

function beginRevealPhase(io, room) {
    if (room.gameType === 'toDavar') {
        beginToDavarReveal(io, room);
        return;
    }
    room.phase = 'REVEAL';
    room.playAgainReady = new Set();
    room.rematchRosterSize = room.players.size;
    broadcastReveal(io, room);
    broadcastPhase(io, room);
    broadcastPlayAgainProgress(io, room);
}

function maybeAdvanceToReveal(io, room) {
    if (room.phase !== 'DISCUSS' || !room.round) return;
    if (room.round.votes.size < room.players.size) return;
    beginRevealPhase(io, room);
}

function submitVote(socket, io, targetPlayerId) {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!code || !playerId) {
        return { error: 'אינך בחדר' };
    }

    const room = rooms.get(code);
    if (!room?.round) {
        return { error: 'אין סיבוב פעיל' };
    }

    ensurePlayerSocketLinked(socket, room);

    if (room.gameType === 'whoSaid') {
        return submitWhoSaidGuess(socket, io, targetPlayerId);
    }

    if (room.phase !== 'DISCUSS') {
        return { error: 'לא בשלב דיון והצבעה' };
    }

    if (targetPlayerId === playerId) {
        return { error: 'לא ניתן להצביע על עצמך' };
    }

    if (!room.players.has(targetPlayerId)) {
        return { error: 'שחקן לא תקין' };
    }

    if (room.round.votes.has(playerId)) {
        return { error: 'כבר הצבעת' };
    }

    room.round.votes.set(playerId, targetPlayerId);
    broadcastVoteProgress(io, room);
    maybeAdvanceToReveal(io, room);
    return { ok: true };
}

function requestPlayAgain(socket, io) {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!code || !playerId) {
        return { error: 'אינך בחדר' };
    }

    const room = rooms.get(code);
    if (!room?.round) {
        return { error: 'אין סיבוב פעיל' };
    }

    ensurePlayerSocketLinked(socket, room);

    if (room.phase !== 'REVEAL') {
        return { error: 'ניתן לבקש רק אחרי סיום הסיבוב' };
    }

    if (room.gameType === 'toDavar') {
        beginRound(io, room);
        return { ok: true };
    }

    if (!room.playAgainReady) {
        room.playAgainReady = new Set();
    }

    room.playAgainReady.add(playerId);
    broadcastPlayAgainProgress(io, room);

    if (canStartRematch(room)) {
        room.playAgainReady.clear();
        room.rematchRosterSize = null;
        beginRound(io, room);
    }

    return { ok: true };
}

function maybeAdvanceToDiscuss(io, room) {
    if (room.phase !== 'ANSWER' || !room.round) return;
    if (room.round.answers.size < room.players.size) return;
    if (room.gameType === 'toDavar') {
        beginToDavarReveal(io, room);
    } else if (room.gameType === 'whoSaid') {
        beginWhoSaidGuessPhase(io, room);
    } else {
        beginDiscussPhase(io, room);
    }
}

function answerProgressPayload(room) {
    const total = room.gameType === 'toDavar'
        ? toDavarExpectedSubmissionCount(room)
        : room.players.size;
    const submitted = room.round ? room.round.answers.size : 0;
    return {
        submitted,
        total,
        allSubmitted: submitted >= total,
    };
}

function broadcastAnswerProgress(io, room) {
    io.to(room.code).emit('game:answerProgress', answerProgressPayload(room));
}

function broadcastToDavarUsedWords(io, room, socket = null) {
    const payload = {
        usedWords: Array.from(room.toDavarUsedWords?.values() || []),
        roundNumber: room.toDavarRoundNumber || 1,
    };
    if (socket) {
        socket.emit('to-davar:used-words', payload);
    } else {
        io.to(room.code).emit('to-davar:used-words', payload);
    }
}

function toDavarRevealPayload(room) {
    const answers = Array.from(room.round.answers.entries()).map(([playerId, entry]) => ({
        playerId,
        name: entry.name,
        word: entry.text,
    }));
    const normalizedWords = new Set(
        answers.map((answer) => normalizeToDavarWord(answer.word)),
    );
    const matched =
        answers.length >= toDavarExpectedSubmissionCount(room) &&
        normalizedWords.size === 1;
    return {
        gameType: 'toDavar',
        roundNumber: room.toDavarRoundNumber,
        matched,
        words: answers,
        usedWords: Array.from(room.toDavarUsedWords?.values() || []),
        playerCount: answers.length,
    };
}

function beginToDavarReveal(io, room) {
    room.phase = 'REVEAL';
    room.playAgainReady = new Set();
    room.rematchRosterSize = room.players.size;
    for (const entry of room.round.answers.values()) {
        const normalized = normalizeToDavarWord(entry.text);
        if (!room.toDavarUsedWords.has(normalized)) {
            room.toDavarUsedWords.set(normalized, entry.text);
        }
    }
    const payload = toDavarRevealPayload(room);
    room.toDavarLastMatched = payload.matched;
    broadcastReveal(io, room);
    broadcastPhase(io, room);
    if (!payload.matched) {
        room.toDavarNextRoundTimer = setTimeout(() => {
            if (rooms.get(room.code) === room && room.phase === 'REVEAL') {
                beginRound(io, room);
            }
        }, 5000);
    }
}

function roomSnapshot(room, playerId) {
    const player = room.players.get(playerId);
    return {
        code: room.code,
        phase: room.phase,
        gameType: room.gameType || 'imposter',
        players: playersPayload(room),
        isHost: room.hostPlayerId === playerId,
        sessionToken: playerId,
        minPlayersToStart: minPlayersForGameType(room.gameType),
        roundId: room.round?.roundId ?? null,
        toDavarUsedWords: room.gameType === 'toDavar'
            ? Array.from(room.toDavarUsedWords?.values() || [])
            : [],
        toDavarRoundNumber: room.toDavarRoundNumber || null,
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
    if (!room.round) {
        return;
    }
    for (const playerId of room.players.keys()) {
        emitPromptToPlayer(io, room, playerId);
    }
}

function resyncWhoSaidStepToPlayer(socket, io) {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!code || !playerId) {
        return { error: 'אינך בחדר' };
    }
    const room = rooms.get(code);
    if (!room || room.phase !== 'DISCUSS' || room.gameType !== 'whoSaid' || !room.round) {
        return { ok: true };
    }
    ensurePlayerSocketLinked(socket, room);
    emitWhoSaidStepToPlayer(io, room, playerId);
    if (room.round.currentGuesses.has(playerId)) {
        socket.emit('game:voteAccepted', {
            guessIndex: room.round.guessIndex,
        });
    }
    return { ok: true };
}

function ensurePlayerSocketLinked(socket, room) {
    const playerId = socket.data.playerId;
    if (!playerId) {
        return;
    }
    const player = room.players.get(playerId);
    if (!player) {
        return;
    }
    if (player.socketId !== socket.id) {
        attachSocketToPlayer(socket, room, player);
        return;
    }
    if (!player.connected) {
        player.connected = true;
    }
}

function resyncStateToPlayer(socket, io) {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!code || !playerId) {
        return { ok: true };
    }
    const room = rooms.get(code);
    if (!room) {
        return { ok: true };
    }
    ensurePlayerSocketLinked(socket, room);
    const player = room.players.get(playerId);
    const playerSocket = player?.socketId
        ? io.sockets.sockets.get(player.socketId)
        : null;
    if (playerSocket) {
        playerSocket.emit('game:phase', phasePayload(room));
    }
    resyncEventsToPlayer(io, room, playerId);
    return { ok: true };
}

function resyncPromptToPlayer(socket, io) {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!code || !playerId) {
        return { error: 'אינך בחדר' };
    }
    const room = rooms.get(code);
    if (!room || room.phase !== 'ANSWER' || !room.round) {
        return { ok: true };
    }
    ensurePlayerSocketLinked(socket, room);
    emitPromptToPlayer(io, room, playerId);
    return { ok: true };
}

function resyncEventsToPlayer(io, room, playerId) {
    const player = room.players.get(playerId);
    if (!player?.socketId) {
        return;
    }
    const playerSocket = io.sockets.sockets.get(player.socketId);
    if (!playerSocket) {
        return;
    }

    if (room.phase === 'ANSWER' && room.round) {
        if (room.gameType === 'toDavar') {
            broadcastToDavarUsedWords(io, room, playerSocket);
        } else {
            emitPromptToPlayer(io, room, playerId);
        }
        if (room.round.answers.has(playerId)) {
            playerSocket.emit('game:answerAccepted');
        }
        playerSocket.emit('game:answerProgress', answerProgressPayload(room));
    } else if (room.phase === 'DISCUSS' && room.round) {
        if (room.gameType === 'whoSaid') {
            emitWhoSaidStepToPlayer(io, room, playerId);
            if (room.round.currentGuesses.has(playerId)) {
                playerSocket.emit('game:voteAccepted', {
                    guessIndex: room.round.guessIndex,
                });
            }
        } else if (room.gameType === 'imposter') {
            playerSocket.emit('game:answers', { answers: discussAnswersPayload(room) });
            playerSocket.emit('game:voteProgress', {
                submitted: room.round.votes.size,
                total: room.players.size,
            });
            if (room.round.votes.has(playerId)) {
                playerSocket.emit('game:voteAccepted');
            }
        }
    } else if (room.phase === 'REVEAL' && room.round) {
        playerSocket.emit('game:reveal', revealPayload(room));
        playerSocket.emit('game:playAgainProgress', {
            interested: room.playAgainReady?.size || 0,
            total: room.rematchRosterSize ?? room.players.size,
        });
        if (room.playAgainReady?.has(playerId)) {
            playerSocket.emit('game:playAgainAccepted');
        }
    }
}

function syncGameStateToPlayer(io, room, playerId) {
    const player = room.players.get(playerId);
    if (!player?.socketId) return;

    const playerSocket = io.sockets.sockets.get(player.socketId);
    if (!playerSocket) return;

    playerSocket.emit('room:restored', roomSnapshot(room, playerId));
    resyncEventsToPlayer(io, room, playerId);
}

function pickImposterPlayerId(room, playerIds) {
    const key = rosterKey(room);
    const lastImposterName = lastImposterNameByRoster.get(key);
    let candidates = playerIds;

    if (lastImposterName && playerIds.length > 1) {
        const filtered = playerIds.filter(
            (id) => room.players.get(id).name.toLowerCase() !== lastImposterName
        );
        if (filtered.length > 0) {
            candidates = filtered;
        }
    }

    if (room.lastImposterPlayerId && playerIds.length > 1) {
        const filtered = candidates.filter((id) => id !== room.lastImposterPlayerId);
        if (filtered.length > 0) {
            candidates = filtered;
        }
    }

    const chosenId = candidates[crypto.randomInt(0, candidates.length)];
    const chosenName = room.players.get(chosenId)?.name;
    if (chosenName) {
        lastImposterNameByRoster.set(key, chosenName.toLowerCase());
    }
    return chosenId;
}

function beginRound(io, room) {
    const gameType = room.gameType || 'imposter';
    if (room.toDavarNextRoundTimer) {
        clearTimeout(room.toDavarNextRoundTimer);
        room.toDavarNextRoundTimer = null;
    }
    if (gameType === 'toDavar') {
        room.toDavarRoundNumber = (room.toDavarRoundNumber || 0) + 1;
        room.round = {
            roundId: `td-${room.toDavarRoundNumber}-${crypto.randomUUID()}`,
            answers: new Map(),
        };
        room.phase = 'ANSWER';
        broadcastPhase(io, room);
        broadcastToDavarUsedWords(io, room);
        broadcastAnswerProgress(io, room);
        return;
    }
    const roundKey = rosterRoundKey(room);
    const round = pickRandomRound(lastRoundIdByRoster.get(roundKey), gameType);
    lastRoundIdByRoster.set(roundKey, round.id);

    room.lastRoundId = round.id;
    room.playAgainReady = new Set();
    room.rematchRosterSize = null;

    if (gameType === 'whoSaid') {
        room.lastImposterPlayerId = null;
        room.round = {
            roundId: round.id,
            realQuestion: round.realQuestion,
            answers: new Map(),
        };
    } else {
        const playerIds = Array.from(room.players.keys());
        const imposterPlayerId = pickImposterPlayerId(room, playerIds);
        room.lastImposterPlayerId = imposterPlayerId;
        room.round = {
            roundId: round.id,
            imposterPlayerId,
            realQuestion: round.realQuestion,
            imposterQuestion: round.imposterQuestion,
            answers: new Map(),
            votes: new Map(),
        };
    }
    room.phase = 'ANSWER';

    sendPromptsToPlayers(io, room);
    broadcastPhase(io, room);
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

    ensurePlayerSocketLinked(socket, room);

    if (room.hostPlayerId !== playerId) {
        return { error: 'רק המארח יכול להתחיל את המשחק' };
    }

    if (room.phase !== 'LOBBY') {
        return { error: 'המשחק כבר התחיל' };
    }

    const minPlayers = minPlayersForGameType(room.gameType);
    if (room.players.size < minPlayers) {
        return { error: `נדרשים לפחות ${minPlayers} שחקנים` };
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

    ensurePlayerSocketLinked(socket, room);

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

    if (room.gameType === 'toDavar') {
        if (!isSingleWord(answerText)) {
            return { error: 'במשחק תו׳דבר יש להזין מילה אחת בלבד' };
        }
        const normalizedWord = normalizeToDavarWord(answerText);
        if (room.toDavarUsedWords.has(normalizedWord)) {
            return { error: 'המילה הזו כבר הייתה במשחק — נא לבחור מילה אחרת' };
        }
    }

    room.round.answers.set(playerId, {
        name: player.name,
        text: answerText,
    });

    broadcastAnswerProgress(io, room);
    maybeAdvanceToDiscuss(io, room);
    return { ok: true };
}

function createRoom(socket, playerName, gameType) {
    const name = normalizeName(playerName);
    if (!name) {
        return { error: 'נא להזין שם תקין' };
    }

    const playerId = createPlayerId();
    const code = generateRoomCode();
    const room = {
        code,
        hostPlayerId: playerId,
        gameType: normalizeGameType(gameType),
        phase: 'LOBBY',
        players: new Map(),
        round: null,
        lastRoundId: null,
        lastImposterPlayerId: null,
        playAgainReady: new Set(),
        rematchRosterSize: null,
        toDavarUsedWords: new Map(),
        toDavarRoundNumber: 0,
        toDavarNextRoundTimer: null,
        toDavarLastMatched: false,
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

    if (room.round?.votes?.has(playerId)) {
        room.round.votes.delete(playerId);
    }

    if (room.round?.currentGuesses?.has(playerId)) {
        room.round.currentGuesses.delete(playerId);
    }

    if (room.playAgainReady?.has(playerId)) {
        room.playAgainReady.delete(playerId);
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
        maybeAdvanceToDiscuss(io, room);
    }
    if (room.round && room.phase === 'DISCUSS') {
        if (room.gameType === 'whoSaid') {
            broadcastWhoSaidGuessProgress(io, room);
            if (
                room.round.currentGuesses.size >= whoSaidExpectedGuessCount(room)
            ) {
                completeWhoSaidStep(io, room);
            }
        } else {
            broadcastVoteProgress(io, room);
            maybeAdvanceToReveal(io, room);
        }
        return;
    }
    if (room.phase === 'REVEAL') {
        if (
            room.rematchRosterSize != null &&
            room.players.size < room.rematchRosterSize
        ) {
            disbandRoom(
                io,
                room,
                'לא כולם בחרו במשחק נוסף — חוזרים למסך הפתיחה',
            );
            return;
        }
        broadcastPlayAgainProgress(io, room);
    }
}

function leaveRoomVoluntary(io, socket) {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!code || !playerId) {
        return { ok: true };
    }

    const room = rooms.get(code);
    const player = room?.players.get(playerId);
    if (player?.disconnectTimer) {
        clearTimeout(player.disconnectTimer);
        player.disconnectTimer = null;
    }

    delete socket.data.roomCode;
    delete socket.data.playerId;
    socket.leave(code);

    if (room) {
        removePlayerFromRoom(io, room, playerId);
    }

    return { ok: true };
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

function safeSocketHandler(label, fn) {
    return (...args) => {
        try {
            fn(...args);
        } catch (err) {
            console.error(`Socket handler error (${label}):`, err);
        }
    };
}

function registerRoomHandlers(io, socket) {
    socket.on('room:create', safeSocketHandler('room:create', ({ playerName, gameType }) => {
        leaveRoomVoluntary(io, socket);
        const result = createRoom(socket, playerName, gameType);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
            return;
        }

        socket.emit('room:created', roomSnapshot(result.room, result.playerId));
        broadcastPlayers(io, result.room);
    }));

    socket.on('room:join', safeSocketHandler('room:join', ({ code, playerName }) => {
        leaveRoomVoluntary(io, socket);
        const result = joinRoom(socket, code, playerName);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
            return;
        }

        socket.emit('room:joined', roomSnapshot(result.room, result.playerId));
        broadcastPlayers(io, result.room);
    }));

    socket.on('room:rejoin', safeSocketHandler('room:rejoin', ({ code, playerName, sessionToken }) => {
        const result = rejoinRoom(socket, code, playerName, sessionToken);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
            return;
        }

        syncGameStateToPlayer(io, result.room, result.playerId);
        broadcastPlayers(io, result.room);
    }));

    socket.on('game:start', safeSocketHandler('game:start', () => {
        const result = startGame(socket, io);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
            return;
        }
    }));

    socket.on('game:submitAnswer', safeSocketHandler('game:submitAnswer', ({ text }) => {
        const result = submitAnswer(socket, io, text);
        if (result.error) {
            socket.emit('game:answerRejected', { message: result.error });
            return;
        }
        socket.emit('game:answerAccepted');
    }));

    socket.on('game:requestPrompt', safeSocketHandler('game:requestPrompt', () => {
        const result = resyncPromptToPlayer(socket, io);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
        }
    }));

    socket.on('game:requestWhoSaidStep', safeSocketHandler('game:requestWhoSaidStep', () => {
        const code = socket.data.roomCode;
        const room = code ? rooms.get(code) : null;
        if (room) {
            ensurePlayerSocketLinked(socket, room);
        }
        const result = resyncWhoSaidStepToPlayer(socket, io);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
        }
    }));

    socket.on('game:requestStateSync', safeSocketHandler('game:requestStateSync', () => {
        const result = resyncStateToPlayer(socket, io);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
        }
    }));

    socket.on('game:requestPlayAgain', safeSocketHandler('game:requestPlayAgain', () => {
        const result = requestPlayAgain(socket, io);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
            return;
        }
        socket.emit('game:playAgainAccepted');
    }));

    socket.on('game:submitVote', safeSocketHandler('game:submitVote', ({ targetPlayerId }) => {
        const result = submitVote(socket, io, targetPlayerId);
        if (result.error) {
            socket.emit('room:error', { message: result.error });
            return;
        }
        if (result.stepComplete) {
            return;
        }
        socket.emit('game:voteAccepted', {
            guessIndex: rooms.get(socket.data.roomCode)?.round?.guessIndex,
        });
    }));

    socket.on('room:leave', safeSocketHandler('room:leave', () => {
        leaveRoomVoluntary(io, socket);
    }));

    socket.on('disconnect', safeSocketHandler('disconnect', () => {
        handleDisconnect(io, socket);
    }));
}

module.exports = { registerRoomHandlers };
