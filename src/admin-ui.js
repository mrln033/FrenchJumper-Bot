export const ADMIN_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FrenchJumper — Administration</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#10131c;color:#eef2ff}body{margin:0}main{max-width:960px;margin:auto;padding:40px 22px}header{display:flex;align-items:center;justify-content:space-between;gap:20px}h1{font-size:clamp(25px,4vw,38px);margin:8px 0}h2{font-size:19px}p{line-height:1.6;color:#bac4d9}.eyebrow{color:#76b6ff;letter-spacing:.12em;font-size:12px;font-weight:700}section{background:#1a2030;border:1px solid #303950;border-radius:14px;padding:24px;margin:22px 0}button,.button{display:inline-block;border:0;border-radius:8px;padding:12px 18px;background:#548bff;color:white;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}button.secondary{background:#333e56}button:disabled{opacity:.5;cursor:wait}select{display:block;width:100%;padding:12px;background:#101725;color:white;border:1px solid #5c6c8b;border-radius:8px;margin:10px 0 22px;font:inherit}label{display:block;margin:16px 0}input{accent-color:#548bff}#notice{white-space:pre-wrap;padding:14px;border-left:3px solid #76b6ff;background:#182437}#notice:empty{display:none}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.metric{background:#101725;padding:15px;border-radius:8px}.metric span{display:block;color:#bac4d9;font-size:13px;margin-bottom:7px}table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:10px;border-bottom:1px solid #303950}.scroll{overflow-x:auto}.actions{display:flex;gap:12px;flex-wrap:wrap}small{color:#bac4d9}footer{color:#8998b6;font-size:13px;margin:32px 0}[hidden]{display:none!important}@media(max-width:600px){.grid{grid-template-columns:1fr}header{align-items:flex-start;flex-direction:column}section{padding:18px}}
</style><script src="/admin/app.js" defer></script></head><body><main>
<header><div><div class="eyebrow">FRENCHJUMPER BOT · ESPACE PRIVÉ</div><h1>Le relais de votre société</h1><p>Publications Entropia Central, sous votre contrôle.</p></div><button id="logout" class="secondary" hidden>Déconnexion</button></header>
<p id="notice" role="status" aria-live="polite"></p>
<section id="login"><h2>Connexion réservée aux administrateurs</h2><p>Utilisez votre compte Discord autorisé. Aucun token ne vous sera demandé ici.</p><a class="button" href="/admin/login">Se connecter avec Discord</a></section>
<div id="dashboard" hidden>
<section><h2>État du service</h2><div class="grid"><div class="metric"><span>Dernier cycle réussi</span><strong id="last-run">—</strong></div><div class="metric"><span>Membres actifs</span><strong id="members">—</strong></div><div class="metric"><span>Liste des membres actualisée</span><strong id="roster">—</strong></div><div class="metric"><span>Lecture automatique</span><strong id="polling">—</strong></div></div><p id="error"></p><div class="actions"><button id="reload" class="secondary">Actualiser l’état</button><button id="refresh" class="secondary">Recharger FRJ Membres</button></div></section>
<section><h2>Destination et publications</h2><form id="settings"><label for="channel">Salon de publication</label><select id="channel" required disabled><option value="">Charger les salons autorisés…</option></select><button type="button" id="channels" class="secondary">Charger les salons accessibles</button><label><input type="checkbox" id="publishing"> Publier les globals sur Discord</label><p>En pause, les nouveaux globals restent en attente. À la reprise, ils sont publiés dans le salon sélectionné. Un changement de salon concerne aussi les messages en attente, mais ne déplace pas les anciens messages.</p><button id="save" disabled>Enregistrer les réglages</button></form><p><small>Les webhooks Entropia Central existants ne sont pas modifiés par cette page.</small></p></section>
<section><h2>Accès à l’administration</h2><p>Les détenteurs de ces rôles peuvent modifier tous les réglages, y compris les accès. Le rôle Administrateur initial reste autorisé comme accès de secours.</p><button id="roles-load" class="secondary">Charger les rôles du serveur</button><form id="roles-form" hidden><div id="roles-list"></div><button id="roles-save">Enregistrer les accès</button></form></section>
<section><h2>Derniers globals détectés</h2><div class="scroll"><table><thead><tr><th>Avatar / équipe</th><th>PED</th><th>Heure de l’entrée</th><th>État</th></tr></thead><tbody id="recent"></tbody></table></div></section>
</div><footer>FrenchJumper · Source des globals : entropiacentral.com<br>Actualisation manuelle pour limiter les lectures D1. Les heures sont affichées dans votre fuseau horaire.</footer>
</main></body></html>`;

export const ADMIN_JS = `
const $ = id => document.getElementById(id);
let current;
const date = value => value ? new Date(value).toLocaleString('fr-FR') : 'En attente';
const message = text => { $('notice').textContent = text; };
async function api(path, body) {
  const response = await fetch('/admin/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FRJ-Admin': '1' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401) { $('login').hidden=false; $('dashboard').hidden=true; $('logout').hidden=true; } throw new Error(data.error || 'Erreur du service'); }
  return data;
}
async function load() {
  const data = await api('api/status'); current = data.settings;
  $('login').hidden=true; $('dashboard').hidden=false; $('logout').hidden=false;
  $('last-run').textContent=date(data.state?.last_success_at); $('members').textContent=data.members;
  $('roster').textContent=date(data.state?.roster_refreshed_at); $('polling').textContent=data.polling?'Active':'Désactivée';
  $('error').textContent=data.state?.last_error ? 'Dernière erreur : ' + data.state.last_error : 'Aucune erreur au dernier cycle.';
  $('publishing').checked=Boolean(current.publishing);
  $('channel').replaceChildren(new Option('Salon actuel · '+current.channel_id, current.channel_id));
  $('channel').disabled=true; $('save').disabled=true;
  $('recent').replaceChildren();
  const states={published:'Publié',pending:'En attente',failed:'Échec',observed:'Observé (ancien mode)'};
  for(const item of data.recent){const row=document.createElement('tr');for(const value of [item.avatar_name,item.value_ped,date(item.occurred_at),states[item.publish_status]||item.publish_status]){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}$('recent').append(row);}
}
async function action(button, fn){button.disabled=true;try{await fn();}catch(e){message(e.message);}finally{button.disabled=button.id==='save'&&$('channel').disabled;}}
$('reload').onclick=()=>action($('reload'),async()=>{await load();message('État actualisé.');});
$('channels').onclick=()=>action($('channels'),async()=>{const data=await api('api/channels');$('channel').replaceChildren(new Option('Choisir un salon…',''));for(const c of data.channels)$('channel').add(new Option('#'+c.name,c.id));$('channel').value=current.channel_id;$('channel').disabled=false;$('save').disabled=false;message(data.channels.length+' salons accessibles au bot.');});
$('settings').onsubmit=event=>{event.preventDefault();if(!confirm('Confirmer la destination et l’état des publications ? Les messages en attente suivront ces réglages.'))return;action($('save'),async()=>{const r=await api('api/settings',{channel_id:$('channel').value,publishing:$('publishing').checked,revision:current.revision});await load();message(r.message);$('save').disabled=true;});};
$('refresh').onclick=()=>action($('refresh'),async()=>{const r=await api('api/refresh-members',{});message(r.message);});
$('logout').onclick=()=>action($('logout'),async()=>{await api('logout',{});location.assign('/admin');});
$('roles-load').onclick=()=>action($('roles-load'),async()=>{const data=await api('api/roles');$('roles-list').replaceChildren();for(const role of data.roles){const label=document.createElement('label');const input=document.createElement('input');input.type='checkbox';input.value=role.id;input.checked=data.selected.includes(role.id);input.disabled=data.fixed.includes(role.id);label.append(input,document.createTextNode(' '+role.name+(input.disabled?' (secours)':'')));$('roles-list').append(label);}$('roles-form').hidden=false;});
$('roles-form').onsubmit=event=>{event.preventDefault();if(!confirm('Accorder l’administration complète aux rôles sélectionnés ?'))return;action($('roles-save'),async()=>{const role_ids=Array.from($('roles-list').querySelectorAll('input:checked'),input=>input.value);const r=await api('api/roles',{role_ids});message(r.message);});};
load().catch(e=>message(e.message));
`;
