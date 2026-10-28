'use strict';
(function(root){
  const LIMITS=Object.freeze({bytes:20*1024*1024,nodes:5000,edges:30000});
  const TYPES=['Event','Person','Concept','Location'];
  function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
  function key(id){if(typeof id==='string'&&id.length&&id.length<=1024)return `s:${id}`;if(Number.isSafeInteger(id))return `n:${id}`;throw new Error('节点和关系 ID 必须是非空字符串或安全整数。');}
  function properties(value){if(value!==undefined&&!object(value))throw new Error('properties 必须是 JSON 对象。');}
  function validateNumbers(value){
    const pending=[[value,0]];
    while(pending.length){const [v,depth]=pending.pop();if(depth>64)throw new Error('JSON 嵌套超过 64 层，无法导入。');
      if(typeof v==='number'&&(!Number.isFinite(v)||Number.isInteger(v)&&!Number.isSafeInteger(v)))throw new Error('包含超出浏览器精度范围的数字，请将大整数存为字符串或使用附带导出脚本。');
      if(v&&typeof v==='object')for(const child of Object.values(v))pending.push([child,depth+1]);
    }
  }
  function normalize(input){
    if(!object(input))throw new Error('需要包含 nodes 和 relationships 数组的 JSON 对象。');
    if(input.ok===false)throw new Error('这是一个失败的接口响应，未包含可导入的图谱。');
    const raw=object(input.data)&&input.nodes===undefined?input.data:input;
    validateNumbers(raw);
    if(raw.format!==undefined&&raw.format!=='dsh-neo4j-memory-graph'&&raw.format!=='tentacle-graph')throw new Error('不支持这个图谱文件格式。');
    if(raw.version!==undefined&&raw.version!==1)throw new Error('暂不支持这个图谱文件版本。');
    const rows=raw.nodes,rels=raw.relationships??raw.edges;
    if(!Array.isArray(rows)||!Array.isArray(rels))throw new Error('缺少 nodes 或 relationships 数组。');
    if(rows.length>LIMITS.nodes||rels.length>LIMITS.edges)throw new Error(`当前预览最多支持 ${LIMITS.nodes} 个节点、${LIMITS.edges} 条关系。文件未截断，当前图谱未替换。`);
    const ids=new Map(),nodes=[],records=[];
    rows.forEach((r,i)=>{
      if(!object(r))throw new Error(`第 ${i+1} 个节点不是对象。`);
      const k=key(r.id);if(ids.has(k))throw new Error(`第 ${i+1} 个节点的 ID 重复。`);ids.set(k,i);properties(r.properties);
      if(r.labels!==undefined&&(!Array.isArray(r.labels)||r.labels.some(l=>typeof l!=='string')))throw new Error('节点 labels 必须是字符串数组。');
      const labels=r.labels??(typeof r.label==='string'?[r.label]:TYPES.includes(r.type)?[r.type]:[]);
      const primary=TYPES.find(t=>labels.includes(t))??'Other';
      const name=r.name??r.properties?.name??r.properties?.id??r.id;
      if(typeof name!=='string'&&typeof name!=='number')throw new Error('节点 name 必须是文本或数字。');
      records.push({...r,labels:[...labels]});
      nodes.push({id:i,originalId:r.id,type:primary,name:String(name),raw:records[i]});
    });
    const relationshipIds=new Set(),edges=[],relationships=[];
    rels.forEach((r,i)=>{
      if(!object(r))throw new Error(`第 ${i+1} 条关系不是对象。`);properties(r.properties);
      const source=r.source??r.from??r.a,target=r.target??r.to??r.b;
      const a=ids.get(key(source)),b=ids.get(key(target));
      if(a===undefined||b===undefined)throw new Error(`第 ${i+1} 条关系引用了不存在的节点。当前图谱未替换。`);
      if(typeof r.type!=='string'||!r.type.length)throw new Error(`第 ${i+1} 条关系缺少 type。`);
      if(r.id!==undefined){const k=key(r.id);if(relationshipIds.has(k))throw new Error(`第 ${i+1} 条关系的 ID 重复。`);relationshipIds.add(k);}
      const record={...r,source,target};delete record.a;delete record.b;delete record.from;delete record.to;
      relationships.push(record);edges.push({a,b,type:r.type,raw:record});
    });
    // Only explicit public graph fields are exported. No DOM, coordinates or tokens.
    const document={format:'dsh-neo4j-memory-graph',version:1,nodes:records,relationships};
    if(object(raw.meta))document.meta=raw.meta;
    return {nodes,edges,document};
  }
  function parse(text,filename=''){
    if(/\.dump$/i.test(filename))throw new Error('.dump 需要先恢复到兼容版本的 Neo4j，再用导出脚本生成 JSON。system.dump 不用于图谱预览。');
    if(new TextEncoder().encode(text).length>LIMITS.bytes)throw new Error('文件超过 20 MB，当前图谱未替换。');
    let input;try{input=JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw new Error('无法解析 JSON。请使用图谱 JSON；不支持直接导入 .dump、CSV 或 Cypher 脚本。');}
    return normalize(input);
  }
  function serialize(document){return JSON.stringify(document,null,2)+'\n';}
  const api={LIMITS,normalize,parse,serialize};if(typeof module!=='undefined')module.exports=api;else root.GraphIO=api;
})(typeof window!=='undefined'?window:this);
