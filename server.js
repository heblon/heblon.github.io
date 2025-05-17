const express = require('express');
const path = require('path');
const app = express();
const port = 8080; // You can change this port if needed

// Middleware to set COOP and COEP headers for all responses
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

// Serve static files (like index.html, main.js) from the current directory
app.use(express.static(path.join(__dirname)));

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
  console.log('Serving with COOP: same-origin and COEP: require-corp headers.');
});