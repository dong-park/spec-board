/* 티켓 모달 — 시나리오 x/y 통과·담당 없음·노드·막는 결정·spec.md 읽기 전용·멈춤.
   입력은 /api/board의 티켓 하나(spec_model._read_ticket). 순수 함수는 HTML 문자열만 낸다.
   spec.md 전문은 모델에 없다(크다) — 모달을 열 때 GET /w/<w>/api/spec?sheet= 로 받아 ctx.spec으로 넘긴다.
   쓰는 칸은 ticket.json `user.paused` 하나뿐이다 — 상태·담당 행은 에이전트 칸이라 화면이 안 쓴다.
   브라우저에서는 전역 TicketModal로, node에서는 require로 같은 파일을 쓴다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TicketModal = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const icon = (id, cls) => `<svg class="${cls || ''}" width="14" height="14" aria-hidden="true"><use href="#${id}"/></svg>`;

  const STATE_ICON = {
    '진행': ['s-prog', 'prog'], '확인 대기': ['s-rev', 'rev'], '막힘': ['s-blk', 'blk'],
    '보류': ['s-wait', 'hold'], '끝남': ['s-done', 'done'],
  };

  // 노드 상태 → 아이콘. 아직 안 함은 앞 노드가 끝났는지(칸)로 시작 가능과 기다림을 가른다.
  function nodeLook(n) {
    if (STATE_ICON[n.state]) return STATE_ICON[n.state];
    return n.column === '시작 가능' ? ['s-todo', 'todo'] : ['s-wait', 'wait'];
  }

  const shortTitle = (t) => String(t || '').split(/\s+[—–]\s+/)[0];
  const tail = (slug) => String(slug || '').split('/').pop();

  /* 시나리오 = kind가 task인 행. 통과 = 행이 끝남이거나, 맡은 노드가 있고 전부 끝남.
     맡은 노드는 행의 owners(노드 key), 없으면 노드 `rows`(담당 행 목록)에서 거꾸로 찾는다. */
  function scenarios(t) {
    const nodes = t.nodes || [];
    const byKey = {};
    for (const n of nodes) byKey[n.key] = n;
    const items = [];
    for (const r of t.rows || []) {
      if (r.kind && r.kind !== 'task') continue;
      const keys = Array.isArray(r.owners) ? r.owners
        : nodes.filter((n) => (n.rows || []).includes(r.id)).map((n) => n.key);
      const owners = keys.map((k) => byKey[k]).filter(Boolean);
      const passed = r.status === '끝남' || (owners.length > 0 && owners.every((n) => n.state === '끝남'));
      items.push({ row: r, owners, passed, unowned: owners.length === 0 });
    }
    return { total: items.length, passed: items.filter((i) => i.passed).length, items };
  }

  // 막는 결정 = 열려 있고, 노드를 막거나 답 없이 비가역으로 기다리는 결정.
  function blockers(t) {
    return (t.rows || []).filter((r) => r.kind === 'decision' && r.open &&
      (r.blocking || (r.blocked_nodes || []).length > 0));
  }

  function scenarioIcon(it) {
    if (it.passed) return ['s-done', 'done'];
    if (it.unowned) return ['s-wait', 'hold'];
    const st = new Set(it.owners.map((n) => n.state));
    for (const s of ['막힘', '진행', '확인 대기']) if (st.has(s)) return STATE_ICON[s];
    return ['s-todo', 'todo'];
  }

  function scenarioRow(it) {
    const r = it.row;
    const [ic, cls] = scenarioIcon(it);
    const owner = it.owners.length
      ? it.owners.map((n) => `<span class="tm-own">${esc(n.id || n.key)}</span>`).join('')
      : '<span class="tm-none">담당 없음</span>';
    return `<li class="tm-sc${it.passed ? ' is-pass' : ''}${it.unowned ? ' is-unowned' : ''}" data-row="${esc(r.id)}">` +
      `${icon(ic, 'st st-' + cls)}<span class="tm-rid">${esc(r.id)}</span>` +
      `<span class="tm-gwt"><i>G</i> ${esc(r.given)} <i>W</i> ${esc(r.when)} <i>T</i> ${esc(r.then)}</span>` +
      `<span class="tm-end">${owner}</span></li>`;
  }

  function nodeRow(n) {
    const [ic, cls] = nodeLook(n);
    return `<li class="tm-nd" data-key="${esc(n.key)}">${icon(ic, 'st st-' + cls)}` +
      `<span class="tm-rid">${esc(n.id || n.key)}</span><span class="tm-nt">${esc(n.title)}</span></li>`;
  }

  function decisionRow(d) {
    return `<li class="tm-dc" data-row="${esc(d.id)}">${icon('s-dec', 'st st-blk')}` +
      `<span class="tm-rid">${esc(d.display_id || d.id)}</span><span class="tm-nt">${esc(d.title)}</span></li>`;
  }

  // 머리 표를 문서처럼 — 전문(ctx.spec)을 아직 못 받았거나 못 읽을 때의 읽기 전용 보기
  function headAsText(head) {
    return Object.entries(head || {}).map(([k, v]) => `| ${k} | ${v} |`).join('\n');
  }

  /* 모달 하나. ctx.project는 소속 프로젝트 모델({key,title}) — 없으면 t.project 키만 쓴다.
     바깥 막(.tm-scrim)을 누르거나 ✕·Esc면 닫는다 (이벤트는 mount가 건다). */
  function render(t, ctx) {
    ctx = ctx || {};
    const sc = scenarios(t);
    const nodes = t.nodes || [];
    const doneNodes = nodes.filter((n) => n.state === '끝남').length;
    const decs = blockers(t);
    const proj = ctx.project || {};
    const projName = shortTitle(proj.title) || t.project || '줄기 없음';
    const paused = !!t.paused;
    const noNodes = nodes.length === 0;
    const full = typeof ctx.spec === 'string' && ctx.spec ? ctx.spec : (typeof t.spec_md === 'string' ? t.spec_md : '');
    const body = full || headAsText(t.head);

    const side = [
      ['우선순위', t.priority ? esc(t.priority) : '<span class="tm-dim">없음</span>'],
      ['프로젝트', esc(projName)],
      ['ID 머리', t.id_head ? `<span class="tm-mono">${esc(t.id_head)}-</span>` : '<span class="tm-dim">없음</span>'],
      ['상태', esc(t.state || '')],
    ].map(([k, v]) => `<div class="tm-pp"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');

    return `<div class="tm-scrim" data-act="scrim">` +
      `<section class="tm-box surface" role="dialog" aria-modal="true" aria-label="${esc(shortTitle(t.title))}" data-ticket="${esc(t.slug)}">` +
      `<header class="tm-top"><span class="tk tk-${esc(ctx.color || 1)}"></span>` +
      `<span class="tm-crumb">${esc(projName)} <span class="tm-sep">›</span> <span class="tm-mono">${esc(tail(t.slug))}</span></span>` +
      `<button type="button" class="tm-x" data-act="close" aria-label="닫기">✕</button></header>` +
      `<div class="tm-body"><div class="tm-main">` +
      `<h1 class="tm-h1">${esc(shortTitle(t.title))}${paused ? '<span class="tm-flag">멈춤</span>' : ''}</h1>` +
      (t.error ? `<p class="tm-err">${esc(t.error)}</p>` : '') +
      (t.problem ? `<h3 class="tm-h">문제</h3><p class="tm-p">${esc(t.problem)}</p>` : '') +
      `<h3 class="tm-h">시나리오 <span class="tm-cnt" data-k="scn">${sc.passed} / ${sc.total}</span> 통과</h3>` +
      (sc.total ? `<ul class="tm-list">${sc.items.map(scenarioRow).join('')}</ul>`
        : '<p class="tm-dim">시나리오 행이 아직 없어요</p>') +
      `<h3 class="tm-h">노드 <span class="tm-cnt" data-k="nodes">${doneNodes} / ${nodes.length}</span></h3>` +
      (nodes.length ? `<ul class="tm-list">${nodes.map(nodeRow).join('')}</ul>`
        : '<p class="tm-dim">노드가 아직 없어요</p>') +
      (decs.length ? `<h3 class="tm-h">막는 결정 <span class="tm-cnt">${decs.length}</span></h3><ul class="tm-list">${decs.map(decisionRow).join('')}</ul>` : '') +
      `<h3 class="tm-h">spec.md <span class="tm-dim">읽기 전용</span></h3>` +
      `<details class="tm-doc"><summary>펼치기</summary><pre class="tm-pre" tabindex="0">${esc(body)}</pre></details>` +
      `</div><aside class="tm-side">${side}</aside></div>` +
      `<footer class="tm-foot"><span class="tm-msg" role="status" aria-live="polite"></span>` +
      `<button type="button" class="tm-btn" data-act="pause" aria-pressed="${paused}">${paused ? '멈춤 풀기' : '멈춤'}</button>` +
      (noNodes
        ? '<button type="button" class="btn-primary" data-act="split">노드로 나누기</button>'
        : '<button type="button" class="btn-primary" data-act="waves">Waves에서 보기</button>') +
      `</footer></section></div>`;
  }

  /* 멈춤 저장 — ticket.json user.paused만 쓴다. base로 지금 보이는 값을 같이 보내고,
     다른 곳에서 먼저 바꿨으면 409와 함께 서버 값이 온다. io = {fetch, w} */
  const CONFLICT = '다른 곳에서 먼저 바꿨어요 — 새 값으로 보여 줄게요';
  async function setPaused(t, paused, io) {
    if (!io || !io.w) return { ok: false, paused: !!t.paused, message: '워크스페이스를 몰라 저장하지 못했어요' };
    const f = io.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!f) return { ok: false, paused: !!t.paused, message: '저장하지 못했어요' };
    let res;
    try {
      res = await f(`/w/${encodeURIComponent(io.w)}/api/ticket`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet: t.slug, user: { paused: !!paused }, base: { paused: !!t.paused } }),
      });
    } catch (e) {
      return { ok: false, paused: !!t.paused, message: '저장하지 못했어요 — 연결을 확인해 주세요' };
    }
    let j = {};
    try { j = await res.json(); } catch (e) { /* 본문 없음 */ }
    const u = j.user || {};
    if (res.status === 409) return { ok: false, conflict: true, paused: !!u.paused, message: CONFLICT };
    if (!res.ok) return { ok: false, paused: !!t.paused, message: `저장하지 못했어요 (${res.status})` };
    return { ok: true, paused: 'paused' in u ? !!u.paused : !!paused };
  }

  /* spec.md 전문 읽기 — 모달이 열릴 때 한 번. 실패하면 머리 표 보기가 그대로 남는다. io = {fetch, w} */
  async function loadSpec(t, io) {
    const f = (io && io.fetch) || (typeof fetch === 'function' ? fetch : null);
    if (!f || !io || !io.w) return { ok: false, text: '' };
    try {
      const res = await f(`/w/${encodeURIComponent(io.w)}/api/spec?sheet=${encodeURIComponent(t.slug)}`);
      if (!res.ok) return { ok: false, text: '' };
      const j = await res.json();
      return { ok: true, text: typeof j.spec_md === 'string' ? j.spec_md : '' };
    } catch (e) {
      return { ok: false, text: '' };
    }
  }

  function findTicket(model, slug) {
    for (const p of (model && model.projects) || []) {
      for (const t of p.tickets || []) if (t.slug === slug) return { ticket: t, project: p };
    }
    return null;
  }

  // 노드로 나누기는 에이전트 일이다 — 보드는 쓰지 않고 시킬 문장을 클립보드에 준다.
  const splitCommand = (t) => `/spec ${t.slug} 노드로 나눠줘`;

  /* 브라우저 진입 — document에 위임으로 건다. [data-ticket] 요소를 누르면 열고, ✕·막·Esc로 닫는다.
     getModel()은 지금 화면이 들고 있는 /api/board 모델을 준다. */
  function mount(opts) {
    const doc = opts.document || document;
    const wOf = () => (typeof opts.w === 'function' ? opts.w() : opts.w) || '';
    const holder = doc.createElement('div');
    holder.className = 'tm-root';
    doc.body.appendChild(holder);
    let cur = null;

    const close = () => { cur = null; holder.innerHTML = ''; };
    const say = (m) => { const el = holder.querySelector('.tm-msg'); if (el) el.textContent = m || ''; };
    const draw = () => {
      if (!cur) return;
      const colorOf = opts.color || (() => 1);
      holder.innerHTML = render(cur.ticket, { project: cur.project, color: colorOf(cur.ticket.slug), spec: cur.spec });
    };
    const open = (slug) => {
      const hit = findTicket(opts.getModel(), slug);
      if (!hit) return false;
      cur = hit; draw();
      const x = holder.querySelector('.tm-x'); if (x) x.focus();
      // 전문은 열 때만 받는다. 돌아왔을 때 다른 티켓이 열려 있으면 버린다. 본문만 바꿔 입력·포커스를 건드리지 않는다.
      const mine = hit;
      loadSpec(hit.ticket, { w: wOf(), fetch: opts.fetch }).then((r) => {
        if (!r.ok || cur !== mine) return;
        mine.spec = r.text;
        const pre = holder.querySelector('.tm-pre');
        if (pre && r.text) pre.textContent = r.text;
      });
      return true;
    };

    doc.addEventListener('click', async (e) => {
      const t = e.target.closest && e.target.closest('[data-ticket]:not(.tm-box), [data-act]');
      if (!t) return;
      if (t.dataset.ticket && !t.dataset.act) return void open(t.dataset.ticket);
      if (!cur) return;
      const act = t.dataset.act;
      if (act === 'scrim') { if (e.target === t) close(); return; }
      if (act === 'close') return close();
      if (act === 'waves') {
        const p = cur.project && cur.project.key;
        close();
        if (opts.go) opts.go(p ? `#${p}/wave` : '#wave');
        return;
      }
      if (act === 'split') {
        const cmd = splitCommand(cur.ticket);
        try { await navigator.clipboard.writeText(cmd); say('복사했어요 — 에이전트에게 붙여 넣으세요'); }
        catch (err) { say(cmd); }
        return;
      }
      if (act === 'pause') {
        const r = await setPaused(cur.ticket, !cur.ticket.paused, { w: wOf(), fetch: opts.fetch });
        cur.ticket.paused = r.paused;       // 서버가 돌려준 값을 그대로 보여 준다 (409면 남의 값)
        draw(); say(r.ok ? '' : r.message);
        if (opts.onChange) opts.onChange(cur.ticket);
      }
    });
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cur) close(); });
    return { open, close, get current() { return cur && cur.ticket; } };
  }

  return { esc, render, scenarios, blockers, setPaused, loadSpec, findTicket, splitCommand, mount, CONFLICT };
});
