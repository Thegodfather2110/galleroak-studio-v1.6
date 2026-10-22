'use strict';
/* The optional hosted chat page of a connector (served only when "Public chat page" is on). One self-contained page, no external files. */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render(conn, nonce, lang) {
  const s = conn.settings;
  const greetingFor = {
    en: s.greeting || lang.DEFAULT_GREETING.en,
    hi: s.greeting || lang.DEFAULT_GREETING.hi,
    hinglish: s.greeting || lang.DEFAULT_GREETING.hinglish,
  };
  const cfg = JSON.stringify({ id: conn.id, name: s.business || conn.name, language: s.language, greeting: greetingFor, handoff: s.handoff || '' }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(s.business || conn.name)} - Chat</title>
<style nonce="${nonce}">
:root{--bg:#0e1116;--card:#171b22;--line:#2a313c;--text:#e8ecf1;--dim:#9aa4b2;--acc:#3da0ff;--me:#1f4f86;--warn:#e0a030}
@media (prefers-color-scheme:light){:root{--bg:#f3f5f8;--card:#fff;--line:#d8dee6;--text:#16202b;--dim:#5b6776;--me:#d7e9ff}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Devanagari",sans-serif;display:flex;flex-direction:column}
header{padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
header h1{font-size:17px;margin:0;flex:1;min-width:140px}
select,button,textarea{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px 10px}
button{cursor:pointer;background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
button.ghost{background:transparent;color:var(--text);border-color:var(--line)}
button.on{outline:2px solid var(--warn)}
#log{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.m{max-width:min(620px,88%);padding:10px 13px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;border:1px solid var(--line);background:var(--card)}
.m.u{align-self:flex-end;background:var(--me);border-color:transparent}
.m.b{align-self:flex-start}
#banner{display:none;margin:0 16px;padding:10px 12px;border:1px solid var(--warn);border-radius:10px;color:var(--warn);font-size:14px}
form{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--line);background:var(--card);align-items:flex-end}
textarea{flex:1;resize:none;max-height:140px;min-height:42px}
.note{font-size:12px;color:var(--dim);padding:0 16px 10px;background:var(--card)}
</style></head><body>
<header><h1 id="title"></h1>
<select id="lang" aria-label="Language"><option value="auto">Auto</option><option value="en">English</option><option value="hi">हिंदी</option><option value="hinglish">Hinglish</option></select>
<button type="button" class="ghost" id="speak" title="Read replies aloud">🔊</button></header>
<div id="log" aria-live="polite"></div>
<div id="banner"></div>
<form id="f"><textarea id="q" rows="1" placeholder="Type your message…" autocomplete="off"></textarea>
<button type="button" class="ghost" id="mic" title="Speak">🎤</button><button id="send">Send</button></form>
<div class="note">AI assistant. It can make mistakes. Ask for a person any time.</div>
<script nonce="${nonce}">
(function(){
var CFG=${cfg};var $=function(i){return document.getElementById(i)};
var log=$('log'),q=$('q'),sel=$('lang'),banner=$('banner'),hist=[],busy=false,speakOn=false,cur='en';
$('title').textContent=CFG.name;
if(CFG.language!=='auto'){sel.value=CFG.language;sel.style.display='none'}
var PH={en:'Type your message…',hi:'अपना संदेश लिखें…',hinglish:'Apna message likhein…'};
var BTN={en:'Send',hi:'भेजें',hinglish:'Bhejein'};
function ui(l){cur=l;q.placeholder=PH[l]||PH.en;$('send').textContent=BTN[l]||BTN.en}
function add(role,text){var d=document.createElement('div');d.className='m '+(role==='user'?'u':'b');d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;return d}
function initLang(){var l=sel.value==='auto'?'en':sel.value;ui(l);return l}
add('bot',CFG.greeting[initLang()]);
sel.onchange=function(){var l=initLang();if(!hist.length){log.innerHTML='';add('bot',CFG.greeting[l])}};
function say(t,l){if(!speakOn||!window.speechSynthesis)return;var u=new SpeechSynthesisUtterance(t);u.lang=l==='hi'?'hi-IN':l==='hinglish'?'hi-IN':'en-IN';speechSynthesis.cancel();speechSynthesis.speak(u)}
$('speak').onclick=function(){speakOn=!speakOn;this.classList.toggle('on',speakOn);if(!speakOn&&window.speechSynthesis)speechSynthesis.cancel()};
var SR=window.SpeechRecognition||window.webkitSpeechRecognition,rec=null;
if(!SR)$('mic').style.display='none';
$('mic').onclick=function(){
  if(rec){rec.stop();return}
  rec=new SR();rec.lang=(sel.value==='en'||(sel.value==='auto'&&cur==='en'))?'en-IN':'hi-IN';rec.interimResults=true;
  var b=this;b.classList.add('on');
  rec.onresult=function(e){var t='';for(var i=0;i<e.results.length;i++)t+=e.results[i][0].transcript;q.value=t};
  rec.onend=function(){b.classList.remove('on');rec=null;if(q.value.trim())$('f').requestSubmit()};
  rec.onerror=function(){b.classList.remove('on');rec=null};
  rec.start();
};
q.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('f').requestSubmit()}});
$('f').onsubmit=function(e){
  e.preventDefault();var t=q.value.trim();if(!t||busy)return;
  q.value='';busy=true;add('user',t);hist.push({role:'user',content:t});
  var out=add('bot','…'),acc='';
  var body={messages:hist.slice(-20),stream:true};if(sel.value!=='auto')body.language=sel.value;
  fetch('/c/'+CFG.id+'/v1/public',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){
    var l=r.headers.get('X-Language')||'en';ui(l);
    if(r.headers.get('X-Handoff')==='1'){banner.style.display='block';banner.textContent=CFG.handoff||({en:'A human agent will follow up with you.',hi:'हमारा एजेंट जल्द ही आपसे संपर्क करेगा।',hinglish:'Hamara agent jaldi aapse sampark karega.'})[l]}
    if(!r.ok){return r.json().then(function(j){throw new Error((j.error&&j.error.message)||'Error')})}
    var rd=r.body.getReader(),dec=new TextDecoder(),buf='';
    function pump(){return rd.read().then(function(x){
      if(x.done){return}
      buf+=dec.decode(x.value,{stream:true});var lines=buf.split('\\n');buf=lines.pop();
      lines.forEach(function(ln){ln=ln.trim();if(ln.indexOf('data:')!==0)return;var d=ln.slice(5).trim();if(d==='[DONE]')return;
        try{var j=JSON.parse(d);var c=j.choices&&j.choices[0];var dt=c&&c.delta&&c.delta.content;if(dt){acc+=dt;out.textContent=acc;log.scrollTop=log.scrollHeight}}catch(_){}});
      return pump()})}
    return pump().then(function(){if(!acc)out.textContent='…';hist.push({role:'assistant',content:acc});say(acc,l)});
  }).catch(function(err){out.textContent=err.message||'Something went wrong. Please try again.'}).then(function(){busy=false;q.focus()});
};
})();
</script></body></html>`;
}

module.exports = { render };
