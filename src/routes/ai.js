const express = require('express');
const router = express.Router();

const AI_PROVIDER = process.env.AI_PROVIDER || 'groq';
const AI_MODEL = process.env.AI_MODEL || 'llama-3.3-70b-versatile';
const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.GROQ_APIKEY || '';

const enabled = () => AI_PROVIDER === 'groq' && typeof GROQ_API_KEY === 'string' && GROQ_API_KEY.trim().length > 0;

router.get('/ping', (_req, res) => {
  res.json({ ok: true, provider: AI_PROVIDER, model: AI_MODEL, enabled: enabled() });
});

router.post('/chat', async (req, res) => {
  try {
    if (!enabled()) return res.status(503).json({ error: 'AI not configured' });

    const messages = Array.isArray(req.body?.messages) && req.body.messages.length
      ? req.body.messages
      : [{ role: 'user', content: String(req.body?.prompt ?? req.body?.q ?? '').trim() }];

    if (!messages[0]?.content) return res.status(400).json({ error: 'prompt or messages required' });

    const payload = {
      model: String(req.body?.model || AI_MODEL),
      messages,
      temperature: Number.isFinite(+req.body?.temperature) ? +req.body.temperature : 0.2,
      max_tokens: Number.isFinite(+req.body?.max_tokens) ? +req.body.max_tokens : 512,
      stream: false,
    };

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const t = await resp.text().catch(()=> '');
      return res.status(502).json({ error: 'Groq API error', status: resp.status, body: t?.slice(0,1000) });
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    res.json({ provider: AI_PROVIDER, model: payload.model, text, raw: data });
  } catch (e) {
    console.error('ai/chat error:', e);
    res.status(500).json({ error: 'AI chat failed' });
  }
});

module.exports = router;