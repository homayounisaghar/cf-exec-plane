// X11 window frame geometry shared by the universal mirror capture engine.
// _NET_FRAME_EXTENTS: left, right, top, bottom in ROOT SCREEN coordinates.
// Some undecorated Xvfb applications have no extents: treat those as zero.
export function parseFrameExtents(text) {
 const m=String(text||'').match(/_NET_FRAME_EXTENTS[^=]*=\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
 if(!m)return null;
 const a=m.slice(1).map(Number);
 if(a.some(v=>!Number.isSafeInteger(v)||v<0||v>512))return null;
 return {left:a[0],right:a[1],top:a[2],bottom:a[3]};
}
export function parseX11Geometry(text) {
 const s=String(text||'');
 const v=k=>Number((s.match(new RegExp('(?:^|\\n)'+k+'=(-?\\d+)'))||[])[1]);
 const x=v('X'),y=v('Y'),w=v('WIDTH'),h=v('HEIGHT');
 if(![x,y,w,h].every(Number.isSafeInteger)||w<1||h<1)return null;
 return {x,y,w,h};
}
export function frameRegion(client,extents,screenW,screenH) {
 const {left=0,right=0,top=0,bottom=0}=extents||{};
 if(!client||![screenW,screenH].every(v=>Number.isSafeInteger(v)&&v>=2))
  throw Error('INVALID_X11_WINDOW_GEOMETRY');
 const fx=client.x-left, fy=client.y-top;
 const endX=client.x+client.w+right, endY=client.y+client.h+bottom;
 const x=Math.max(0,Math.min(screenW-2,fx)),y=Math.max(0,Math.min(screenH-2,fy));
 const w=Math.min(screenW,endX)-x,h=Math.min(screenH,endY)-y;
 if(w<2||h<2||endX<=0||endY<=0||fx>=screenW||fy>=screenH)
  throw Error('X11_TARGET_WINDOW_OFF_SCREEN');
 // MJPEG x11grab requires even dimensions. Round UP when room remains,
 // preserving the last border pixel instead of cutting it away.
 const even=(n,avail)=>Math.ceil(n/2)*2<=avail?Math.ceil(n/2)*2:Math.floor(n/2)*2;
 const ww=even(w,screenW-x),hh=even(h,screenH-y);
 if(ww<2||hh<2)throw Error('X11_TARGET_WINDOW_TOO_SMALL');
 return {x,y,w:ww,h:hh};
}
export function parseWindowClass(text) {
 const s=String(text||'');
 const m=s.match(/^WM_CLASS\([^\n]*?\)\s*=\s*(.*)$/m);
 if(!m)return '';
 const parts=[...m[1].matchAll(/"([^"]*)"/g)].map(x=>x[1]);
 return (parts[1]||parts[0]||'').slice(0,140);
}
