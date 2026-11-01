const express = require('express');
const app = express();
const PORT = 3000;

// פקודה שאומרת לשרת: כל הקבצים בתיקיית public (כמו ה-index.html) זמינים לציבור
app.use(express.static('public'));

// הפעלת השרת
app.listen(PORT, () => {
    console.log(`השרת רץ בהצלחה! היכנס לדפדפן בכתובת: http://localhost:${PORT}`);
});