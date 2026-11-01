const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const VERSION = '0.2.0';

app.get('/api/health', (req, res) => {
    res.json({ ok: true, version: VERSION });
});

// פקודה שאומרת לשרת: כל הקבצים בתיקיית public (כמו ה-index.html) זמינים לציבור
app.use(express.static('public'));

// הפעלת השרת
app.listen(PORT, () => {
    console.log(`השרת רץ בהצלחה! היכנס לדפדפן בכתובת: http://localhost:${PORT}`);
});