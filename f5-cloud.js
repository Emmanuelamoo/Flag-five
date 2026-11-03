/* Flag Five cloud adapter for self-hosting (Vercel + Supabase).
   Inside Claude this file does nothing. Elsewhere it provides the same
   services the game expects: db, user, room, sample (AI) and downloads. */
(function(){
 if(window.claude&&window.claude.use)return; // running inside Claude: use the built-in services
 var cfg=window.F5_CONFIG||{};
 var hasSB=!!(cfg.supabaseUrl&&cfg.supabaseAnonKey&&window.supabase&&window.supabase.createClient);
 var sb=hasSB?window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseAnonKey,{auth:{persistSession:true,autoRefreshToken:true}}):null;
 var uidP=null;
 function ensureUser(){
  if(!sb)return Promise.resolve(null);
  if(!uidP)uidP=(async function(){
   var s=await sb.auth.getSession();
   if(s&&s.data&&s.data.session)return s.data.session.user.id;
   var r=await sb.auth.signInAnonymously();
   if(r.error){console.warn('Flag Five: anonymous sign-in failed. Enable Anonymous sign-ins in Supabase.',r.error);uidP=null;return null;}
   return r.data.user.id;
  })();
  return uidP;
 }
 function err(code,msg){var e=new Error(msg||code);e.code=code;return e;}
 // ---------- db: collection(name).limit(n).onSnapshot, doc(path).set ----------
 var db=sb?{
  collection:function(name){var lim=500;var q={limit:function(n){lim=n;return q;},onSnapshot:function(next,onErr){
   var dead=false,timer=null;
   async function load(){
    var r=await sb.from('docs').select('path,data').eq('collection',name).limit(lim);
    if(dead)return;
    if(r.error){onErr&&onErr(err('unavailable',r.error.message));return;}
    next({docs:r.data.map(function(row){return{id:row.path.split('/')[1],exists:true,data:function(){return JSON.parse(JSON.stringify(row.data));},metadata:{fromCache:false}};}),size:r.data.length,empty:!r.data.length,metadata:{fromCache:false},docChanges:function(){return[];}});
   }
   var ch=sb.channel('docs-'+name+'-'+Math.random().toString(36).slice(2,7))
    .on('postgres_changes',{event:'*',schema:'public',table:'docs',filter:'collection=eq.'+name},function(){clearTimeout(timer);timer=setTimeout(load,150);})
    .subscribe();
   ensureUser().then(load);
   var poll=setInterval(load,20000);
   return function(){dead=true;clearInterval(poll);sb.removeChannel(ch);};
  }};return q;},
  doc:function(path){return{set:async function(data){
   var uid=await ensureUser();if(!uid)throw err('not_permitted','Not signed in');
   var parts=path.split('/');
   var r=await sb.from('docs').upsert({path:path,collection:parts[0],data:data,owner:uid,updated_at:new Date().toISOString()},{onConflict:'path'});
   if(r.error)throw err(/row-level security|permission/i.test(r.error.message)?'permission_denied':'unavailable',r.error.message);
  }};}
 }:null;
 var user=sb?{id:function(){return ensureUser();}}:null;
 // ---------- room: realtime game rooms over Supabase broadcast ----------
 var tabId=Math.random().toString(36).slice(2,10);
 var room=sb?{join:async function(name){
  var ch=sb.channel('f5room:'+name,{config:{broadcast:{self:false,ack:false}}});
  var mine={},peers={},peerCbs=[],topicCbs={},sendT=null,lastSent=0,closed=false;
  function list(){var a=[{peer:tabId,isMe:true,sameTab:true,presence:mine}];for(var k in peers)a.push({peer:k,isMe:false,sameTab:false,presence:peers[k].p});return a;}
  function notify(left){var c={peers:list(),joined:[],left:left||[]};peerCbs.forEach(function(f){try{f(c);}catch(e){console.error(e);}});}
  function send(){if(closed)return;lastSent=Date.now();ch.send({type:'broadcast',event:'p',payload:{id:tabId,p:mine}});}
  function schedule(){if(sendT)return;var wait=Math.max(0,66-(Date.now()-lastSent));sendT=setTimeout(function(){sendT=null;send();},wait);}
  ch.on('broadcast',{event:'p'},function(m){var d=m.payload||{};if(!d.id||d.id===tabId)return;var isNew=!peers[d.id];peers[d.id]={p:d.p||{},t:Date.now()};if(isNew)send();notify();});
  ch.on('broadcast',{event:'bye'},function(m){var d=m.payload||{};if(peers[d.id]){var p={peer:d.id,isMe:false,sameTab:false,presence:peers[d.id].p};delete peers[d.id];notify([p]);}});
  ch.on('broadcast',{event:'e'},function(m){var d=m.payload||{};(topicCbs[d.t]||[]).forEach(function(f){try{f({peer:d.from,isMe:false,sameTab:false,data:d.d,topic:d.t});}catch(e){}});});
  await new Promise(function(res,rej){var to=setTimeout(function(){rej(err('unavailable','Room timeout'));},10000);ch.subscribe(function(st){if(st==='SUBSCRIBED'){clearTimeout(to);res();}else if(st==='CHANNEL_ERROR'||st==='TIMED_OUT'){clearTimeout(to);rej(err('unavailable',st));}});});
  var hb=setInterval(function(){send();var now=Date.now(),gone=[];for(var k in peers)if(now-peers[k].t>8000){gone.push({peer:k,isMe:false,sameTab:false,presence:peers[k].p});delete peers[k];}if(gone.length)notify(gone);},2000);
  send();
  return{
   presence:function(patch){for(var k in patch){if(patch[k]===null)delete mine[k];else mine[k]=patch[k];}schedule();return Promise.resolve();},
   onPeers:function(f){peerCbs.push(f);setTimeout(function(){f({peers:list(),joined:[],left:[]});},0);return function(){peerCbs=peerCbs.filter(function(x){return x!==f;});};},
   peers:list,
   emit:function(topic,data){return ch.send({type:'broadcast',event:'e',payload:{t:topic,d:data,from:tabId}});},
   on:function(topic,f){(topicCbs[topic]=topicCbs[topic]||[]).push(f);return function(){topicCbs[topic]=(topicCbs[topic]||[]).filter(function(x){return x!==f;});};},
   leave:async function(){closed=true;clearInterval(hb);try{await ch.send({type:'broadcast',event:'bye',payload:{id:tabId}});}catch(e){}sb.removeChannel(ch);}
  };
 }}:null;
 // ---------- sample: AI through the /api/sample serverless function ----------
 var sample={json:async function(input){
  var prompt=typeof input==='string'?input:JSON.stringify(input);
  var r;try{r=await fetch('/api/sample',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:prompt})});}catch(e){throw err('unavailable');}
  if(!r.ok)throw err(r.status===501||r.status===404?'not_granted':'unavailable');
  var j=await r.json(),t=String(j.text||''),m=t.match(/\{[\s\S]*\}/);
  try{return JSON.parse(m?m[0]:t);}catch(e){throw err('bad_output');}
 }};
 // ---------- downloads: normal browser download ----------
 var downloads={save:async function(o){
  var url=URL.createObjectURL(o.data),a=document.createElement('a');a.href=url;a.download=o.filename||'download';document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(url);},4000);return{saved:true};
 }};
 var map={db:db,user:user,room:room,sample:sample,downloads:downloads};
 window.claude={use:async function(n){var v=map[n]||null;if(v&&(n==='db'||n==='user'||n==='room'))await ensureUser();return v;}};
})();
