'use strict';
importScripts('radial-layout.js','graph-engine.js');
self.onmessage=({data})=>{
  try{
    const {nodes,edges,correctHubs,centerId,cachedAnalysis}=data,analysis=cachedAnalysis??GraphEngine.analyze(nodes,edges,correctHubs);
    const clusters=GraphEngine.layout(nodes,edges,analysis,{centerId});
    self.postMessage({nodes,edges,analysis,clusters});
  }catch{self.postMessage({error:'图谱计算失败，当前图谱未替换。'});}
};
