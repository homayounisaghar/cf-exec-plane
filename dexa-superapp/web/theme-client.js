/* Dexa Super Dashboard shared user-selected theme, WebViews on the same app origin. */
(()=>{
 'use strict';
 const KEY='dexa-theme-color-v1';
 const keys=['--ink','--muted','--primary','--primary-active','--primary-contrast','--hero-from','--hero-to','--bg','--card','--line','--button','--button-ink','--tag','--tag-ink','--field-bg','--field-border','--url-bg','--shadow','--notice','--notice-border','--notice-ink','--debug','--debug-ink'];
 const presets=[{label:'نارنجی',hex:'#d65d0e'},{label:'سبزآبی',hex:'#008e87'},{label:'آبی',hex:'#2563eb'},{label:'بنفش',hex:'#7c3aed'},{label:'سبز',hex:'#16834e'}];
 let applied;
 const valid=v=>typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v);
 function read(){try{const x=localStorage.getItem(KEY);return valid(x)?x.toLowerCase():null}catch{return null}}
 function blend(a,b,t){return '#'+[1,3,5].map(i=>Math.round(parseInt(a.slice(i,i+2),16)*(1-t)+parseInt(b.slice(i,i+2),16)*t).toString(16).padStart(2,'0')).join('')}
 function palette(x){return {
  '--ink':blend(x,'#000000',.78),'--muted':blend(x,'#333333',.70),
  '--primary':x,'--primary-active':blend(x,'#000000',.15),'--primary-contrast':'#ffffff',
  '--hero-from':blend(x,'#000000',.29),'--hero-to':blend(x,'#ffffff',.16),
  '--bg':blend(x,'#ffffff',.91),'--card':blend(x,'#ffffff',.975),
  '--line':blend(x,'#ffffff',.72),'--button':blend(x,'#ffffff',.82),
  '--button-ink':blend(x,'#000000',.55),'--tag':blend(x,'#ffffff',.82),
  '--tag-ink':blend(x,'#000000',.48),'--field-bg':'#ffffff',
  '--field-border':blend(x,'#ffffff',.69),'--url-bg':blend(x,'#ffffff',.90),
  '--shadow':'rgba('+[1,3,5].map(i=>parseInt(x.slice(i,i+2),16)).join(',')+',0.08)',
  '--notice':blend(x,'#ffffff',.90),'--notice-border':blend(x,'#ffffff',.66),
  '--notice-ink':blend(x,'#000000',.50),'--debug':blend(x,'#000000',.72),
  '--debug-ink':blend(x,'#ffffff',.85)
 }}
 function refresh(){
  const next=read();if(next===applied)return;
  for(const k of keys)document.documentElement.style.removeProperty(k);
  if(next){const vars=palette(next);for(const k of keys)document.documentElement.style.setProperty(k,vars[k]);}
  applied=next;
 }
 function set(x){if(!valid(x))return false;try{localStorage.setItem(KEY,x.toLowerCase())}catch{return false}refresh();return true}
 function reset(){try{localStorage.removeItem(KEY)}catch{return false}refresh();return true}
 window.DexaTheme={presets,read,set,reset,refresh};
 refresh();window.addEventListener('storage',refresh);window.addEventListener('focus',refresh);
 setInterval(refresh,1100);
})();
