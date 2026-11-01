const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const promptsPath = path.join(__dirname, '..', 'data', 'prompts.json');

function loadRounds() {
    const { rounds } = JSON.parse(fs.readFileSync(promptsPath, 'utf8'));
    if (!Array.isArray(rounds) || rounds.length === 0) {
        throw new Error('No prompts configured');
    }
    return rounds;
}

function pickRandomRound(excludeRoundId = null) {
    let rounds = loadRounds();
    if (excludeRoundId && rounds.length > 1) {
        const filtered = rounds.filter((r) => r.id !== excludeRoundId);
        if (filtered.length > 0) {
            rounds = filtered;
        }
    }
    const index = crypto.randomInt(0, rounds.length);
    return rounds[index];
}

module.exports = { pickRandomRound, loadRounds };
