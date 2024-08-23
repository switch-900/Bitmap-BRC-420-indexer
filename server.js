const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');

const app = express();
const PORT = process.env.PORT || 8080;

// Enable CORS
app.use(cors());

// Implement rate limiting
const limiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW, // 15 minutes
    max: config.RATE_LIMIT_MAX_REQUESTS, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
});

app.use(limiter);

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
