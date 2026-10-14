/* Waves — 웨이브(가로)·티켓(세로) 격자와 마우스 올림 사슬.
   웨이브 = 의존 그래프의 깊이다(앞 노드가 없으면 1). 의존선·글자 꼬리표는 그리지 않는다 —
   마우스를 올린 노드의 앞뒤 사슬 카드만 또렷하고 나머지는 흐려진다. 앞 노드는 테두리로 표시한다.
   사슬 계산과 html()은 DOM을 만지지 않는다. apply·clear·bind만 DOM을 만진다.
   브라우저에서는 전역 BoardWaves로, node에서는 require로 같은 파일을 쓴다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./verdict.js'));
  else root.BoardWaves = factory(root.BoardVerdict);
})(typeof self !== 'undefined' ? self : this, function (Verdict) {
  'use strict';

  const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

  function classify(nodes) {
    const groups = { unfinished: [], pending: [], done: [] };
    for (const n of nodes) {
      const group = n.error ? 'unfinished' : Verdict.effective(n).pending ? 'pending' : n.state === '끝남' ? 'done' : 'unfinished';
      groups[group].push(n);
    }
    return groups;
  }

  const choiceKey = (workspace, slug, wave) => JSON.stringify([workspace || '', slug, wave]);

  /* {노드 key: 깊이(0부터)}. 같은 티켓 안의 deps만 본다. 순환은 되돌아오는 간선을 무시해 멈춘다. */
  function depths(nodes) {
    const by = {};
    for (const n of nodes || []) by[n.key] = n;
    const memo = {}, open = {};
    const depth = (k) => {
      if (memo[k] != null) return memo[k];
      if (open[k]) return 0;
      open[k] = true;
      let m = 0;
      for (const d of by[k].deps || []) if (d !== k && by[d]) m = Math.max(m, depth(d) + 1);
      open[k] = false;
      memo[k] = m;
      return m;
    };
    const out = {};
    for (const n of nodes || []) out[n.key] = depth(n.key);
    return out;
  }

  /* key 하나의 앞 사슬(먼저 끝나야 하는 노드 전부)과 뒤 사슬(이 노드를 기다리는 노드 전부). 자기 자신은 뺀다. */
  function chain(nodes, key) {
    const by = {}, down = {};
    for (const n of nodes || []) by[n.key] = n;
    for (const n of nodes || []) for (const d of n.deps || []) (down[d] = down[d] || []).push(n.key);
    const walk = (start, next) => {
      const seen = new Set();
      const todo = [start];
      while (todo.length) {
        for (const x of next(todo.pop())) if (x !== start && !seen.has(x)) { seen.add(x); todo.push(x); }
      }
      return seen;
    };
    return {
      up: walk(key, (k) => ((by[k] && by[k].deps) || []).filter((d) => by[d])),
      down: walk(key, (k) => down[k] || []),
    };
  }

  /* 티켓 목록 → {waves: 웨이브 수, rows: [{ticket, cells: [[노드…]×waves], done, total}]}. 노드 없는 티켓은 뺀다. */
  function layout(tickets) {
    const rows = [];
    let waves = 1;
    for (const t of tickets || []) {
      const nodes = t.nodes || [];
      if (!nodes.length) continue;
      const dp = depths(nodes);
      for (const k of Object.keys(dp)) waves = Math.max(waves, dp[k] + 1);
      rows.push({ ticket: t, dp, done: classify(nodes).done.length, total: nodes.length });
    }
    for (const r of rows) {
      r.cells = Array.from({ length: waves }, () => []);
      for (const n of r.ticket.nodes.slice().sort((a, b) => natural(a.key, b.key))) r.cells[r.dp[n.key]].push(n);
      delete r.dp;
    }
    return { waves, rows };
  }

  /* 화면 조각. ui = {card, esc, tk}. 카드는 .wc 껍데기에 싸고, 껍데기가 앞뒤 사슬 참조를 갖는다.
     참조는 "<티켓 순번>:<노드 key>"다 — 같은 key가 다른 티켓에 있어도 섞이지 않는다. */
  function html(tickets, ui) {
    const { waves, rows } = layout(tickets);
    if (!rows.length) return `<div class="empty">노드가 없어요</div>`;
    let h = `<div class="wscroll"><div class="wgrid" data-waves="${waves}"><div class="wh">티켓</div>`;
    for (let w = 1; w <= waves; w++) h += `<div class="wh">웨이브 ${w}</div>`;
    rows.forEach((r, ti) => {
      const t = r.ticket;
      const ids = {};
      for (const n of t.nodes) ids[n.key] = n.id;
      const name = ui.short ? ui.short(t) : t.title; // 티켓 제목은 문제 문장이라 길다 — 앞 토막만, 전체는 title에
      const rowKey = choiceKey(ui.workspace, t.slug, null);
      const folded = !!(ui.state && (ui.state.get(rowKey) || {}).folded);
      h += `<div class="wrow" data-row="${ui.esc(t.slug)}"><div class="lanehd" title="${ui.esc(t.title)}"><div class="wtitle"><button type="button" class="wrowbutton" data-wave-choice="${ui.esc(rowKey)}" data-wave-action="folded" aria-expanded="${!folded}"><span aria-hidden="true">${folded ? '▸' : '▾'}</span>${ui.tk(t.slug)}<b>${ui.esc(name)}</b></button><span class="c">${r.done} / ${r.total}</span></div></div>`;
      r.cells.forEach((cell, wave) => {
        const key = choiceKey(ui.workspace, t.slug, wave);
        const choice = (ui.state && ui.state.get(key)) || {};
        const groups = classify(cell);
        const counts = `미완료 ${groups.unfinished.length} · 반영 대기 ${groups.pending.length} · 완료 ${groups.done.length}`;
        h += `<div class="cell" data-cell="${ui.esc(key)}"><div class="wcounts">${counts}</div>`;
        if (folded) { h += `</div>`; return; }
        const cards = (nodes) => nodes.map((n) => {
          const c = chain(t.nodes, n.key);
          const ref = (k) => `${ti}:${k}`;
          return `<div class="wc" data-n="${ui.esc(ref(n.key))}" ` +
            `data-up="${ui.esc([...c.up].map(ref).join(' '))}" data-down="${ui.esc([...c.down].map(ref).join(' '))}">` +
            ui.card(n, { ticket: t.slug, ids }) + `</div>`;
        }).join('');
        h += cards(choice.more ? groups.unfinished : groups.unfinished.slice(0, 3));
        const button = (action, open, label) => `<button type="button" class="wbutton" data-wave-choice="${ui.esc(key)}" data-wave-action="${action}" aria-expanded="${!!open}">${label}</button>`;
        if (groups.unfinished.length > 3) h += button('more', choice.more, choice.more ? '다시 접기' : `남은 ${groups.unfinished.length - 3}개 더 보기`);
        h += cards(groups.pending);
        if (groups.done.length) {
          h += button('done', choice.done, choice.done ? `완료 ${groups.done.length}개 접기` : `완료 ${groups.done.length}개 펼치기`);
          if (choice.done) h += cards(groups.done);
        }
        if (!cell.length) h += `<p class="none">빈 칸</p>`;
        h += `</div>`;
      });
      h += `</div>`;
    });
    return h + `</div></div>`;
  }

  // ── DOM: 마우스 올림 ────────────────────────────────────────
  const refs = (s) => new Set(String(s || '').split(' ').filter(Boolean));

  function apply(grid, card) {
    const me = card.dataset.n, up = refs(card.dataset.up), down = refs(card.dataset.down);
    grid.classList.add('focus');
    for (const x of grid.querySelectorAll('.wc')) {
      const k = x.dataset.n;
      x.classList.toggle('lit', k === me || up.has(k) || down.has(k));
      x.classList.toggle('up', up.has(k));
    }
  }

  function clear(grid) {
    grid.classList.remove('focus');
    for (const x of grid.querySelectorAll('.wc')) x.classList.remove('lit', 'up');
  }

  /* el 하나에 위임으로 한 번만 단다 — 다시 그려도 el은 그대로라 새로 달 필요가 없다. 키보드 포커스도 같게 본다. */
  function bind(el, state, redraw) {
    el.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-wave-choice]');
      if (!b || !state || !redraw) return;
      const key = b.dataset.waveChoice, action = b.dataset.waveAction;
      const choice = state.get(key) || {};
      state.set(key, { ...choice, [action]: !choice[action] });
      redraw();
      const next = [...el.querySelectorAll('[data-wave-choice]')].find((x) => x.dataset.waveChoice === key && x.dataset.waveAction === action);
      if (next) next.focus({ preventScroll: true });
    });
    const wc = (t) => (t && t.closest ? t.closest('.wc') : null);
    const on = (e) => { const c = wc(e.target); if (c && c.closest('.wgrid')) apply(c.closest('.wgrid'), c); };
    const off = (e) => {
      const c = wc(e.target);
      if (!c || wc(e.relatedTarget) === c) return;
      const g = c.closest('.wgrid');
      if (g) clear(g);
    };
    el.addEventListener('mouseover', on);
    el.addEventListener('mouseout', off);
    el.addEventListener('focusin', on);
    el.addEventListener('focusout', off);
  }

  return { depths, chain, layout, classify, choiceKey, html, apply, clear, bind };
});
