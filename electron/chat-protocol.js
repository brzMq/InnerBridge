const MAX_HISTORY_LIMIT = 200;

function normalizeClientId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null;
}

function messagePreview(message, max = 160) {
  const text = String(message && message.text || '').trim();
  const fallback = message && message.image
    ? '[图片]'
    : message && message.file
      ? `[文件] ${message.file.name || ''}`.trim()
      : '';
  const value = text || fallback;
  return value.length > max ? value.slice(0, max) + '…' : value;
}

/** Build a trusted reply snapshot from an existing server-side message. */
function resolveReply(reply, messages) {
  const id = Number(reply && reply.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const source = (Array.isArray(messages) ? messages : []).find((m) => m.id === id);
  if (!source) return null;
  return {
    id: source.id,
    nick: String(source.nick || '').slice(0, 32),
    text: messagePreview(source),
  };
}

function selectMessages(messages, query = {}) {
  const since = Math.max(0, Number.parseInt(query.since || '0', 10) || 0);
  const requested = Number.parseInt(query.limit || String(MAX_HISTORY_LIMIT), 10);
  const limit = Math.min(MAX_HISTORY_LIMIT, Math.max(1, Number.isFinite(requested) ? requested : MAX_HISTORY_LIMIT));
  const keyword = String(query.q || '').trim().toLocaleLowerCase().slice(0, 100);
  const filtered = (Array.isArray(messages) ? messages : []).filter((m) => {
    if (!m || m.id <= since) return false;
    if (!keyword) return true;
    const haystack = [m.nick, m.text, m.file && m.file.name, m.reply && m.reply.text]
      .filter(Boolean)
      .join('\n')
      .toLocaleLowerCase();
    return haystack.includes(keyword);
  });
  return filtered.slice(-limit);
}

module.exports = {
  MAX_HISTORY_LIMIT,
  messagePreview,
  normalizeClientId,
  resolveReply,
  selectMessages,
};
