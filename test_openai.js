const GEMINI_API_KEY = 'AIzaSyC-54RvW369kmZWN-vJNomxmohwaFgmNAo';
const url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GEMINI_API_KEY },
  body: JSON.stringify({ model: 'gemini-1.5-flash', messages: [{ role: 'user', content: 'Hello' }] })
}).then(res => res.json()).then(data => console.log(data)).catch(console.error);
