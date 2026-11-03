const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const promptsPath = path.join(__dirname, '..', 'data', 'prompts.json');

let cachedData = null;

function loadPromptsData() {
    if (cachedData) {
        return cachedData;
    }
    cachedData = JSON.parse(fs.readFileSync(promptsPath, 'utf8'));
    return cachedData;
}

function normalizeImposterRound(entry) {
    return {
        id: entry.id,
        realQuestion: entry.civilian,
        imposterQuestion: entry.imposter,
    };
}

function normalizeWhoSaidQuestion(entry) {
    return {
        id: entry.id,
        realQuestion: entry.text,
    };
}

function roundsForGameType(gameType) {
    const data = loadPromptsData();
    if (gameType === 'whoSaid') {
        const questions = data.whoSaid?.questions;
        if (!Array.isArray(questions) || questions.length === 0) {
            throw new Error('No who-said questions configured');
        }
        return questions.map(normalizeWhoSaidQuestion);
    }

    const rounds = data.imposter?.rounds;
    if (!Array.isArray(rounds) || rounds.length === 0) {
        throw new Error('No imposter rounds configured');
    }
    return rounds.map(normalizeImposterRound);
}

/** @deprecated use roundsForGameType */
function loadRounds() {
    return roundsForGameType('imposter');
}

function pickRandomRound(excludeRoundId = null, gameType = 'imposter') {
    let rounds = roundsForGameType(gameType);
    if (excludeRoundId && rounds.length > 1) {
        const filtered = rounds.filter((r) => r.id !== excludeRoundId);
        if (filtered.length > 0) {
            rounds = filtered;
        }
    }
    const index = crypto.randomInt(0, rounds.length);
    return rounds[index];
}

module.exports = { pickRandomRound, loadRounds, roundsForGameType, loadPromptsData };
