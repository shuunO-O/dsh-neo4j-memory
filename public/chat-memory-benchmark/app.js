'use strict';
(() => {
  const rows = window.BENCHMARK_DATA;
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let page = 0;
  const pageSize = 20;
  function render() {
    const text = $('search').value.trim().toLowerCase(), status = $('status').value, persona = $('persona').value;
    const filtered = rows.filter(r => (persona === 'all' || r.persona === persona) && (status === 'all' || (status === 'reviewed' ? r.reviewed : r.passed === (status === 'pass'))) && (!text || [r.id,r.question,r.answer,...r.tags].join(' ').toLowerCase().includes(text)));
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(page, pages - 1);
    $('count').textContent = `显示 ${filtered.length} / ${rows.length} 题`;
    $('page').textContent = `${page + 1} / ${pages}`;
    $('prev').disabled = page === 0; $('next').disabled = page >= pages - 1;
    $('list').innerHTML = filtered.slice(page * pageSize, (page + 1) * pageSize).map(r => `<details class="question"><summary><span class="q-id">${escape(r.id)}</span><span class="q-title">${escape(r.question)}</span><span class="badge ${r.passed ? 'pass' : 'fail'}">${r.passed ? '通过' : '未通过'}</span></summary><div class="q-content"><div class="meta">${escape(r.persona)} · ${escape(r.interval)} 天 · ${r.reviewed ? '已人工复核' : '模型判分'} · ${r.tags.map(escape).join(' / ')}</div><h3>评分要点</h3><ul>${r.required.map(x => `<li>${escape(x)}</li>`).join('')}</ul><h3>实际回答</h3><div class="answer">${escape(r.answer)}</div><h3>判分依据</h3><p>${escape(r.reason)}</p></div></details>`).join('') || '<p class="empty">没有找到符合条件的题目。</p>';
  }
  for (const id of ['search','status','persona']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => {page = 0; render();});
  $('prev').addEventListener('click', () => {page--; render(); $('questions').scrollIntoView();});
  $('next').addEventListener('click', () => {page++; render(); $('questions').scrollIntoView();});
  render();
})();
