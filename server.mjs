import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 8080;

// Enable CORS
app.use(cors());

// Serve static files from the "public" directory
app.use(express.static('public'));

// Serve the index.html for the root route
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Serve the deploy.html for the deploy details page
app.get('/deploy', (req, res) => {
    res.sendFile(__dirname + '/public/deploy.html');
});

app.listen(PORT, () => {
    console.log(`Frontend server running on http://localhost:${PORT}`);
});
