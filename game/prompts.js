const fs = require('fs');
const path = require('path');

const promptsPath = path.join(__dirname, '..', 'data', 'prompts.json');
const { rounds } = JSON.parse(fs.readFileSync(promptsPath, 'utf8'));

function pickRandomRound() {
    if (!rounds.length) {
        throw new Error('No prompts configured');
    }
    return rounds[Math.floor(Math.random() * rounds.length)];
}

module.exports = { pickRandomRound };
