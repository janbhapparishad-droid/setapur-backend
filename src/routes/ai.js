const express = require('express');
const router = express.Router();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyC-54RvW369kmZWN-vJNomxmohwaFgmNAo';
const enabled = () => typeof GEMINI_API_KEY === 'string' && GEMINI_API_KEY.trim().length > 0;
router.get('/ping', (_req, res) => { res.json({ ok: true, provider: 'gemini', enabled: enabled() }); });
router.post('/chat', async (req, res) => {
  try {
    if (!enabled()) return res.status(503).json({ error: 'AI not configured' });
    let inputMessages = req.body && req.body.messages;
    if (!Array.isArray(inputMessages) || inputMessages.length === 0) {
      inputMessages = [{ role: 'user', content: String(req.body && (req.body.prompt || req.body.q) || '').trim() }];
    }
    if (!inputMessages[0] || !inputMessages[0].content) return res.status(400).json({ error: 'prompt required' });
    const contents = inputMessages.map(m => {
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
    });
    const payload = {
      contents: contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
      }
    };
    if (req.body && req.body.system) {
        payload.systemInstruction = { role: 'system', parts: [{ text: String(req.body.system) }] };
    }
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + GEMINI_API_KEY;
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!resp.ok) { return res.status(502).json({ error: 'Gemini API error', status: resp.status }); }
    const data = await resp.json();
    let text = '';
    if (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0]) {
       text = data.candidates[0].content.parts[0].text;
    }
    if (!text || String(text).trim() === '') { return res.status(502).json({ error: 'Empty AI response from provider' }); }
    res.json({ provider: 'gemini', content: text, text: text, raw: data });
  } catch (e) { res.status(500).json({ error: 'AI chat failed' }); }
});
module.exports = router;
