(function(){
  'use strict';
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'})
      .catch(function(){});
    navigator.serviceWorker.addEventListener('message',function(ev){
      var d=ev.data;
      if(!d||d.type!=='CFM_QUOTA_FAILOVER'||typeof d.url!=='string')return;
      try{
        var u=new URL(d.url);
        if(u.protocol!=='https:'||!u.hostname.endsWith('.workers.dev')||
           u.origin===location.origin||u.pathname!=='/')return;
        // Active microphone and mouse streams are disconnected, not replayed.
        // A fresh password login is required after changing Worker account.
        location.replace(u.href);
      }catch(_){}
    });
  }
  // Remove one-hop markers after successful HTML paint; the next real quota
  // incident begins a new bounded ring cycle.
  if(location.search.indexOf('__cfm_')>=0){
    setTimeout(function(){
      try{
        var u=new URL(location.href);
        if(!u.searchParams.has('__cfm_entry')&&!u.searchParams.has('__cfm_hop'))
          return;
        u.searchParams.delete('__cfm_entry');
        u.searchParams.delete('__cfm_hop');
        history.replaceState(history.state,'',u.href);
      }catch(_){}
    },8000);
  }
})();
