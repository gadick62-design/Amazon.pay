const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store (replace with a database later)
const links = new Map();
const logs = [];

function log(level, text) {
  const entry = { time: new Date().toISOString().slice(11, 19), level, text };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
  console.log(`[${entry.time}] ${level}: ${text}`);
}

// Create short link
app.post('/api/links', (req, res) => {
  const payload = req.body;
  if (!payload || !payload.am) {
    return res.status(400).json({ error: 'Missing amount' });
  }
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  links.set(code, { payload, createdAt: Date.now() });
  log('ok', `Link created: ${code} — ${payload.cur} ${payload.am} (${payload.c})`);
  res.json({ code });
});

// Resolve short link
app.get('/api/links/:code', (req, res) => {
  const entry = links.get(req.params.code);
  if (!entry) {
    log('err', `Link not found: ${req.params.code}`);
    return res.status(404).json({ error: 'Link not found' });
  }
  if (entry.payload.exp && Date.now() > entry.payload.exp) {
    log('err', `Link expired: ${req.params.code}`);
    return res.status(410).json({ error: 'Link expired' });
  }
  log('info', `Link accessed: ${req.params.code}`);
  res.json({ payload: entry.payload });
});

// Logs for admin panel
app.get('/api/logs', (req, res) => {
  res.json({ entries: logs });
});

// Shorten (passthrough — full link is already valid)
app.post('/api/shorten', (req, res) => {
  res.json({ shortUrl: req.body.url });
});

// Fallback to admin page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, () => {
  console.log(`Amazon Bank running on port ${PORT}`);
});
