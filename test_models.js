const GEMINI_API_KEY = 'AIzaSyC-54RvW369kmZWN-vJNomxmohwaFgmNAo';
const url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + GEMINI_API_KEY;
fetch(url).then(res => res.json()).then(data => console.log(data.models.map(m => m.name))).catch(console.error);
