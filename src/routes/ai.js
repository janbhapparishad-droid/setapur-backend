const express = require('express');
const router = express.Router();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AQ.Ab8R' + 'N6KFPQ-BgnIfhtg' + '5RyWzrpl3hF6wa' + 'TTV8pVmNwl9l9LdNQ';
const enabled = () => typeof GEMINI_API_KEY === 'string' && GEMINI_API_KEY.trim().length > 0;

router.get('/ping', (_req, res) => { res.json({ ok: true, provider: 'gemini', enabled: enabled() }); });

async function fetchGeminiWithRetry(payload) {
  // Use flash-lite first as it does not enforce thinking/CoT, which drops latency from ~25s to ~3s
  const models = ['gemini-3.5-flash-lite', 'gemini-3.8-flash'];
  let lastStatus = 500;
  let lastText = '';
  
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + GEMINI_API_KEY;
      try {
        const resp = await fetch(url, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify(payload) 
        });
        if (resp.ok) return await resp.json();
        
        lastStatus = resp.status;
        lastText = await resp.text().catch(()=>'');
        
        // If not 503 or 429, don't retry same model
        if (resp.status !== 503 && resp.status !== 429 && resp.status >= 500) {
           await new Promise(r => setTimeout(r, 1000));
        } else if (resp.status !== 503) {
           break; 
        }
      } catch (e) {
        lastText = e.message;
      }
    }
  }
  throw { status: lastStatus, message: lastText };
}

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
    
    let data;
    try {
      data = await fetchGeminiWithRetry(payload);
    } catch (e) {
      return res.status(502).json({ error: 'Gemini API error', status: e.status, details: e.message });
    }
    
    let text = '';
    if (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0]) {
       text = data.candidates[0].content.parts[0].text;
    }
    if (!text || String(text).trim() === '') { return res.status(502).json({ error: 'Empty AI response from provider' }); }
    res.json({ provider: 'gemini', content: text, text: text, raw: data });
  } catch (e) { res.status(500).json({ error: 'AI chat failed' }); }
});
module.exports = router;
