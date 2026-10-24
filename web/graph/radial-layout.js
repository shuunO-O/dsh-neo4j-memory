'use strict';
(function(root){
  // Topology decides communities; this module only places them around a person.
  function radialLayout(nodes,edges,analysis,options={}){
    const {adj,hubs}=analysis,cx=560,cy=410,outer=310,tau=Math.PI*2;
    const degree=nodes.map(n=>new Set(adj[n.id].filter(id=>id!==n.id)).size);
    const people=nodes.filter(n=>n.type==='Person').sort((a,b)=>degree[b.id]-degree[a.id]||a.id-b.id);
    const requested=people.find(n=>n.id===options.centerId),primary=requested??people[0]??null;
    const central=new Set(analysis.correctHubs?hubs:[]);if(primary)central.add(primary.id);
    analysis.centerId=primary?.id??null;analysis.requestedCenterId=requested?.id??null;analysis.layout='radial';
    const grouped=analysis.clear?analysis.groups.map(g=>g.filter(id=>!central.has(id))):[nodes.filter(n=>adj[n.id].length&&!central.has(n.id)).map(n=>n.id)];
    const loose=grouped.filter(g=>g.length<4).flat(),large=grouped.filter(g=>g.length>=4);
    const included=new Set([...large.flat(),...loose,...central]);for(const n of nodes)if(!included.has(n.id))loose.push(n.id);
    large.sort((a,b)=>b.length-a.length||a[0]-b[0]);
    const groups=large.map(ids=>({ids,loose:false}));if(loose.length)groups.push({ids:loose,loose:true});
    nodes.forEach(n=>{n.anchor=false;n.bridge=central.has(n.id);n.protagonist=n.id===primary?.id;n.r=n.protagonist?9:Math.min(6,2.2+Math.sqrt(adj[n.id].length)*.43)+(n.type==='Person'?.5:0);});
    const satellites=[...central].filter(id=>id!==primary?.id).sort((a,b)=>degree[b]-degree[a]||a-b);
    let centralRadius=0;
    if(primary){primary.x=cx;primary.y=cy;primary.c=-1;primary.anchor=true;}
    const satelliteOuter=Math.min(136,42+Math.sqrt(satellites.length)*8);
    satellites.forEach((id,i)=>{
      const n=nodes[id],angle=-Math.PI/2+i*2.399963229728653,r=Math.sqrt(36**2+(satelliteOuter**2-36**2)*(i+.5)/satellites.length);
      n.x=cx+Math.cos(angle)*r;n.y=cy+Math.sin(angle)*r;n.c=-1;n.anchor=true;centralRadius=Math.max(centralRadius,r);
    });
    const inner=primary?Math.max(60,centralRadius+24):0;
    const looseWidth=loose.length?Math.min(62,Math.max(28,loose.length*.24)):0;
    let extent=outer*Math.max(1,Math.sqrt(nodes.length/900),Math.sqrt(large.length/75));
    let groupOuter=extent-looseWidth-(loose.length&&large.length?14:0);
    // Pack separate disks, rather than stretching communities into adjacent wedges.
    if(analysis.clear&&large.length){
      let packed=false,factor=9.2;
      for(let attempt=0;attempt<32&&!packed;attempt++){
        const radii=large.map(g=>Math.max(16,Math.sqrt(g.length+4)*factor)),placed=[],grid=new Map(),gap=26,cell=radii[0]*2+gap;
        packed=true;
        for(let c=0;c<large.length;c++){
          const radius=radii[c],preferred=-Math.PI/2+c*2.399963229728653;
          const desired=Math.min(groupOuter-radius,inner+radius+40+(c%2)*25);
          let best=null,score=Infinity;
          for(let r=inner+radius+8;r<=groupOuter-radius;r+=7)for(let k=0;k<112;k++){
            const theta=k*tau/112+c*.013,x=cx+Math.cos(theta)*r,y=cy+Math.sin(theta)*r,gx=Math.floor(x/cell),gy=Math.floor(y/cell);
            let blocked=false;
            for(let dx=-1;dx<=1&&!blocked;dx++)for(let dy=-1;dy<=1&&!blocked;dy++)for(const other of grid.get(`${gx+dx}:${gy+dy}`)||[]){if((x-other.x)**2+(y-other.y)**2<(radius+other.radius+gap)**2){blocked=true;break;}}
            if(blocked)continue;
            const cost=(x-cx-Math.cos(preferred)*desired)**2+(y-cy-Math.sin(preferred)*desired)**2;
            if(cost<score){score=cost;best={x,y,radius};}
          }
          if(!best){packed=false;break;}
          placed.push(best);const key=`${Math.floor(best.x/cell)}:${Math.floor(best.y/cell)}`;if(!grid.has(key))grid.set(key,[]);grid.get(key).push(best);
        }
        if(packed)placed.forEach((p,i)=>Object.assign(groups[i],p,{rx:p.radius,ry:p.radius,angle:0}));
        else if(attempt<18)factor*=.94;
        else{extent*=1.075;groupOuter=extent-looseWidth-14;}
      }
      if(!packed)throw new Error('无法排布分区，请减少本次导入规模。');
    }
    analysis.bounds={cx,cy,radius:extent};
    groups.forEach((g,c)=>{
      const island=!g.loose&&analysis.clear;
      if(!island){g.x=cx;g.y=cy;g.rx=g.ry=g.loose?extent:groupOuter;g.angle=0;}
      const ranked=g.loose?[...g.ids]:[...g.ids].sort((a,b)=>degree[b]-degree[a]||a-b);
      const concept=ranked.find(id=>nodes[id].type==='Concept');if(island&&concept!==undefined)nodes[concept].anchor=true;
      const home=new Map();
      ranked.forEach((id,i)=>{
        const n=nodes[id],fraction=(i*.61803398875+.37)%1;
        const theta=g.loose?tau*(i+.28+fraction*.4)/ranked.length:i*2.399963229728653;
        const r0=island?0:g.loose&&large.length?groupOuter+12:inner,r1=island?g.radius-7:g.loose?extent-4:groupOuter;
        const radial=g.loose?.12+fraction*.78:(i+.3)/ranked.length;
        const radius=!primary&&nodes.length===1?0:Math.sqrt(r0*r0+(r1*r1-r0*r0)*radial)* (island?.91:1);
        n.c=c;n.x=g.x+Math.cos(theta)*radius;n.y=g.y+Math.sin(theta)*radius;home.set(id,{x:n.x,y:n.y});
      });
      const set=new Set(g.ids),local=edges.filter(e=>set.has(e.a)&&set.has(e.b));
      const fx=new Float64Array(nodes.length),fy=new Float64Array(nodes.length),cell=42;
      for(let pass=0;pass<(island?42:20);pass++){
        fx.fill(0);fy.fill(0);const grid=new Map();
        for(const id of g.ids){const n=nodes[id],key=`${Math.floor(n.x/cell)}:${Math.floor(n.y/cell)}`;if(!grid.has(key))grid.set(key,[]);grid.get(key).push(id);}
        for(const id of g.ids){
          const a=nodes[id],gx=Math.floor(a.x/cell),gy=Math.floor(a.y/cell);
          for(let x=gx-1;x<=gx+1;x++)for(let y=gy-1;y<=gy+1;y++)for(const j of grid.get(`${x}:${y}`)||[]){
            if(j<=id)continue;const b=nodes[j],dx=a.x-b.x,dy=a.y-b.y,d2=dx*dx+dy*dy+.1,d=Math.sqrt(d2);if(d>42)continue;
            const power=Math.min(2.8,32/d2)+(d<a.r+b.r+5?(a.r+b.r+5-d)*.4:0),px=dx/d*power,py=dy/d*power;
            fx[id]+=px;fy[id]+=py;fx[j]-=px;fy[j]-=py;
          }
        }
        for(const e of local){const a=nodes[e.a],b=nodes[e.b],dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1,p=(d-23)*(island?.007:.001);fx[a.id]+=dx/d*p;fy[a.id]+=dy/d*p;fx[b.id]-=dx/d*p;fy[b.id]-=dy/d*p;}
        for(const id of g.ids){
          const n=nodes[id],h=home.get(id),stiffness=island?.065:.12;
          n.x+=Math.max(-2,Math.min(2,fx[id]+(h.x-n.x)*stiffness));n.y+=Math.max(-2,Math.min(2,fy[id]+(h.y-n.y)*stiffness));
          const dx=n.x-g.x,dy=n.y-g.y,d=Math.hypot(dx,dy)||1;
          const r0=island?0:g.loose&&large.length?groupOuter+12:inner,r1=island?g.radius-7:g.loose?extent-4:groupOuter;
          const radius=!primary&&nodes.length===1?0:Math.max(r0,Math.min(r1,d));n.x=g.x+dx/d*radius;n.y=g.y+dy/d*radius;
        }
      }
    });
    return groups;
  }
  if(typeof module!=='undefined')module.exports=radialLayout;else root.RadialLayout=radialLayout;
})(typeof window!=='undefined'?window:typeof self!=='undefined'?self:{});
