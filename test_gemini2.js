const GEMINI_API_KEY = 'AIzaSyC-54RvW369kmZWN-vJNomxmohwaFgmNAo';
const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=' + GEMINI_API_KEY;
fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ contents: [{ parts: [{ text: 'Hello' }] }] })
}).then(res => res.json()).then(data => console.log(data)).catch(console.error);
