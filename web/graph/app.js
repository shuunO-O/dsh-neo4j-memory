'use strict';
// Authenticated Neo4j viewer. Imported files stay in this browser.
// Embedded in the settings column (?embed=1) the page drops its own title and footer, because
// the settings page already renders heading and intro above the frame.
if(new URLSearchParams(location.search).get('embed')==='1')document.body.dataset.embed='1';
const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const darkPalette={Concept:'#7fd6ba',Event:'#e9bb72',Person:'#b6a9ef',Location:'#e5a4ba',Other:'#9fb6c4'};
const lightPalette={Concept:'#3f8f73',Event:'#a97c3c',Person:'#7967b3',Location:'#b26d89',Other:'#6c7f8b'};
const palette={...darkPalette};
const typeNames = { Concept:'概念', Event:'事件', Person:'人物', Location:'地点', Other:'其他' };
let nodes=[],edges=[],adj=[],clusters=[],selected=null,hovered=null,scale=1,tx=0,ty=0,drag=null,analysis=null;
let graphDocument=null,sourceKind='server',sourceName='Neo4j',activeWorker=null,workerReject=null,activeRequest=null,job=0,busy=false;
let committedLabels=['Event','Person','Concept','Location'];
let cameraFrame=null,cameraTarget=null;
let inputFrame=null,paintState=null,labelOrder=[],relatedEdges=[],tipState=null;
let strokeScale=1,strokeTimer=null;
let renderer=null;
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function element(tag,attrs,parent){const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);if(parent)parent.appendChild(e);return e;}
function nodeProperty(n,key){return n.raw?.[key]??n.raw?.properties?.[key];}
function fieldText(value){return value==null?'':typeof value==='object'?value.value??JSON.stringify(value):String(value);}
function makeStarfield(){
  // A fixed decorative sky, independent of imported graph data and layout.
  for(const [type,color] of Object.entries(palette)){
    const gradient=element('radialGradient',{id:`nodeGlow${type}`},$('map').querySelector('defs'));
    for(const [offset,opacity] of [[0,.42],[.38,.15],[1,0]])element('stop',{offset,'stop-color':color,'stop-opacity':opacity},gradient);
  }
  let seed=7301;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const sky=$('starfield');
  // 远景星尘：细小、安静、不抢戏
  for(let i=0;i<260;i++){
    element('circle',{cx:random()*1120,cy:random()*800,r:.2+random()*.45,class:'sky-dust',style:`opacity:${(.06+random()*.14).toFixed(2)}`},sky);
  }
  // 两处疏散星团，让背景星空自己也有“区域”
  for(const [cx,cy,spread,count] of [[205,610,46,16],[905,180,52,18]]){
    for(let i=0;i<count;i++){
      element('circle',{cx:cx+(random()+random()-1)*spread,cy:cy+(random()+random()-1)*spread,r:.25+random()*.55,class:'sky-dust',style:`opacity:${(.12+random()*.2).toFixed(2)}`},sky);
    }
  }
  for(let i=0;i<170;i++){
    const x=random()*1120,y=random()*800,r=.35+random()*.8;
    const star=element('g',{class:i%9===0?'sky-star twinkle':'sky-star',style:`--star-opacity:${(.16+random()*.35).toFixed(2)};--twinkle-duration:${8+random()*9}s;--twinkle-delay:${-random()*17}s`},sky);
    element('circle',{cx:x,cy:y,r},star);
    if(i%21===0)element('path',{d:`M${x-3.5},${y}h7 M${x},${y-3.5}v7`,class:'sky-glint'},star);
  }
  // 近景亮星：光晕 + 长星芒 + 缓慢明灭
  for(let i=0;i<14;i++){
    const x=random()*1120,y=random()*800,r=1.1+random()*.9;
    const star=element('g',{class:'sky-hero',style:`--star-opacity:${(.45+random()*.3).toFixed(2)};--twinkle-duration:${11+random()*9}s;--twinkle-delay:${-random()*17}s`},sky);
    element('circle',{cx:x,cy:y,r:r*3.2,class:'sky-hero-halo'},star);
    element('circle',{cx:x,cy:y,r},star);
    element('path',{d:`M${x-6.5},${y}h13 M${x},${y-6.5}v13`,class:'sky-glint hero-glint'},star);
  }
}
function prepareGraph(data,cachedAnalysis=null,centerId=$('centerPerson').value==='auto'?null:Number($('centerPerson').value)){
  const analysis=cachedAnalysis?structuredClone(cachedAnalysis):GraphEngine.analyze(data.nodes,data.edges,$('hubCorrection').checked);
  const clusters=GraphEngine.layout(data.nodes,data.edges,analysis,{centerId});
  return {nodes:data.nodes,edges:data.edges,analysis,clusters};
}
function applyGraph(result,document){
  selected=null;hovered=null;$('tooltip').hidden=true;
  ({nodes,edges,analysis,clusters}=result);adj=analysis.adj;graphDocument=document;
  paintState=null;tipState=null;
  labelOrder=[...nodes].sort((a,b)=>(b.anchor-a.anchor)||(adj[b.id].length-adj[a.id].length));
  relatedEdges=nodes.map(()=>[]);
  const parallel=new Map();
  edges.forEach(e=>{relatedEdges[e.a].push(e);if(e.a!==e.b)relatedEdges[e.b].push(e);e.cross=nodes[e.a].c!==nodes[e.b].c;e.hub=analysis.hubs.has(e.a)||analysis.hubs.has(e.b);const key=[e.a,e.b].sort((a,b)=>a-b).join(':');if(!parallel.has(key))parallel.set(key,[]);parallel.get(key).push(e);});
  for(const group of parallel.values())group.forEach((e,i)=>{e.curve=(i-(group.length-1)/2)*18;e.loop=i;});
}
function render(){
  for(const id of ['halos','edges','nodes','labels'])$(id).replaceChildren();
  clusters.forEach(t=>{
    if(!t.loose&&analysis.clear)element('ellipse',{cx:t.x,cy:t.y,rx:t.rx+5,ry:t.ry+5,transform:`rotate(${t.angle||0} ${t.x} ${t.y})`,class:'halo'},$('halos'));

  });
  edges.forEach(e=>{
    const a=nodes[e.a],b=nodes[e.b],mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
    const length=Math.hypot(b.x-a.x,b.y-a.y)||1,bend=(e.cross?.055:.025)+e.curve/length*(e.a<=e.b?1:-1);
    const radius=19+e.loop*10;
    const path=e.a===e.b?`M${a.x-3},${a.y-2} C${a.x-radius*2},${a.y-radius*2} ${a.x+radius*2},${a.y-radius*2} ${a.x+3},${a.y-2}`:`M${a.x},${a.y} Q${mx-(b.y-a.y)*bend},${my+(b.x-a.x)*bend} ${b.x},${b.y}`;
    e.path=path;e.el=renderer?null:element('path',{d:path,class:'edge'},$('edges'));
  });
  nodes.forEach(n=>{
    n.el=element('g',{class:`node ${n.type.toLowerCase()}${n.protagonist?' protagonist':''}`,style:`color:${palette[n.type]}`,transform:`translate(${n.x},${n.y})`,'data-id':n.id,role:'button',tabindex:n.anchor?0:-1,'aria-label':`${n.name}，${typeNames[n.type]}，${adj[n.id].length}条连接${n.protagonist?'，中心人物':''}`},$('nodes'));
    element('circle',{r:Math.max(7,n.r+2),class:'hit'},n.el);
    if(!renderer){
    element('circle',{r:n.r*2.8,fill:`url(#nodeGlow${n.type})`,class:'node-bloom'},n.el);
    element('circle',{r:n.r+7,class:'arrival-wave'},n.el);
    element('circle',{r:n.r+9,class:'node-orbit'},n.el);
    element('circle',{r:n.r+4,class:'node-ring'},n.el);
    if(n.protagonist)element('circle',{r:n.r+15,class:'central-ring'},n.el);
    if(n.type==='Location')element('rect',{x:-n.r*.8,y:-n.r*.8,width:n.r*1.6,height:n.r*1.6,rx:1.2,transform:'rotate(45)',fill:palette[n.type],class:'dot'},n.el);
    else element('circle',{r:n.type==='Person'?n.r*.65:n.r,fill:palette[n.type],class:'dot'},n.el);
    element('circle',{r:n.protagonist?2:Math.min(.95,n.r*.28),class:'star-core'},n.el);
    if(n.anchor||n.type==='Event'){
      const ray=n.r+2.5; element('path',{d:`M${-ray},0 H${ray} M0,${-ray} V${ray}`,class:'node-rays'},n.el);
    }
    }
    n.label=renderer?{textContent:'',style:{}}:element('text',{x:n.x+n.r+6,y:n.y+3.5,class:'node-label'},$('labels'));n.label.textContent=n.name.length>26?n.name.slice(0,25)+'…':n.name;
    n.labelBox={x:n.x+n.r+6,y:n.y-7,w:[...n.label.textContent].length*9+8,h:15};
    n.el.addEventListener('pointerenter',e=>{if(drag||cameraFrame!==null)return;hovered=n.id;paint();showTooltip(n,e);});
    n.el.addEventListener('pointermove',e=>{if(!drag&&cameraFrame===null)showTooltip(n,e);});
    n.el.addEventListener('pointerleave',()=>{if(hovered===n.id){hovered=null;$('tooltip').hidden=true;paint();}});
    n.el.addEventListener('click',e=>{if(drag?.moved)return;e.stopPropagation();selectNode(n.id);});
    n.el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectNode(n.id);}});
    n.el.addEventListener('focus',()=>{hovered=n.id;paint();});
    n.el.addEventListener('blur',()=>{if(hovered===n.id){hovered=null;paint();}});
  });
  $('count').textContent=`${nodes.length.toLocaleString()} 节点 · ${edges.length.toLocaleString()} 连接`;
  showEmpty('这里还没有节点。',sourceKind==='server'?'当前筛选下暂无记忆，也可导入本地图谱查看。':'导入的图谱没有节点。');
  renderer?.setGraph({nodes,edges,clusters,analysis});updateViewBox(false);
  fit(false);showIntro();updateSource();
}
function paint(renderNow=true){
  const active=hovered??selected,tier=scale>2.8?2:scale>1.65?1:0,strength=Number($('strength').value);
  const focusChanged=!paintState||paintState.active!==active||paintState.selected!==selected;
  const edgesChanged=!paintState||paintState.active!==active||paintState.strength!==strength;
  if(!focusChanged&&!edgesChanged&&paintState.tier===tier)return;
  const near=active===null?null:new Set([active,...adj[active]]),opacity=strength/100;
  if(edgesChanged&&!renderer)edges.forEach(e=>{
    const connected=active!==null&&(e.a===active||e.b===active),muted=active!==null&&!connected;
    const visual=connected?(adj[active].length>50?'hub-active':'active'):muted?'muted':`normal:${strength}`;
    if(e.visual===visual)return;e.visual=visual;
    e.el.style.opacity=active===null?opacity*(e.hub?.15:e.cross?.48:1):connected?(adj[active].length>50?.55:.92):.09;
    e.el.style.stroke=connected?'var(--edge-active)':e.cross?'var(--edge-cross)':'var(--edge)';e.el.style.strokeWidth=`calc(${connected?(adj[active].length>50?'.8':'1.1'):'.6'}px / var(--stroke-scale, 1))`;
    if(connected)e.el.setAttribute('marker-end','url(#arrow)');else e.el.removeAttribute('marker-end');
  });
  if(!focusChanged&&paintState.tier===tier){paintState={active,selected,strength,tier};renderer?.focus({active,selected,near,strength,tier});if(renderNow)renderer?.draw(scale,tx,ty);return;}
  // Label boxes are fixed in world coordinates; panning cannot change collisions.
  // A small spatial grid avoids comparing every label with every other label.
  const grid=new Map(),cell=32;
  const cells=box=>{const keys=[];for(let x=Math.floor(box.x/cell);x<=Math.floor((box.x+box.w)/cell);x++)for(let y=Math.floor(box.y/cell);y<=Math.floor((box.y+box.h)/cell);y++)keys.push(`${x}:${y}`);return keys;};
  const ordered=active===null?labelOrder:[nodes[active],...labelOrder.filter(n=>n.id!==active)];
  ordered.forEach(n=>{
    if(focusChanged){if(!renderer)n.el.style.opacity=near?(near.has(n.id)?1:.35):1;n.el.classList.toggle('selected',n.id===selected);n.el.classList.toggle('highlighted',n.id===active);}
    const eligible=near?near.has(n.id):(n.anchor||tier===1&&adj[n.id].length>=4||tier===2);
    let show=false;
    if(eligible){const box=n.labelBox,keys=cells(box),collision=keys.some(key=>(grid.get(key)||[]).some(b=>box.x<b.x+b.w&&box.x+box.w>b.x&&box.y<b.y+b.h&&box.y+box.h>b.y));
      show=!collision||n.id===active;if(show)for(const key of keys){if(!grid.has(key))grid.set(key,[]);grid.get(key).push(box);}
    }
    if(n.labelShown!==show){n.label.style.display=show?'':'none';n.labelShown=show;}
    if(focusChanged&&!renderer)n.label.style.fill=n.id===active?'var(--text)':'var(--label)';
  });
  $('halos').style.opacity=active===null?1:.55;
  paintState={active,selected,strength,tier};
  renderer?.focus({active,selected,near,strength,tier});if(renderNow)renderer?.draw(scale,tx,ty);
}
function showTooltip(n,e){
  const tip=$('tooltip');
  if(!tipState||tipState.id!==n.id||tip.hidden){
    tip.replaceChildren(document.createTextNode(n.name));const small=document.createElement('small');small.textContent=`${typeNames[n.type]} · ${adj[n.id].length} 条连接`;tip.append(small);tip.hidden=false;
    tipState={id:n.id,rect:$('map').getBoundingClientRect(),width:tip.offsetWidth,height:tip.offsetHeight};
  }
  const {rect,width,height}=tipState;
  tip.style.left=Math.max(8,Math.min(e.clientX-rect.left+15,rect.width-width-10))+'px';tip.style.top=Math.max(8,Math.min(e.clientY-rect.top+16,rect.height-height-10))+'px';
}
function updateViewBox(drawNow=true){
  const r=analysis?.bounds?.radius??310,w=innerWidth<=650?Math.max(700,r*2+80):Math.max(1120,r*2+200),h=innerWidth<=650?Math.max(690,r*2+80):Math.max(800,r*2+100);
  $('map').setAttribute('viewBox',r<=310?(innerWidth<=650?'210 65 700 690':'0 0 1120 800'):`${560-w/2} ${410-h/2} ${w} ${h}`);
  tipState=null;$('tooltip').hidden=true;renderer?.resize();if(drawNow)renderer?.draw(scale,tx,ty);
}
addEventListener('resize',updateViewBox);
function updateSource(){
  $('sourceBadge').textContent=sourceKind==='local'?'本地导入':'Neo4j';
  for(const input of $('labelFilters').querySelectorAll('input'))input.disabled=busy||sourceKind==='local';
  const choice=$('centerPerson'),previous=choice.value;
  choice.replaceChildren(new Option('自动选择','auto'));
  const degree=new Map(nodes.filter(n=>n.type==='Person').map(n=>[n.id,new Set(adj[n.id].filter(id=>id!==n.id)).size]));
  const people=nodes.filter(n=>n.type==='Person').sort((a,b)=>degree.get(b.id)-degree.get(a.id)||a.id-b.id);
  for(const n of people)choice.append(new Option(n.name,String(n.id)));
  if(people.some(n=>String(n.id)===previous))choice.value=previous;
  choice.disabled=busy||!people.length;
}
function showIntro(){
  $('detail').classList.remove('has-selection');$('detail').replaceChildren();
  const count=analysis.clear?clusters.filter(g=>!g.loose).length:0;
  $('groupCount').textContent=count?`${count} 个连接区域`:'连接交织';
  $('analysisStatus').textContent=analysis.clear?'依据连接结构分区，暂不命名区域。':'当前分区依据较弱，保持完整网络。';
  $('diagnosticValues').innerHTML=`<dl><dt>结构分数</dt><dd>${analysis.q.toFixed(3)}</dd><dt>随机参照</dt><dd>${analysis.baseline.toFixed(3)}</dd><dt>差值</dt><dd>${analysis.margin.toFixed(3)}</dd></dl><p>与 3 次保留连接数量的随机重连比较。仅作布局参考，不代表主题分类。</p>`;
}
function selectNode(id){
  $('viewSettings').open=false;
  selected=id;hovered=null;$('tooltip').hidden=true;$('results').hidden=true;paint();
  const n=nodes[id],related=relatedEdges[id],neighbors=[...new Set(adj[id])].map(i=>nodes[i]);$('detail').classList.add('has-selection');
  const summary=fieldText(nodeProperty(n,'summary')),content=fieldText(nodeProperty(n,'content'));
  const created=fieldText(nodeProperty(n,'create_time')??nodeProperty(n,'created_time')??nodeProperty(n,'start_time'));
  const subtype=fieldText(nodeProperty(n,'type'));
  const summarySection=summary?`<section class="detail-section"><h3>摘要</h3><div class="summary-text">${esc(summary)}</div></section>`:n.type==='Event'?'<p class="missing-summary">当前数据未包含事件摘要。</p>':'';
  const contentSection=content?`<details class="detail-section"><summary>正文</summary><div class="content-text">${esc(content)}</div></details>`:'';
  $('detail').innerHTML=`<div class="detail-top"><span>节点详情</span><button id="closeDetail" aria-label="关闭节点详情">×</button></div><div class="detail-type"><i style="background:${palette[n.type]}"></i>${typeNames[n.type]}${n.bridge?' · 共同人物':''}</div><h2>${esc(n.name)}</h2><div class="node-id">${esc(n.originalId)}</div><div class="metric-row"><div><strong>${related.length}</strong><span>关联关系</span></div><div><strong>${neighbors.length}</strong><span>相连节点</span></div></div>${summarySection}${created||subtype&&subtype!==n.type?`<dl class="metadata">${created?`<dt>时间</dt><dd>${esc(created)}</dd>`:''}${subtype&&subtype!==n.type?`<dt>类型</dt><dd>${esc(subtype)}</dd>`:''}</dl>`:''}${contentSection}<details class="node-properties"><summary>全部属性</summary><pre id="nodeProperties"></pre></details><div class="related-title">关联节点</div><div id="neighbors"></div><div class="detail-actions"><button id="focusSelected">聚焦此节点 ⤢</button></div>`;
  $('nodeProperties').textContent=JSON.stringify(n.raw,null,2);
  let shown=0;const more=document.createElement('button');more.className='more-relations';
  function addRelations(){
   const next=Math.min(related.length,shown+60),fragment=document.createDocumentFragment();
   related.slice(shown,next).forEach(e=>{
    const nb=nodes[e.a===id?e.b:e.a],b=document.createElement('button');b.className='neighbor';
    b.innerHTML=`<i style="background:${palette[nb.type]}"></i><span>${esc(nb.name)}</span><small>${e.a===e.b?'↻':e.a===id?'→':'←'} ${esc(e.type)}</small>`;
    b.title=JSON.stringify(e.raw,null,2);b.onclick=()=>{selectNode(nb.id);centerNode(nb);};fragment.append(b);
    if(e.raw?.properties&&Object.keys(e.raw.properties).length){const p=document.createElement('div');p.className='relation-properties';p.textContent=JSON.stringify(e.raw.properties);fragment.append(p);}
  });
   shown=next;$('neighbors').append(fragment);more.hidden=shown===related.length;more.textContent=`展开更多关系（剩余 ${related.length-shown} 条）`;
  }
  more.onclick=addRelations;$('neighbors').after(more);addRelations();
  $('closeDetail').onclick=clearSelection;$('focusSelected').onclick=()=>centerNode(n);
}
function clearSelection(){cancelCamera();selected=null;hovered=null;$('tooltip').hidden=true;paint();showIntro();}
let hitTimer=null;
function syncHitTargets(){clearTimeout(hitTimer);hitTimer=null;$('viewport').setAttribute('transform',`translate(${tx},${ty}) scale(${scale})`);$('viewport').style.display='';}
function transform(updateLabels=true){
  // Invisible SVG targets still trigger expensive browser geometry work. Suspend
  // them while the camera moves, then restore their current positions on arrival.
  if(renderer){clearTimeout(hitTimer);$('viewport').style.display='none';hitTimer=setTimeout(syncHitTargets,110);}
  else syncHitTargets();
  $('zoomValue').value=`${Math.round(scale*100)}%`;if(updateLabels)paint(false);renderer?.draw(scale,tx,ty);
}
function syncStrokeScale(){clearTimeout(strokeTimer);if(strokeScale===scale)return;strokeScale=scale;$('edges').style.setProperty('--stroke-scale',scale);}
function scheduleStrokeSync(){clearTimeout(strokeTimer);strokeTimer=setTimeout(()=>{syncStrokeScale();renderer?.settle(scale,tx,ty);},110);}
function flushInput(){if(inputFrame!==null)cancelAnimationFrame(inputFrame);inputFrame=null;transform();}
function scheduleInput(){if(inputFrame===null)inputFrame=requestAnimationFrame(()=>{inputFrame=null;transform();});}
function motionEnabled(){return $('motion').checked&&!reducedMotion.matches;}
function cancelCamera(){
  if(cameraFrame!==null)cancelAnimationFrame(cameraFrame);
  cameraFrame=null;cameraTarget=null;$('map').removeAttribute('data-moving');
}
function moveCamera(target,animate=true){
  clearTimeout(strokeTimer);
  if(inputFrame!==null)flushInput();
  cancelCamera();
  const start={scale,tx,ty};
  if(!animate||!motionEnabled()||(Math.abs(target.tx-tx)+Math.abs(target.ty-ty)<.1&&Math.abs(target.scale-scale)<.001)){
    ({scale,tx,ty}=target);syncStrokeScale();transform();syncHitTargets();return;
  }
  hovered=null;$('tooltip').hidden=true;paint();
  cameraTarget=target;$('map').setAttribute('data-moving','true');
  const distance=Math.hypot(target.tx-tx,target.ty-ty),duration=Math.min(420,220+distance*.12),started=performance.now();
  function step(now){
    const t=Math.min(1,(now-started)/duration),ease=1-Math.pow(1-t,3);
    scale=Math.exp(Math.log(start.scale)+(Math.log(target.scale)-Math.log(start.scale))*ease);
    tx=start.tx+(target.tx-start.tx)*ease;ty=start.ty+(target.ty-start.ty)*ease;
    // Only update the camera each frame; label collision checks run once on arrival.
    transform(false);
    if(t<1)cameraFrame=requestAnimationFrame(step);
    else{cameraFrame=null;cameraTarget=null;$('map').removeAttribute('data-moving');syncStrokeScale();transform();syncHitTargets();renderer?.settle(scale,tx,ty);}
  }
  cameraFrame=requestAnimationFrame(step);
}
function fit(animate=true){moveCamera({scale:1,tx:0,ty:0},animate);}
function centerNode(n){
  const rect=$('map').getBoundingClientRect(),detail=$('detail').getBoundingClientRect();
  let x=rect.left+rect.width/2,y=rect.top+rect.height/2;
  if($('detail').classList.contains('has-selection')){
    if(innerWidth>650)x=rect.left+(detail.left-rect.left)/2;
    else y=rect.top+(80+Math.max(80,detail.top-rect.top))/2;
  }
  const center=point({clientX:x,clientY:y}),next=Math.max(scale,1.8);
  moveCamera({scale:next,tx:center.x-n.x*next,ty:center.y-n.y*next});
}
function zoom(factor,x=560,y=400,animate=false){
  const start=animate&&cameraTarget?cameraTarget:{scale,tx,ty},next=Math.max(.55,Math.min(4.5,start.scale*factor));
  const target={scale:next,tx:x-(x-start.tx)*next/start.scale,ty:y-(y-start.ty)*next/start.scale};
  if(animate)moveCamera(target,true);
  else{cancelCamera();({scale,tx,ty}=target);scheduleInput();scheduleStrokeSync();}
}
function point(e,matrix){const p=$('map').createSVGPoint();p.x=e.clientX;p.y=e.clientY;return p.matrixTransform(matrix??$('map').getScreenCTM().inverse());}
$('map').addEventListener('wheel',e=>{e.preventDefault();const p=point(e),unit=e.deltaMode===1?16:e.deltaMode===2?$('map').clientHeight:1;zoom(Math.exp(-e.deltaY*unit*.001),p.x,p.y);},{passive:false});
$('map').addEventListener('pointerdown',e=>{if(e.button!==0)return;cancelCamera();if(inputFrame!==null)flushInput();syncStrokeScale();const matrix=$('map').getScreenCTM().inverse(),p=point(e,matrix);drag={x:p.x,y:p.y,tx,ty,matrix,moved:false};});
$('map').addEventListener('pointermove',e=>{if(!drag)return;const p=point(e,drag.matrix);if(drag.moved||Math.hypot(p.x-drag.x,p.y-drag.y)>2){if(!drag.moved){drag.moved=true;$('map').setPointerCapture(e.pointerId);$('tooltip').hidden=true;hovered=null;}tx=drag.tx+p.x-drag.x;ty=drag.ty+p.y-drag.y;scheduleInput();}});
$('map').addEventListener('pointerup',()=>{const wasMoved=drag?.moved;if(wasMoved)flushInput();syncHitTargets();setTimeout(()=>{drag=null;},0);if(wasMoved)$('tooltip').hidden=true;});
$('map').addEventListener('pointercancel',()=>{if(inputFrame!==null)flushInput();syncHitTargets();drag=null;});
$('map').addEventListener('click',e=>{if(drag?.moved||hitTimer!==null)return;if(!e.target.closest('.node'))clearSelection();});
$('plus').onclick=()=>zoom(1.25);$('minus').onclick=()=>zoom(.8);$('fit').onclick=()=>fit();$('strength').oninput=paint;
function updateMotion(){
  document.body.dataset.motion=motionEnabled()?'on':'off';
  if(!motionEnabled()&&cameraTarget)moveCamera({...cameraTarget},false);
}
$('motion').onchange=updateMotion;reducedMotion.addEventListener('change',updateMotion);
function reflow(){if(!busy&&graphDocument)loadDocument(GraphIO.normalize(graphDocument),sourceName,{preserveSource:true});}
$('hubCorrection').onchange=reflow;
$('centerPerson').onchange=()=>{if(!busy&&graphDocument)loadDocument(GraphIO.normalize(graphDocument),sourceName,{reuseAnalysis:true,preserveSource:true});};
$('search').addEventListener('focus',()=>{$('viewSettings').open=false;});
$('search').addEventListener('input',()=>{
  const q=$('search').value.trim(),box=$('results');box.replaceChildren();box.hidden=!q;if(!q)return;
  const matches=nodes.filter(n=>n.name.includes(q)||fieldText(nodeProperty(n,'summary')).includes(q)).sort((a,b)=>(b.name===q)-(a.name===q)||b.name.includes(q)-a.name.includes(q)).slice(0,20);
  if(!matches.length){const p=document.createElement('p');p.textContent='没有找到相关节点';box.append(p);}
  matches.forEach(n=>{const b=document.createElement('button');b.append(document.createTextNode(n.name));const small=document.createElement('small');small.textContent=typeNames[n.type];b.append(small);b.onclick=()=>{selectNode(n.id);centerNode(n);};box.append(b);});
});
$('search').addEventListener('keydown',e=>{if(e.key==='Enter')$('results').querySelector('button')?.click();if(e.key==='Escape')$('results').hidden=true;});
document.addEventListener('keydown',e=>{if(e.key==='/'&&!e.target.closest('input,textarea,select')){e.preventDefault();$('search').focus();}if(e.key==='Escape'){clearSelection();$('results').hidden=true;}});
document.addEventListener('click',e=>{if(!e.target.closest('.search-wrap'))$('results').hidden=true;});
function status(message,error=false){$('dataStatus').textContent=message;$('dataStatus').classList.toggle('error',error);}
function setBusy(value){
  busy=value;for(const id of ['importGraph','refreshGraph','hubCorrection'])$(id).disabled=value;
  $('exportGraph').disabled=value||!graphDocument;
  $('cancelImport').hidden=!value;updateSource();
}
function computeAsync(data,cachedAnalysis=null,centerId=null){
  if(location.protocol==='file:'||typeof Worker==='undefined')return new Promise((resolve,reject)=>setTimeout(()=>{try{resolve(prepareGraph(data,cachedAnalysis,centerId));}catch(e){reject(e);}},30));
  return new Promise((resolve,reject)=>{
    const worker=new Worker('graph-worker.js?v=12');activeWorker=worker;workerReject=reject;
    const finish=()=>{worker.terminate();if(activeWorker===worker){activeWorker=null;workerReject=null;}};
    worker.onmessage=({data})=>{finish();if(data.error)reject(new Error(data.error));else resolve(data);};
    worker.onerror=()=>{finish();reject(new Error('后台计算无法启动，请通过本地预览地址打开页面。'));};
    worker.postMessage({nodes:data.nodes,edges:data.edges,cachedAnalysis,correctHubs:$('hubCorrection').checked,centerId});
  });
}
function showEmpty(message,detail){
  const empty=$('emptyState');empty.replaceChildren(document.createTextNode(message));
  const small=document.createElement('small');small.textContent=detail;empty.append(small);empty.hidden=nodes.length>0;
}
function selectedLabels(){return [...$('labelFilters').querySelectorAll('input:checked')].map(input=>input.value);}
function restoreControls(){
  $('hubCorrection').checked=analysis.correctHubs;
  $('centerPerson').value=String(analysis.requestedCenterId??'auto');
  for(const input of $('labelFilters').querySelectorAll('input'))input.checked=committedLabels.includes(input.value);
}
async function replaceGraph(getData,filename,options={}){
  const token=++job;setBusy(true);status(options.server?'正在读取记忆图谱…':'正在计算群落和布局…');
  const center=$('centerPerson').value==='auto'?null:nodes[Number($('centerPerson').value)];
  cancelCamera();
  try{
    const data=await getData();if(token!==job)return;
    status('正在计算群落和布局…');
    const preserveCenter=options.preserveSource||options.server&&sourceKind==='server';
    const centerId=preserveCenter&&center?data.nodes.find(n=>n.type==='Person'&&n.originalId===center.originalId)?.id??null:null;
    const result=await computeAsync(data,options.reuseAnalysis?analysis:null,centerId);if(token!==job)return;
    applyGraph(result,data.document);
    if(!options.preserveSource)sourceKind=options.server?'server':'local';
    if(options.server)committedLabels=selectedLabels();
    sourceName=filename;$('search').value='';$('results').hidden=true;render();
    $('centerPerson').value=String(analysis.requestedCenterId??'auto');
    status(`${filename} · ${nodes.length} 节点 / ${edges.length} 条关系${sourceKind==='local'?' · 仅本地':''}`);
  }catch(e){
    if(token===job){
      restoreControls();status(e.message==='unauthorized'?'请先在 dsh 中完成登录。':e.message,true);
      showEmpty(options.server?'暂时无法加载记忆图谱。':'无法导入图谱。',e.message==='unauthorized'?'请完成 dsh 登录后重试。':(e.message||'可点击刷新重试，或导入本地图谱。'));
    }
  }finally{if(token===job){activeRequest=null;setBusy(false);}}
}
function loadDocument(data,filename,options={}){return replaceGraph(()=>data,filename,options);}
function loadServerGraph(){
  if(busy)return;
  const labels=selectedLabels();activeRequest=new AbortController();
  return replaceGraph(async()=>{
    // The plugin serves this page and its data from the dsh web server; no host bridge needed.
    const query=labels.length?`?labels=${encodeURIComponent(labels.join(','))}`:'';
    let response;
    try{
      response=await fetch(`/dsh-neo4j-memory/graph.json${query}`,{signal:activeRequest.signal,headers:{Accept:'application/json'}});
    }catch(e){
      if(e.name==='AbortError')throw e;
      throw new Error('无法连接插件后端，请确认 dsh 已启动且插件已启用。');
    }
    if(response.status===401||response.status===403)throw new Error('unauthorized');
    if(!response.ok){
      let detail='';
      try{const failure=await response.json();detail=typeof failure?.error==='string'?failure.error:'';}catch{}
      throw new Error(detail||'memory graph request failed');
    }
    let payload;try{payload=await response.json();}catch{throw new Error('插件返回了无法解析的数据。');}
    if(payload.ok===false)throw new Error(payload.error||'Neo4j 暂不可用，请确认记忆数据库已配置并启动。');
    return GraphIO.normalize(payload);
  },'Neo4j',{server:true});
}
$('refreshGraph').onclick=loadServerGraph;
for(const input of $('labelFilters').querySelectorAll('input'))input.onchange=loadServerGraph;
$('importGraph').onclick=()=>{$('graphFile').value='';$('graphFile').click();};
$('graphFile').onchange=async()=>{
  const file=$('graphFile').files[0];if(!file||busy)return;
  try{
    if(/\.dump$/i.test(file.name))throw new Error('.dump 不能直接导入。请查看导入与导出说明，先恢复数据库并导出 JSON。');
    if(file.size>GraphIO.LIMITS.bytes)throw new Error('文件超过 20 MB，当前图谱未替换。');
    await replaceGraph(async()=>GraphIO.parse(await file.text(),file.name),file.name);
  }catch(e){status(e.message,true);}
};
$('cancelImport').onclick=()=>{job++;activeRequest?.abort();activeRequest=null;activeWorker?.terminate();activeWorker=null;workerReject?.(new Error('已取消'));workerReject=null;restoreControls();setBusy(false);status('已取消计算，当前图谱未替换。');};
$('exportGraph').onclick=()=>{
  const blob=new Blob([GraphIO.serialize(graphDocument)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='dsh-neo4j-memory-graph.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
  status('已导出图谱 JSON，可再次导入预览；该文件不是 Neo4j 数据库备份。');
};
$('dataHelp').onclick=()=>{$('viewSettings').open=false;$('importHelp').showModal();};$('closeHelp').onclick=()=>$('importHelp').close();
function applyTheme(){
  const light=document.body.dataset.theme==='light';Object.assign(palette,light?lightPalette:darkPalette);
  renderer?.theme(palette);
  for(const [type,color] of Object.entries(palette))for(const stop of $(`nodeGlow${type}`).children)stop.setAttribute('stop-color',color);
  for(const n of nodes){n.el.style.color=palette[n.type];n.el.querySelector('.dot')?.setAttribute('fill',palette[n.type]);}
  for(const [i,type] of ['Concept','Event','Person','Location'].entries())document.querySelectorAll('.legend i')[i].style.setProperty('--c',palette[type]);
  $('themeToggle').textContent=light?'☾':'☼';$('themeToggle').setAttribute('aria-label',light?'切换深色主题':'切换浅色主题');$('themeToggle').title=light?'切换深色主题':'切换浅色主题';
  if(selected!==null)selectNode(selected);paint();renderer?.draw(scale,tx,ty);
}
$('themeToggle').onclick=()=>{document.body.dataset.theme=document.body.dataset.theme==='light'?'dark':'light';applyTheme();};
document.addEventListener('click',e=>{if(!e.target.closest('#viewSettings'))$('viewSettings').open=false;});
renderer=createGraphRenderer($('graphCanvas'),$('map'));if(renderer){document.body.classList.add('canvas-rendered');renderer.theme(palette);}
updateViewBox();makeStarfield();updateMotion();
const emptyGraph=GraphIO.normalize({nodes:[],relationships:[]});
applyGraph(prepareGraph(emptyGraph),emptyGraph.document);render();
showEmpty('正在加载记忆图谱…','读取节点与连接后，在本地计算布局。');
window.DshMemoryGraph=Object.freeze({setActive(active){
  document.body.dataset.active=String(active);
  if(!active){cancelCamera();hovered=null;$('tooltip').hidden=true;}
  else updateViewBox();
}});
window.DshMemoryGraph.setActive(true);
loadServerGraph();
