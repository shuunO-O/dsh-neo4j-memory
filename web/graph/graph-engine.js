'use strict';
// Pure graph analysis. Input is only {id, type, name} nodes and {a,b,type} edges.
// Coordinates, fixture provenance and names never participate in community detection.
(function(root){
  function rng(seed){return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
  function neighbors(nodes,edges){const a=Array.from({length:nodes.length},()=>[]);for(const e of edges){a[e.a].push(e.b);a[e.b].push(e.a);}return a;}
  function weights(nodes,edges,correctHubs=true){
    const adj=neighbors(nodes,edges),threshold=Math.max(16,nodes.length*.07);
    const hubs=new Set(nodes.filter(n=>n.type==='Person'&&adj[n.id].length>=threshold).map(n=>n.id));
    return {adj,hubs,values:edges.map(e=>correctHubs&&(hubs.has(e.a)||hubs.has(e.b))?.035:1)};
  }
  function modularity(n,edges,w,labels){
    let m2=0;const degrees=Array(n).fill(0),tot=new Map(),inside=new Map();
    edges.forEach((e,i)=>{degrees[e.a]+=w[i];degrees[e.b]+=w[i];m2+=2*w[i];if(labels[e.a]===labels[e.b])inside.set(labels[e.a],(inside.get(labels[e.a])||0)+2*w[i]);});
    if(!m2)return 0;
    labels.forEach((c,i)=>tot.set(c,(tot.get(c)||0)+degrees[i]));
    let q=0;for(const [c,d] of tot)q+=(inside.get(c)||0)/m2-(d/m2)**2;return q;
  }
  // Multilevel Louvain local modularity optimization, not Leiden.
  function partition(n,edges,w){
    let graph=Array.from({length:n},()=>new Map()),labels=Array.from({length:n},(_,i)=>i);
    edges.forEach((e,i)=>{graph[e.a].set(e.b,(graph[e.a].get(e.b)||0)+w[i]);graph[e.b].set(e.a,(graph[e.b].get(e.a)||0)+w[i]);});
    const random=rng(177);
    for(let level=0;level<12;level++){
      const count=graph.length,community=Array.from({length:count},(_,i)=>i),degree=graph.map(a=>[...a.values()].reduce((x,y)=>x+y,0)),total=[...degree],m2=degree.reduce((x,y)=>x+y,0);
      if(!m2)break;
      for(let pass=0;pass<40;pass++){
        let moved=0;const order=Array.from({length:count},(_,i)=>i);
        for(let i=count-1;i>0;i--){const j=Math.floor(random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
        for(const i of order){
          if(!degree[i])continue;
          const old=community[i],links=new Map();
          for(const [j,value] of graph[i])if(j!==i)links.set(community[j],(links.get(community[j])||0)+value);
          total[old]-=degree[i];
          let best=old,bestGain=(links.get(old)||0)-degree[i]*total[old]/m2;
          for(const [c,value] of links){const gain=value-degree[i]*total[c]/m2;if(gain>bestGain+1e-10){best=c;bestGain=gain;}}
          community[i]=best;total[best]+=degree[i];if(best!==old)moved++;
        }
        if(!moved)break;
      }
      const ids=[...new Set(community)].sort((a,b)=>a-b),mapping=new Map(ids.map((c,i)=>[c,i]));
      const compact=community.map(c=>mapping.get(c));labels=labels.map(c=>compact[c]);
      if(ids.length===count)break;
      const next=Array.from({length:ids.length},()=>new Map());
      graph.forEach((a,i)=>{for(const [j,value] of a){const u=compact[i],v=compact[j];next[u].set(v,(next[u].get(v)||0)+value);}});graph=next;
    }
    // Split disconnected fragments that can occasionally remain after local moves.
    const adj=neighbors(Array(n),edges),out=Array(n).fill(-1);let c=0;
    for(let i=0;i<n;i++){if(out[i]!==-1)continue;const stack=[i];out[i]=c;while(stack.length){const u=stack.pop();for(const v of adj[u])if(out[v]===-1&&labels[v]===labels[i]){out[v]=c;stack.push(v);}}c++;}
    return out;
  }
  function rewire(edges,random){
    const result=edges.map(e=>({...e})),key=(a,b)=>a<b?`${a}:${b}`:`${b}:${a}`,seen=new Set(result.map(e=>key(e.a,e.b)));
    for(let i=0;i<edges.length*12;i++){
      const u=Math.floor(random()*result.length),v=Math.floor(random()*result.length);if(u===v)continue;
      const x=result[u],y=result[v];const [a,b]=random()<.5?[x.a,x.b]:[x.b,x.a], [c,d]=random()<.5?[y.a,y.b]:[y.b,y.a];
      if(new Set([a,b,c,d]).size!==4||seen.has(key(a,d))||seen.has(key(c,b)))continue;
      seen.delete(key(x.a,x.b));seen.delete(key(y.a,y.b));result[u]={...x,a,b:d};result[v]={...y,a:c,b};seen.add(key(a,d));seen.add(key(c,b));
    }return result;
  }
  function analyze(nodes,edges,correctHubs=true){
    const start=performance.now(),{adj,hubs,values}=weights(nodes,edges,correctHubs),labels=partition(nodes.length,edges,values),q=modularity(nodes.length,edges,values,labels);
    const nullScores=[];
    for(let i=0;i<3;i++){const shuffled=rewire(edges,rng(889+i)),w=weights(nodes,shuffled,correctHubs).values;nullScores.push(modularity(nodes.length,shuffled,w,partition(nodes.length,shuffled,w)));}
    const baseline=nullScores.reduce((a,b)=>a+b,0)/nullScores.length,margin=q-baseline,clear=margin>.055;
    const map=new Map();nodes.forEach(n=>{const c=labels[n.id];if(!map.has(c))map.set(c,[]);map.get(c).push(n.id);});
    return {adj,hubs,labels,q,baseline,margin,clear,groups:[...map.values()],milliseconds:performance.now()-start,correctHubs};
  }
  function fixture(total,scenario='memory',seed=2419){
    const random=rng(seed),nodes=[],edges=[],pairs=new Set();
    const terms=['摄影','咖啡','代码','森林','音乐','海边','阅读','设计','散步','电影','植物','旅行','学习','画画','雨声','朋友','笔记','计划','早餐','日落','故事','实验','车站','书店','旋律','运动','相遇','睡眠','写作','山路','晚餐','游戏','跑步','花园','考试','相机','工作','周末','健康','灵感'];
    const add=(type,name)=>{const n={id:nodes.length,type,name};nodes.push(n);return n.id;};
    const connect=(a,b,type)=>{if(a===b)return;const key=[a,b].sort((x,y)=>x-y).join(':');if(pairs.has(key))return;pairs.add(key);edges.push({a,b,type});};
    add('Person','共同人物 A');add('Person','共同人物 B');
    const eventCount=Math.floor(total*.41),personCount=Math.max(4,Math.floor(total*.018)),locationCount=Math.max(5,Math.floor(total*.03));
    for(let i=0;i<personCount;i++)add('Person',`朋友 ${i+1}`);
    const places=[];for(let i=0;i<locationCount;i++)places.push(add('Location',['书店','海边','公园','家中','咖啡馆'][i%5]+` ${Math.floor(i/5)+1}`));
    const concepts=[];while(nodes.length<total-eventCount){const i=concepts.length;concepts.push(add('Concept',terms[i%terms.length]+(i<terms.length?'':` · ${Math.floor(i/terms.length)+1}`)));}
    // A history of co-occurrence evolves through reuse and occasional new interests.
    // No hidden community IDs, topic buckets or node coordinates are produced.
    const co=new Map(concepts.map(i=>[i,new Set()]));let recent=[];
    for(let i=0;i<eventCount;i++){
      const revisit=recent.length&&random()<.68;
      const first=revisit?recent[Math.floor(random()*recent.length)]:concepts[Math.floor(random()*concepts.length)];
      const chosen=new Set([first]);const amount=2+Math.floor(random()*3);
      for(let j=0;j<amount;j++){
        const local=[...co.get(first)];const reuse=local.length&&random()<(scenario==='mixed'?.4:.91);
        chosen.add(reuse?local[Math.floor(random()*local.length)]:concepts[Math.floor(random()*concepts.length)]);
      }
      recent=[...chosen];const event=add('Event',`记忆 ${String(i+1).padStart(3,'0')} · ${nodes[first].name.split(' · ')[0]}`);
      for(const a of chosen){connect(event,a,'MENTIONS');for(const b of chosen)if(a!==b)co.get(a).add(b);}
      // Every event has the same protagonist; most also include the companion.
      connect(0,event,'PARTICIPATED_IN');if(random()<.78)connect(1,event,'PARTICIPATED_IN');
      if(random()<.35)connect(2+Math.floor(random()*personCount),event,'PARTICIPATED_IN');
      if(random()<.3)connect(event,places[Math.floor(random()*places.length)],'OCCURRED_AT');
    }
    if(scenario==='mixed')for(let i=0;i<total*.65;i++)connect(Math.floor(random()*total),Math.floor(random()*total),'ASSOCIATED');
    if(scenario==='random'){
      // Same nodes and exactly the same degree sequence, but relationships rewired.
      return {nodes,edges:rewire(edges,random).map(e=>({...e,type:'ASSOCIATED'}))};
    }
    if(scenario==='fragments'){
      const kept=edges.filter(e=>e.a>=2&&e.b>=2&&e.a%17!==0&&e.b%17!==0);
      return {nodes,edges:kept};
    }
    return {nodes,edges};
  }
  const radialLayout=typeof module!=='undefined'?require('./radial-layout.js'):root.RadialLayout;
  function layout(nodes,edges,analysis,options){return radialLayout(nodes,edges,analysis,options);}
  const api={fixture,analyze,layout,partition,modularity,weights,rewire,rng};
  if(typeof module!=='undefined')module.exports=api;else root.GraphEngine=api;
})(typeof window!=='undefined'?window:this);
