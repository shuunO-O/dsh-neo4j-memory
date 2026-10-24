'use strict';
// Canvas paints the scene. The SVG overlay retains keyboard and pointer targets.
function createGraphRenderer(canvas,map){
  const ctx=canvas.getContext('2d');if(!ctx)return null;
  let graph=null,state={active:null,selected:null,near:null,strength:29},batches=null,metrics=null,colors={},palette={},sprites=new Map(),dirty=true,pose=null,rasterizations=0;
  const lerp=(a,b,t)=>a+(b-a)*t,reducedSky=matchMedia('(prefers-reduced-motion: reduce)');
  let focusDim=0,dimTarget=0,dimRaf=null,shownActive=null,shownNear=null,cam=null;
  const rgba=(hex,a)=>{const h=hex.replace('#','');return `rgba(${parseInt(h.slice(0,2),16)},${parseInt(h.slice(2,4),16)},${parseInt(h.slice(4,6),16)},${a})`;};
  const shade=(hex,amt)=>{const h=hex.replace('#',''),t=amt<0?0:255,p=Math.abs(amt),m=v=>Math.round(v+(t-v)*p);return `rgb(${m(parseInt(h.slice(0,2),16))},${m(parseInt(h.slice(2,4),16))},${m(parseInt(h.slice(4,6),16))})`;};
  const REGION_TINTS=['#6fb8a8','#6f94c9','#9384d6','#c9a26f','#c98fa0','#8fb873'];
  function theme(values){
    palette={...values};const style=getComputedStyle(document.body);
    for(const name of ['edge','edge-cross','edge-active','canvas','text','label','label-outline','muted'])colors[name]=style.getPropertyValue(`--${name}`).trim();
    sprites.clear();dirty=true;
  }
  function resize(){
    const rect=map.getBoundingClientRect(),matrix=map.getScreenCTM(),ratio=Math.min(devicePixelRatio||1,2);
    if(!matrix||!rect.width||!rect.height)return;
    const pad=Math.min(350,Math.max(180,rect.width*.25)),width=Math.round((rect.width+pad*2)*ratio),height=Math.round((rect.height+pad*2)*ratio);
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    const next={width:rect.width,height:rect.height,ratio,unit:matrix.a,x:matrix.e-rect.left,y:matrix.f-rect.top,pad};
    if(!metrics||Object.keys(next).some(key=>metrics[key]!==next[key])){dirty=true;pose=null;}
    metrics=next;canvas.style.width=(rect.width+pad*2)+'px';canvas.style.height=(rect.height+pad*2)+'px';canvas.style.left=canvas.style.top=-pad+'px';
  }
  function setGraph(value){
    graph=value;batches=null;sprites.clear();dirty=true;pose=null;state={active:null,selected:null,near:null,strength:state.strength};
    focusDim=0;dimTarget=0;shownActive=null;shownNear=null;if(dimRaf){cancelAnimationFrame(dimRaf);dimRaf=null;}
    for(const e of graph.edges){
      const d=e.path;e.canvasPath=new Path2D(d);
      const p=d.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/ig).map(Number),end=p.length-2;
      const dx=p[end]-p[end-2],dy=p[end+1]-p[end-1],distance=Math.hypot(dx,dy)||1,u=dx/distance,v=dy/distance;
      const gap=e.a===e.b?0:graph.nodes[e.b].r+4,x=p[end]-u*gap,y=p[end+1]-v*gap;
      e.canvasArrow=new Path2D(`M${x-u*4-v*2},${y-v*4+u*2} L${x},${y} L${x-u*4+v*2},${y-v*4-u*2}`);
    }
    resize();
  }
  // Focus dimming eases toward its target (180ms, framerate-independent) so hovering across nodes never snaps the whole scene dark.
  function startDimTween(){
    if(dimRaf)return;let last=performance.now();
    const step=now=>{
      const dt=Math.min(50,now-last);last=now;
      focusDim+=Math.sign(dimTarget-focusDim)*dt/180;
      if((dimTarget===1&&focusDim>=1)||(dimTarget===0&&focusDim<=0)){focusDim=dimTarget;dimRaf=null;if(focusDim===0){shownActive=null;shownNear=null;batches=null;}}
      else dimRaf=requestAnimationFrame(step);
      dirty=true;if(cam)draw(cam.scale,cam.tx,cam.ty);
    };
    dimRaf=requestAnimationFrame(step);
  }
  function focus(value){
    const hasActive=value.active!==null;
    if(hasActive){if(value.active!==shownActive){shownActive=value.active;batches=null;dirty=true;}shownNear=value.near;}
    const target=hasActive?1:0;
    if(target!==dimTarget){
      dimTarget=target;
      if(document.body.dataset.motion==='off'||reducedSky.matches){focusDim=target;if(focusDim===0){shownActive=null;shownNear=null;}batches=null;dirty=true;}
      else startDimTween();
    }
    if(value.active!==state.active||value.selected!==state.selected||value.strength!==state.strength||value.tier!==state.tier)dirty=true;
    state=value;
  }
  function edgeBatches(){
    if(batches)return batches;batches=new Map();
    const high=shownActive!==null&&graph.analysis.adj[shownActive].length>50;
    for(const e of graph.edges){
      const connected=shownActive!==null&&(e.a===shownActive||e.b===shownActive);
      const key=connected?'active':e.hub?'hub':e.cross?'cross':'local';
      if(!batches.has(key))batches.set(key,{path:new Path2D(),arrows:new Path2D(),count:0,alpha:high?.55:.92,factor:key==='hub'?.15:key==='cross'?.48:1,color:key==='active'?'edge-active':key==='cross'?'edge-cross':'edge',width:key==='active'?(high?.8:1.1):.6});
      const batch=batches.get(key);batch.path.addPath(e.canvasPath);batch.count++;if(connected)batch.arrows.addPath(e.canvasArrow);
    }
    return batches;
  }
  function sprite(n){
    const key=`${n.type}:${n.r.toFixed(2)}:${n.protagonist}:${n.anchor}`;if(sprites.has(key))return sprites.get(key);
    const size=Math.ceil(n.r*7.4+22),quality=4,surface=document.createElement('canvas');surface.width=surface.height=size*quality;
    const c=surface.getContext('2d'),color=palette[n.type];c.scale(quality,quality);c.translate(size/2,size/2);
    const aura=c.createRadialGradient(0,0,n.r*.4,0,0,n.r*3.6);aura.addColorStop(0,rgba(color,.2));aura.addColorStop(.55,rgba(color,.06));aura.addColorStop(1,rgba(color,0));c.fillStyle=aura;c.fillRect(-size/2,-size/2,size,size);
    const bloom=c.createRadialGradient(0,0,0,0,0,n.r*2);bloom.addColorStop(0,rgba(color,.42));bloom.addColorStop(.5,rgba(color,.13));bloom.addColorStop(1,rgba(color,0));c.fillStyle=bloom;c.fillRect(-size/2,-size/2,size,size);
    if(n.type==='Person'){
      c.strokeStyle=color;c.globalAlpha=n.protagonist?.9:.7;c.lineWidth=.7;c.setLineDash(n.protagonist?[]:[1,1.5]);c.beginPath();c.arc(0,0,n.r+4,0,Math.PI*2);c.stroke();c.setLineDash([]);c.globalAlpha=1;
    }
    if(n.protagonist){c.strokeStyle=color;c.lineWidth=.5;c.globalAlpha=.38;c.setLineDash([1,7]);c.beginPath();c.arc(0,0,n.r+15,0,Math.PI*2);c.stroke();c.setLineDash([]);c.globalAlpha=1;}
    const lite=document.body.dataset.theme==='light',bodyR=n.type==='Person'?n.r*.65:n.r,body=c.createRadialGradient(-bodyR*.35,-bodyR*.4,bodyR*.1,0,0,bodyR*1.05);
    body.addColorStop(0,shade(color,lite?.3:.55));body.addColorStop(.55,color);body.addColorStop(1,shade(color,lite?-.42:-.3));
    c.fillStyle=body;c.strokeStyle=rgba(color,.9);c.lineWidth=.3;c.beginPath();
    if(n.type==='Location'){c.moveTo(0,-n.r*1.13);c.lineTo(n.r*1.13,0);c.lineTo(0,n.r*1.13);c.lineTo(-n.r*1.13,0);c.closePath();}
    else c.arc(0,0,bodyR,0,Math.PI*2);
    c.fill();c.stroke();
    if(n.r>=1.6){c.fillStyle='rgba(255,255,255,.42)';c.beginPath();c.ellipse(-n.r*.3,-n.r*.36,n.r*.24,n.r*.15,-.6,0,Math.PI*2);c.fill();}
    c.fillStyle=document.body.dataset.theme==='light'?'#fffdf1':'#f5f6ed';c.globalAlpha=.72;c.beginPath();c.arc(0,0,n.protagonist?2:Math.min(.95,n.r*.28),0,Math.PI*2);c.fill();c.globalAlpha=1;
    if(n.anchor||n.type==='Event'){const ray=n.r+2.5;c.strokeStyle=color;c.globalAlpha=.4;c.lineWidth=.5;c.beginPath();c.moveTo(-ray,0);c.lineTo(ray,0);c.moveTo(0,-ray);c.lineTo(0,ray);c.stroke();}
    const result={surface,size};sprites.set(key,result);return result;
  }
  function draw(scale,tx,ty,settle=false){
    if(!graph||!metrics)return;const m=metrics,unit=m.unit*scale;
    if(!dirty&&pose){
      const k=scale/pose.scale,dx=(m.pad+m.x)*(1-k)+m.unit*(tx-k*pose.tx),dy=(m.pad+m.y)*(1-k)+m.unit*(ty-k*pose.ty);
      const covered=-m.pad+dx<=-16&&-m.pad+dy<=-16&&-m.pad+dx+(m.width+m.pad*2)*k>=m.width+16&&-m.pad+dy+(m.height+m.pad*2)*k>=m.height+16;
      if(covered&&(!settle||Math.abs(k-1)<.002)){canvas.style.transform=`translate(${dx}px,${dy}px) scale(${k})`;cam={scale,tx,ty};return;}
    }
    rasterizations++;canvas.style.transform='none';
    ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.setTransform(m.ratio*unit,0,0,m.ratio*unit,m.ratio*(m.pad+m.x+m.unit*tx),m.ratio*(m.pad+m.y+m.unit*ty));
    const left=((-m.pad-m.x)/m.unit-tx)/scale,right=((m.width+m.pad-m.x)/m.unit-tx)/scale,top=((-m.pad-m.y)/m.unit-ty)/scale,bottom=((m.height+m.pad-m.y)/m.unit-ty)/scale;
    const centerNode=graph.nodes.find(n=>n.protagonist);
    if(centerNode){ctx.strokeStyle=colors.muted;ctx.lineWidth=1/scale;const ringBase=1-.4*focusDim;
      for(const [rad,a] of [[170,.06],[320,.048],[470,.036]]){ctx.globalAlpha=a*ringBase;ctx.beginPath();ctx.arc(centerNode.x,centerNode.y,rad,0,Math.PI*2);ctx.stroke();}
      ctx.globalAlpha=1;}
    if(graph.analysis.clear)for(const [ci,g] of graph.clusters.entries()){
      if(g.loose)continue;const tint=REGION_TINTS[ci%REGION_TINTS.length],lite=document.body.dataset.theme==='light',dim=1-.45*focusDim;
      ctx.save();ctx.translate(g.x,g.y);ctx.rotate((g.angle||0)*Math.PI/180);ctx.scale(g.rx+5,g.ry+5);
      const mist=ctx.createRadialGradient(0,0,0,0,0,1);mist.addColorStop(0,rgba(tint,lite?.2:.21));mist.addColorStop(.55,rgba(tint,lite?.09:.1));mist.addColorStop(.85,rgba(tint,lite?.04:.045));mist.addColorStop(1,rgba(tint,0));
      ctx.globalAlpha=dim;ctx.fillStyle=mist;ctx.beginPath();ctx.arc(0,0,1,0,Math.PI*2);ctx.fill();ctx.restore();
      ctx.globalAlpha=dim*(lite?.09:.1);ctx.strokeStyle=tint;ctx.lineWidth=7/scale;ctx.beginPath();ctx.ellipse(g.x,g.y,g.rx+4,g.ry+4,(g.angle||0)*Math.PI/180,0,Math.PI*2);ctx.stroke();
      ctx.globalAlpha=dim*(lite?.44:.5);ctx.strokeStyle=tint;ctx.lineWidth=.7/scale;ctx.setLineDash([2/scale,5/scale]);ctx.beginPath();ctx.ellipse(g.x,g.y,g.rx+4,g.ry+4,(g.angle||0)*Math.PI/180,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);
      ctx.globalAlpha=1;
    }
    for(const [key,batch] of edgeBatches()){
      ctx.strokeStyle=colors[batch.color];ctx.lineWidth=batch.width/scale;
      const a=key==='active'?lerp(state.strength/100,batch.alpha,focusDim):lerp(state.strength/100*batch.factor,.09,focusDim);
      ctx.globalAlpha=a;
      if(key==='active'){ctx.globalAlpha=a*.26;ctx.lineWidth=(batch.width+3.2)/scale;ctx.stroke(batch.path);ctx.globalAlpha=a;ctx.lineWidth=batch.width/scale;}
      ctx.stroke(batch.path);if(key==='active')ctx.stroke(batch.arrows);
    }
    for(const n of graph.nodes){
      if(n.x<left-40||n.x>right+40||n.y<top-40||n.y>bottom+40)continue;
      ctx.globalAlpha=shownNear&&!shownNear.has(n.id)?lerp(1,.22,focusDim):1;const image=sprite(n);ctx.drawImage(image.surface,n.x-image.size/2,n.y-image.size/2,image.size,image.size);
      if(n.id===state.selected||n.id===state.active){const a=ctx.globalAlpha;ctx.strokeStyle=colors['edge-active'];ctx.globalAlpha=a*.16;ctx.lineWidth=5.5/scale;ctx.beginPath();ctx.arc(n.x,n.y,n.r+4,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=a;ctx.lineWidth=1.1/scale;ctx.beginPath();ctx.arc(n.x,n.y,n.r+4,0,Math.PI*2);ctx.stroke();}
      if(n.id===state.selected){ctx.globalAlpha=.55;ctx.setLineDash([3,12]);ctx.lineWidth=.7/scale;ctx.beginPath();ctx.arc(n.x,n.y,n.r+9,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);}
    }
    ctx.globalAlpha=1;ctx.font="10px 'Segoe UI','Microsoft YaHei',sans-serif";ctx.lineWidth=3.5;ctx.lineJoin='round';ctx.strokeStyle=colors['label-outline'];
    for(const n of graph.nodes){
      if(!n.labelShown||n.x<left-270||n.x>right||n.y<top-15||n.y>bottom+15)continue;
      ctx.fillStyle=n.id===state.active?colors.text:colors.label;const x=n.x+n.r+6,y=n.y+3.5;ctx.strokeText(n.label.textContent,x,y);ctx.fillText(n.label.textContent,x,y);
    }
    ctx.globalAlpha=1;pose={scale,tx,ty};cam={scale,tx,ty};dirty=false;
  }
  function stats(){const paths=edgeBatches();return {edges:[...paths.values()].reduce((n,b)=>n+b.count,0),activeEdges:paths.get('active')?.count??0,labels:graph?.nodes.filter(n=>n.labelShown).length??0,rasterizations,dim:focusDim};}
  return {theme,resize,setGraph,focus,draw,stats,settle:(scale,tx,ty)=>draw(scale,tx,ty,true)};
}
