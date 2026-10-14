/* Working Board 화면 함수 — 순수 함수는 HTML 문자열만 낸다.
   입력은 sheet.py `/api/board`의 JSON(spec_model.build_board)이다. DOM·fetch는 mount()만 만진다.
   브라우저에서는 전역 BoardView로, node에서는 require로 같은 파일을 쓴다(file://에서도 열려야 해서 UMD). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./board.js'), require('./waves.js'), require('./flow.js'), require('./sheet.js'));
  else root.BoardView = factory(root.BoardCols, root.BoardWaves, root.BoardFlow, root.BoardSheet);
})(typeof self !== 'undefined' ? self : this, function (Cols, Waves, Flow, Sheet) {
  'use strict';

  // 결정 메뉴·모달 로직. view.js가 쓰고 decisions.js는 view.js를 모른다 (순환 없음).
  const Dec = (typeof module === 'object' && module.exports && typeof require === 'function')
    ? require('./decisions.js')
    : (typeof self !== 'undefined' ? self : globalThis).BoardDecisions || null;
  // Inbox 목록 조각. 이 파일이 쓰고 inbox.js는 view.js를 모른다.
  const Inbox = (typeof module === 'object' && module.exports && typeof require === 'function')
    ? require('./inbox.js')
    : (typeof self !== 'undefined' ? self : globalThis).BoardInbox || null;
  // 프로젝트 종합 화면. view.js가 쓰고 project.js는 view.js를 모른다.
  const Proj = (typeof module === 'object' && module.exports && typeof require === 'function')
    ? require('./project.js')
    : (typeof self !== 'undefined' ? self : globalThis).BoardProject || null;
  // 확인 결과(통과·고쳐줘)를 에이전트가 반영하기 전에 카드가 어느 칸으로 보이는지. 저장값은 안 바꾼다.
  const Verdict = (typeof module === 'object' && module.exports && typeof require === 'function')
    ? require('./verdict.js')
    : (typeof self !== 'undefined' ? self : globalThis).BoardVerdict;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const icon = (id, cls, size) =>
    `<svg class="${cls || ''}" width="${size || 14}" height="${size || 14}" aria-hidden="true"><use href="#${id}"/></svg>`;

  // 저장 상태 → 카드 모양. "시작 가능"·"기다림"은 저장값이 아니라 칸이라 아직 안 함만 칸을 본다.
  const LOOK = {
    '진행': { cls: 'prog', icon: 's-prog' },
    '확인 대기': { cls: 'rev', icon: 's-rev' },
    '막힘': { cls: 'blk', icon: 's-blk' },
    '보류': { cls: 'hold', icon: 's-wait' },
    '끝남': { cls: 'done', icon: 's-done' },
  };

  function look(node) {
    if (node.error) return { cls: 'err', icon: 's-blk' };
    const eff = Verdict.effective(node);
    if (eff.state === '아직 안 함') {
      return eff.column === '시작 가능' ? { cls: 'todo', icon: 's-todo' } : { cls: 'wait', icon: 's-wait' };
    }
    return LOOK[eff.state] || { cls: 'wait', icon: 's-wait' };
  }

  // 티켓 슬러그로 색 번호 1..6을 고른다 — 같은 티켓은 어느 화면에서나 같은 색이다.
  function ticketColor(slug) {
    let h = 5381;
    for (const ch of String(slug || '')) h = ((h << 5) + h + ch.codePointAt(0)) >>> 0;
    return (h % 6) + 1;
  }

  /* 카드 하나. 티켓 색 점·모노 ID·상태 아이콘·제목·막는 ID 칩만 낸다.
     경과 시간(node.elapsed)과 담당 아바타(node.worker)는 진행 카드에서만 낸다.
     ctx.ticket은 색을, ctx.ids는 {노드 key: 화면 ID}로 앞 노드 칩의 글자를 정한다. */
  // 카드와 Tickets 행이 같이 쓰는 곁가지 — 진행 시간·담당(right), 막는 결정·앞 노드·반영 대기 칩, 경고 칩.
  function bits(node, ctx) {
    const eff = Verdict.effective(node);
    const live = eff.state === '진행';
    const right = [];
    if (live && node.elapsed) right.push(`<span class="tm"><i class="pulse"></i>${esc(node.elapsed)}</span>`);
    if (live && node.worker) right.push(`<span class="av">${esc(String(node.worker).slice(0, 1))}</span>`);

    const chips = [];
    if (eff.state !== '끝남') {
      const decs = node.blocked_by_ids || [];
      if (decs.length) {
        chips.push(`<span class="chip dec" title="막는 결정" data-dec="${esc(decs[0])}" data-ticket="${esc(ctx.ticket || '')}">` +
          `◆ ${esc(decs[0])}${decs.length > 1 ? ` +${decs.length - 1}` : ''}</span>`);
      }
      for (const d of node.waiting_on || []) {
        chips.push(`<span class="chip dep" title="먼저 끝나야 함">${esc((ctx.ids || {})[d] || d)}</span>`);
      }
    }
    if (eff.pending) {
      chips.push(`<span class="chip" title="${esc(eff.pending)}를 남겼어요 — 에이전트가 반영하면 상태가 바뀝니다">반영 대기</span>`);
    }
    const warns = node.warnings || [];
    const warn = warns.length
      ? `<span class="chip warn" title="${esc(warns.map((w) => w.text || w.code || w).join(' / '))}">!</span>` : '';
    return { right, chips, warn };
  }

  function card(node, ctx) {
    ctx = ctx || {};
    const k = look(node);
    const id = node.id || node.key || '';
    const tk = `<span class="tk tk-${ticketColor(ctx.ticket)}"></span>`;
    if (node.error) {
      // 머리가 깨진 노드는 카드 대신 "읽기 실패" 카드. 사유는 문장으로 펼치지 않고 title에만 둔다.
      return `<article class="card is-err" data-key="${esc(node.key)}" title="${esc(node.error)}">` +
        `<div class="a">${tk}<span class="id">${esc(id)}</span></div>` +
        `<div class="b">${icon(k.icon, 'st st-blk')}<span class="t">읽기 실패</span></div></article>`;
    }
    const { right, chips, warn } = bits(node, ctx);
    return `<article class="card is-${k.cls}" data-key="${esc(node.key)}" data-id="${esc(id)}" data-tkt="${esc(ctx.ticket || '')}" tabindex="0">` +
      `<div class="a">${tk}<span class="id">${esc(id)}</span>${warn}` +
      (right.length ? `<span class="rt">${right.join('')}</span>` : '') + `</div>` +
      `<div class="b">${icon(k.icon, 'st st-' + k.cls)}<span class="t">${esc(node.title)}</span></div>` +
      (chips.length ? `<div class="r">${chips.join('')}</div>` : '') + `</article>`;
  }

  /* Tickets 화면의 한 줄 — ID·상태 아이콘·제목, 오른쪽에 칩과 진행 시간·담당. 누르면 노드 모달이 열린다. */
  function row(node, ctx) {
    const k = look(node);
    const id = node.id || node.key || '';
    if (node.error) {
      return `<div class="nrow is-err" data-key="${esc(node.key)}" title="${esc(node.error)}"><span class="id">${esc(id)}</span>` +
        `${icon(k.icon, 'st st-blk')}<span class="t">읽기 실패</span></div>`;
    }
    const { right, chips, warn } = bits(node, ctx);
    const side = warn + chips.join('') + right.join('');
    return `<div class="nrow is-${k.cls}" data-nm-open data-key="${esc(node.key)}" data-id="${esc(id)}" data-tkt="${esc(ctx.ticket || '')}" tabindex="0">` +
      `<span class="id">${esc(id)}</span>${icon(k.icon, 'st st-' + k.cls)}<span class="t">${esc(node.title)}</span>` +
      (side ? `<span class="rt">${side}</span>` : '') + '</div>';
  }

  /* 티켓 하나 — 머리줄(색·이름·진행 막대) 아래에 Board와 같은 칸으로 묶은 행. 빈 칸은 안 낸다.
     끝남은 기본으로 접는다. folds는 기본과 반대로 뒤집은 "티켓|칸" 키 묶음이다. */
  const TIX_ORDER = ['확인 대기', '진행', '시작 가능', '기다림', '끝남'];
  const TIX_LOOK = { '시작 가능': ['s-todo', 'todo'], '진행': ['s-prog', 'prog'], '확인 대기': ['s-rev', 'rev'], '기다림': ['s-wait', 'wait'], '끝남': ['s-done', 'done'] };
  function ticketRows(t, folds) {
    const nodes = t.nodes || [];
    const ids = {};
    for (const n of nodes) ids[n.key] = n.id;
    const cols = Cols.assign(nodes);
    const done = cols['끝남'].length;
    const step = nodes.length ? Math.round((done / nodes.length) * 10) : 0; // 막대 너비는 10% 단위 클래스 (인라인 style 금지)
    const head = `<h2 class="gh" data-ticket="${esc(t.slug)}"><span class="tk tk-${ticketColor(t.slug)}"></span><span class="gt">${esc(t.title)}</span>` +
      (nodes.length ? `<span class="pg"><i><b class="w${step}"></b></i>${done} / ${nodes.length}</span>` : '') + '</h2>';
    // 노드가 없는 티켓도 머리줄은 낸다 — 눌러야 티켓 모달의 '노드로 나누기'에 닿는다.
    if (!nodes.length) return `<section class="group">${head}<p class="none">노드 없음</p></section>`;
    let body = '';
    for (const c of TIX_ORDER) {
      const list = cols[c];
      if (!list.length) continue;
      const key = t.slug + '|' + c;
      const closed = (c === '끝남') !== !!(folds && folds.has(key));
      body += `<button type="button" class="lh" data-tix-fold="${esc(key)}" aria-expanded="${!closed}">` +
        `<span class="cv" aria-hidden="true">${closed ? '▸' : '▾'}</span>${icon(TIX_LOOK[c][0], 'st st-' + TIX_LOOK[c][1])}` +
        `<span>${esc(c)}</span><span class="c">${list.length}</span></button>` +
        (closed ? '' : list.map((n) => row(n, { ticket: t.slug, ids })).join(''));
    }
    return `<section class="group">${head}<div class="nrows">${body}</div></section>`;
  }

  // 제목의 "— " 앞 토막 — 한국어 이름이다. 종합 화면 머리와 티켓 이름에만 쓴다 (제목은 문제 문장이라 길다).
  const shortName = (p) => String(p.title || p.key || '').split(/\s+[—–]\s+/)[0] || p.key;
  // 사이드바·crumb의 프로젝트 이름은 줄기 폴더 슬러그다. 줄기 없는 티켓 묶음은 key가 비어 있다.
  const slugOf = (p) => String((p && p.key) || '').split('/').filter(Boolean).pop() || 'No project';

  function progress(p) {
    let done = 0, total = 0;
    for (const t of p.tickets || []) {
      const c = t.counts || {};
      for (const k of Object.keys(c)) { total += c[k]; if (k === '끝남') done += c[k]; }
    }
    return total ? Math.round((done / total) * 100) : 0;
  }

  const hashOf = (view, project) => '#' + (project ? `${project}/${view}` : view);

  function parseHash(hash) {
    let h = String(hash || '').replace(/^#/, '');
    try { h = decodeURIComponent(h); } catch (e) { /* 깨진 퍼센트 인코딩은 그대로 둔다 */ }
    if (!h) return { view: 'inbox', project: null };
    if (h.startsWith('s/')) return { view: 'sheet', project: null, sheet: h.slice(2) };
    const i = h.lastIndexOf('/');
    if (i < 0) return { view: h, project: null };
    return { view: h.slice(i + 1), project: h.slice(0, i) };
  }

  const PROJECT_VIEWS = [['tickets', 'Tickets', 'i-tix'], ['list', 'Issues', 'i-list'], ['board', 'Board', 'i-board'], ['wave', 'Waves', 'i-waves']];

  function navLink(label, ic, href, on, tail, extra) {
    return `<a class="nav${extra ? ' ' + extra : ''}${on ? ' on' : ''}" href="${esc(href)}"${on ? ' aria-current="page"' : ''}>` +
      `${icon(ic, 'ni', 16)}<span class="t">${esc(label)}</span>${tail || ''}</a>`;
  }

  /* 사이드바 — 시트 찾기 · Inbox · Decisions · 시트 목록(진행 중 / 준비 / 끝남 접힘). 시트 하나 = 작업 단위.
     sheets는 /api/sheets(모든 워크스페이스), 없으면 지금 모델에서 만든다. 프로젝트(줄기) 층은 화면에 두지 않는다. */
  function sidebar(model, nav, ui0) {
    nav = nav || {};
    ui0 = ui0 || {};
    const ws = (model && model.workspace) || '';
    const sheets = ui0.sheets || Sheet.fromModel(model || {});
    const cur = { workspace: ws, slug: nav.view === 'sheet' ? nav.sheet : null };
    return Sheet.side(sheets, cur, (model && model.summary) || {}, {
      esc, icon, view: nav.view, q: ui0.q, doneOpen: ui0.doneOpen, now: ui0.now, color: ticketColor, nav: navLink,
    });
  }

  const VIEW_NAME = { inbox: 'Inbox', dec: 'Decisions', project: 'Overview', tickets: 'Tickets', list: 'Issues', board: 'Board', wave: 'Waves', flow: 'Flow', archive: '보관', repos: 'Repos & 서비스' };

  /* 오른쪽 면 — 틀만 만든다. 결정 메뉴·Board·Waves·모달은 뒤 노드가 이 자리를 채운다.
     지금은 고른 프로젝트의 노드 카드를 티켓별로 늘어놓아 카드와 테마가 보이게 한다. */
  function stage(model, nav, ui0) {
    nav = nav || {};
    const inboxState = ui0 && ui0.inbox;
    const projects = (model && model.projects) || [];
    const p = projects.find((x) => x.key === nav.project);
    // 종합 화면은 프로젝트가 있어야 뜬다 — 못 찾으면 티켓 목록으로 떨어진다.
    if (nav.view === 'project' && !(p && Proj)) nav = Object.assign({}, nav, { view: 'tickets' });
    const crumb = (p ? `${esc(slugOf(p))} › ` : '') + `<b>${esc(VIEW_NAME[nav.view] || nav.view || '')}</b>`;
    let body = '';
    const scope = p ? [p] : projects;
    const tickets = scope.flatMap((pr) => pr.tickets || []);
    const ui = { workspace: model && model.workspace, state: ui0 && ui0.waves, card, esc, icon, look, color: ticketColor, today: ui0 && ui0.today, tk: (slug) => `<span class="tk tk-${ticketColor(slug)}"></span>`, short: (t) => shortName({ title: t.title, key: t.slug }), slug: slugOf };
    if (nav.view === 'sheet') {
      const t = projects.flatMap((pr) => pr.tickets || []).find((x) => x.slug === nav.sheet);
      if (!t) return '<main class="main surface"><div class="top"><div class="crumb"><b>Sheet</b></div></div><div class="view"><div class="empty">이 시트를 못 찾았어요</div></div></main>';
      return Sheet.page(t, model, ui0 && ui0.prefs, ui0 && ui0.pop, ui);
    }
    if (nav.view === 'project') {
      body = Proj.html(p, model, ui);
    } else if (nav.view === 'dec' && Dec) {
      body = Dec.menu(model);
    } else if (nav.view === 'inbox' && Inbox) {
      body = Inbox.html(model, { state: inboxState });
    } else if (nav.view === 'archive') {
      body = Sheet.archiveHtml((ui0 && ui0.sheets) || Sheet.fromModel(model || {}), { workspace: model && model.workspace }, ui);
    } else if (nav.view === 'repos') {
      body = Sheet.reposHtml(ui0 && ui0.repos, ui);
    } else if (nav.view === 'dec') {
      body = `<div class="empty" data-slot="${esc(nav.view)}"></div>`;
    } else if (nav.view === 'board') {
      body = Cols.html(tickets, ui);
    } else if (nav.view === 'wave') {
      body = Waves.html(tickets, ui);
    } else if (nav.view === 'flow') {
      body = Flow.html(tickets, ui);
    } else {
      for (const pr of scope) {
        for (const t of pr.tickets || []) body += ticketRows(t, ui0 && ui0.tix);
      }
    }
    return `<main class="main surface"><div class="top"><div class="crumb">${crumb}</div></div>` +
      `<div class="view">${body}</div></main>`;
  }

  // 상태 아이콘과 메뉴 아이콘 — 색은 board.css의 .st-* 가 currentColor로 정한다.
  function sprite() {
    const c = (b) => `<circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" stroke-width="1.5"${b || ''}/>`;
    const sym = (id, vb, inner) => `<symbol id="${id}" viewBox="0 0 ${vb} ${vb}">${inner}</symbol>`;
    const line = 'fill="none" stroke="currentColor" stroke-width="1.3"';
    return '<svg class="sprite" width="0" height="0" aria-hidden="true"><defs>' +
      sym('s-wait', 14, c(' stroke-dasharray="1.6 2"')) +
      sym('s-todo', 14, c()) +
      sym('s-prog', 14, c() + '<path d="M7 3.5A3.5 3.5 0 0 1 7 10.5Z" fill="currentColor"/>') +
      sym('s-rev', 14, c() + '<path d="M7 3.5A3.5 3.5 0 1 1 3.5 7H7Z" fill="currentColor"/>') +
      sym('s-done', 14, '<circle cx="7" cy="7" r="7" fill="currentColor"/><path d="M4.2 7.2l1.9 1.9 3.8-4" stroke="var(--knock)" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>') +
      sym('s-blk', 14, c() + '<path d="M3 11L11 3" stroke="currentColor" stroke-width="1.5"/>') +
      sym('s-dec', 14, '<path d="M7 1l6 6-6 6-6-6z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="7" cy="7" r="1.6" fill="currentColor"/>') +
      sym('i-inbox', 16, `<path d="M2 9l1.5-5.5h9L14 9v3.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z M2 9h3.5l1 1.6h3l1-1.6H14" ${line} stroke-linejoin="round"/>`) +
      sym('i-list', 16, `<path d="M3 4h10M3 8h10M3 12h10" ${line}/>`) +
      sym('i-board', 16, `<rect x="2.5" y="2.5" width="4" height="11" rx="1" ${line}/><rect x="9.5" y="2.5" width="4" height="7" rx="1" ${line}/>`) +
      sym('i-waves', 16, `<rect x="2" y="3" width="3" height="3" rx="1" ${line}/><rect x="6.5" y="3" width="3" height="3" rx="1" ${line}/><rect x="6.5" y="8" width="3" height="3" rx="1" ${line}/><rect x="11" y="10" width="3" height="3" rx="1" ${line}/>`) +
      sym('i-tix', 16, `<path d="M2.5 4.5h11v2a1.5 1.5 0 0 0 0 3v2h-11v-2a1.5 1.5 0 0 0 0-3z" ${line} stroke-linejoin="round"/>`) +
      sym('i-filter', 16, `<path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" ${line} stroke-linecap="round"/>`) +
      sym('i-disp', 16, `<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" ${line}/><circle cx="5" cy="4.5" r="1.4" fill="currentColor"/><circle cx="11" cy="8" r="1.4" fill="currentColor"/><circle cx="7" cy="11.5" r="1.4" fill="currentColor"/>`) +
      sym('i-cube', 16, `<path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z M2.5 4.8L8 7.8l5.5-3 M8 7.8v6.4" ${line} stroke-linejoin="round"/>`) +
      '</defs></svg>';
  }

  // ui = { inbox } — 어느 화면에서나 같은 틀이다. 좁은 화면 배치는 board.css가 맡는다.
  const page = (model, nav, ui) => sprite() + sidebar(model, nav, ui) + stage(model, nav, ui);

  // `/api/board`는 w가 없으면 보드 없이 {workspaces:[{workspace, tickets, …}]} 목록만 준다 (성능).
  // 정적 ?src= JSON은 보드가 든 {workspaces:[…]}일 수도 있다 — 그때는 pick이 고른다.
  const isBare = (raw) => !!(raw && Array.isArray(raw.workspaces) && !raw.workspaces.some((x) => x && x.projects));

  // 목록에서 열 워크스페이스 — 주소가 가리킨 것, 없으면 티켓이 있는 첫 것, 없으면 첫 것. 비면 null.
  function chooseWorkspace(list, w) {
    const l = Array.isArray(list) ? list : [];
    const hit = l.find((x) => x.workspace === w) || l.find((x) => (x.tickets || 0) > 0) || l[0];
    return hit ? hit.workspace : null;
  }

  function pick(raw, w) {
    if (raw && Array.isArray(raw.workspaces)) {
      const list = raw.workspaces;
      return list.find((x) => x.workspace === w) || list.find((x) => (x.projects || []).length) || list[0] || {};
    }
    return raw || {};
  }

  /* 모달 틀 — 결정 모달이 처음 쓰고, 노드·티켓 모달도 같은 틀을 쓴다.
     parts = {label, crumb(이미 이스케이프된 HTML), ticket, main, side, foot}. 틀만 입히고 내용은 모른다. */
  function modalShell(parts) {
    const p = parts || {};
    return '<div class="scrim" data-modal-close></div>' +
      `<section class="modal surface" role="dialog" aria-modal="true" aria-label="${esc(p.label || '')}">` +
      `<header class="mt"><span class="tk tk-${ticketColor(p.ticket)}"></span><span class="crumb">${p.crumb || ''}</span>` +
      `<button class="x" type="button" data-modal-close aria-label="닫기">✕</button></header>` +
      `<div class="mb"><div class="mm">${p.main || ''}</div><aside class="ms">${p.side || ''}</aside></div>` +
      `<footer class="mf">${p.foot || ''}</footer></section>`;
  }

  /* ?src=는 같은 주소의 경로만 받는다 — 다른 주소(`//host`·`https:`·`javascript:`)면 기본 주소로 돌아간다. */
  const safeSrc = (raw, fallback) => (typeof raw === 'string' && /^\/(?![/\\])[^\s]*$/.test(raw) ? raw : fallback);

  /* CSP가 인라인 style 속성을 막는다. 값이 계산되는 두 곳(진행 막대 너비, 웨이브 열 수)은 data-*로 싣고,
     그린 뒤 CSSOM으로 칠한다 — CSSOM 쓰기는 CSP가 막지 않는다. */
  function paint(root) {
    root.querySelectorAll('.wgrid[data-waves]').forEach((e) => e.style.setProperty('--waves', e.getAttribute('data-waves')));
    root.querySelectorAll('.ovp[data-pct] .bar i').forEach((i) => {
      const host = i.closest('.ovp');
      i.style.width = (host ? host.getAttribute('data-pct') : '0') + '%';
    });
  }

  const postJson = (url, body) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json().catch(() => ({})).then((json) => ({ status: r.status, json })));

  /* 브라우저 진입 — /api/board(또는 ?src=<json 경로>)를 읽어 그린다. 해시가 바뀌면 다시 그린다.
     결정 모달은 #app 밖의 별도 층에 그린다 — 본문을 다시 그려도 입력 중인 모달이 지워지지 않는다. */
  function mount(el) {
    const q = new URLSearchParams(location.search);
    const pm = /^\/w\/([^/]+)\//.exec(location.pathname); // /w/<w>/board/ 로 열었으면 그 워크스페이스다
    let w = q.get('w') || (pm ? decodeURIComponent(pm[1]) : null);
    const srcFor = () => safeSrc(q.get('src'), '/api/board' + (w ? '?w=' + encodeURIComponent(w) : ''));
    let model = null;
    let inbox = null;
    const waves = new Map();
    const tix = new Set(); // Tickets 화면에서 기본과 반대로 접거나 편 "티켓|칸"
    // 시트 화면 — 보기 설정은 브라우저에 남기고, 팝오버·찾기 글자·사이드바 끝남 펼침은 이 탭에만 둔다
    const PREF_KEY = 'spec-board.flow';
    let prefs = Sheet.load((() => { try { return localStorage.getItem(PREF_KEY); } catch (e) { return null; } })());
    const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* 저장 못 하는 브라우저면 이번 탭에서만 */ } };
    let pop = null;       // 열린 팝오버 — 'disp' · 'filter' · 'filter:state' · 'filter:since'
    let sheets = null;    // /api/sheets — 사이드바. 없으면 지금 모델에서 만든다
    let repos = null;     // /api/repos — Repos & 서비스 화면
    let sq = '';          // 시트 찾기 글자
    let doneOpen = false; // 사이드바 끝남 묶음을 폈는가
    const localDay = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    let last = '';        // 마지막으로 그린 HTML — 같으면 다시 그리지 않는다 (깜빡임·스크롤 튐 없음)
    let lastRoute = null; // 같은 화면을 다시 그릴 때만 스크롤을 되돌린다
    const draw = () => {
      if (!model) { el.innerHTML = ''; last = ''; return; }
      const html = page(model, parseHash(location.hash), { inbox: inbox && inbox.view(), waves, tix, sheets, repos, prefs, pop, q: sq, doneOpen, today: localDay() });
      if (html === last) return;
      const route = location.hash;
      const keep = route === lastRoute;
      const focus = keep && el.contains(document.activeElement) && document.activeElement.dataset;
      const typingQ = !!(document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-sheet-q]'));
      const top = keep ? ((el.querySelector('.view') || {}).scrollTop || 0) : 0;
      const left = keep ? ((el.querySelector('.view') || {}).scrollLeft || 0) : 0;
      const side = (el.querySelector('.side') || {}).scrollTop || 0;
      el.innerHTML = html;
      last = html;
      lastRoute = route;
      paint(el); // 열 너비를 먼저 복원해야 가로 스크롤이 0으로 제한되지 않는다
      const v = el.querySelector('.view'); if (v) { v.scrollTop = top; v.scrollLeft = left; }
      const s = el.querySelector('.side'); if (s) s.scrollTop = side;
      if (focus && focus.waveChoice) {
        const next = [...el.querySelectorAll('[data-wave-choice]')].find((b) => b.dataset.waveChoice === focus.waveChoice && b.dataset.waveAction === focus.waveAction);
        if (next) next.focus({ preventScroll: true });
      }
      if (focus && focus.tixFold) {
        const next = [...el.querySelectorAll('[data-tix-fold]')].find((b) => b.dataset.tixFold === focus.tixFold);
        if (next) next.focus({ preventScroll: true });
      }
      if (typingQ) {
        const qi = el.querySelector('[data-sheet-q]');
        if (qi) { qi.focus({ preventScroll: true }); qi.setSelectionRange(qi.value.length, qi.value.length); }
      }
      if (Inbox) Inbox.after(el, inbox);
    };
    const getJson = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
    // w가 없으면 서버는 목록만 준다 — 고른 워크스페이스로 다시 요청한다 (보드를 한 번만 계산하게)
    const load = () => getJson(srcFor()).then((m) => {
      if (!isBare(m)) return m;
      const key = chooseWorkspace(m.workspaces, w);
      return key == null ? {} : getJson('/api/board?w=' + encodeURIComponent(key));
    }).then((m) => { model = pick(m, w); draw(); });
    // 사이드바 시트 목록 — 모든 워크스페이스. 정적 ?src=면 묻지 않고 모델에서 만든다
    const loadSheets = () => (q.get('src') ? Promise.resolve() : Promise.all([getJson('/api/sheets').then((j) => { sheets = j.sheets || null; }), getJson('/api/repos').then((j) => { repos = j; }).catch(() => {})]).then(draw).catch(() => {}));

    /* 실시간 — 3초마다 버전만 묻고, 바뀌었을 때만 보드를 받아 다시 그린다. 탭이 안 보이면 묻지 않는다.
       입력칸에 쓰는 중이면 그 차례를 건너뛴다 — 버전이 그대로 다르니 다음 차례에 다시 받는다.
       모달(결정·노드·티켓)은 본문 밖에 따로 그려져 사람이 읽는 중에 바뀌지 않는다. 정적 ?src=는 묻지 않는다. */
    const typing = () => {
      const a = document.activeElement;
      return !!(a && a.matches && a.matches('input,textarea') && el.contains(a));
    };
    const online = (ok) => document.body.classList.toggle('is-offline', !ok);
    let ticks = 0;
    const tick = () => {
      if (q.get('src') || !model || !model.workspace || document.visibilityState === 'hidden') return;
      if (++ticks % 5 === 0) loadSheets(); // 다른 워크스페이스의 변화는 15초마다
      getJson('/api/version?w=' + encodeURIComponent(model.workspace)).then((j) => {
        online(true);
        if (j.v !== model.v && !typing()) return load().then(loadSheets);
      }).catch(() => online(false));
    };
    setInterval(tick, 3000);
    document.addEventListener('visibilitychange', tick);
    const layer = document.createElement('div');
    layer.className = 'layer';
    document.body.appendChild(layer);
    let ctl = null;
    const drawLayer = () => {
      const d = ctl && ctl.current();
      const hadText = document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-dec-text]');
      layer.innerHTML = d ? modalShell(Dec.modalParts(d, ctl.view(), model)) : '';
      const ta = layer.querySelector('[data-dec-text]');
      if (ta && (hadText || ctl.state.focusText)) {
        ctl.state.focusText = false;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    };
    if (Dec) {
      ctl = Dec.controller({
        getModel: () => model, post: postJson, onChange: drawLayer,
        onSaved: () => { draw(); load().catch(() => {}); },
        onConflict: () => { draw(); load().catch(() => {}); },
      });
    }

    // Inbox 줄의 선택지·통과·고쳐줘 — 답하기·확인은 결정 모달·노드 모달과 같은 컨트롤러가 쓴다
    if (Inbox) {
      inbox = Inbox.controller({
        getModel: () => model, fetch: (u, i) => fetch(u, i), redraw: draw,
        onSaved: () => { draw(); load().catch(() => {}); },
        onConflict: () => { draw(); load().catch(() => {}); },
      });
      Inbox.bind(el, inbox);
    }

    window.addEventListener('hashchange', draw);
    window.addEventListener('hashchange', () => { if (pop) { pop = null; draw(); } });
    Flow.bind(el);
    Waves.bind(el, waves, draw); // Waves의 마우스 올림 사슬 — 위임이라 다시 그려도 한 번이면 된다
    // 시트 화면의 보기·필터 버튼, 사이드바 끝남 펼치기. 팝오버 밖을 누르면 닫는다.
    const svOf = (t) => (t && t.closest ? t.closest('[data-sv],[data-sv-set],[data-sv-tog],[data-sv-prop],[data-sv-add],[data-sv-del],[data-sv-menu]') : null);
    /* 다른 워크스페이스로 — 페이지를 다시 불러오지 않는다. 새 보드가 올 때까지 지금 화면을 그대로 두고, 오면 한 번에 바꾼다. */
    const goWorkspace = (ws, hash, push) => {
      if (!ws || ws === w) { if (push) location.hash = hash || ''; return Promise.resolve(); }
      w = ws;
      if (push) history.pushState(null, '', '/w/' + encodeURIComponent(ws) + '/board/' + (hash || ''));
      return load().then(loadSheets).catch(() => {});
    };
    window.addEventListener('popstate', () => {
      const m = /^\/w\/([^/]+)\//.exec(location.pathname);
      if (m && decodeURIComponent(m[1]) !== w) goWorkspace(decodeURIComponent(m[1]), '', false).then(draw);
    });
    el.addEventListener('click', async (e) => {
      const wl = e.target.closest && e.target.closest('a[data-ws]');
      if (wl && !q.get('src') && e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
        e.preventDefault(); e.stopPropagation();
        return void goWorkspace(wl.dataset.ws, wl.dataset.hash || '', true);
      }
      const ar = e.target.closest && e.target.closest('[data-arch]');
      if (ar) { // 보관·꺼내기 — ticket.json user.archived만 쓴다. 다른 곳에서 먼저 바꿨으면 서버 값으로 다시 그린다
        const [w, slug, on] = ar.dataset.arch.split('|');
        e.preventDefault(); e.stopPropagation();
        try {
          await fetch('/w/' + encodeURIComponent(w) + '/api/ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sheet: slug, user: { archived: on === '1' }, base: { archived: on !== '1' } }) });
        } catch (err) { /* 연결이 끊기면 아래 새로 읽기에서 원래 값이 그대로 보인다 */ }
        if (on === '1') location.hash = '#archive';
        await Promise.all([loadSheets(), load().catch(() => {})]);
        return;
      }
      const b = svOf(e.target);
      if (b) {
        const d = b.dataset;
        if (d.sv === 'disp') pop = pop === 'disp' ? null : 'disp';
        else if (d.sv === 'filter') pop = pop && pop.indexOf('filter') === 0 ? null : 'filter';
        else if (d.svMenu) pop = 'filter:' + d.svMenu;
        else {
          prefs = Sheet.reduce(prefs, { sv: d.sv, set: d.svSet, tog: d.svTog, prop: d.svProp, add: d.svAdd, del: d.svDel });
          if (d.svAdd) pop = null;
          savePrefs();
        }
        e.preventDefault(); e.stopPropagation();
        return draw();
      }
      if (e.target.closest && e.target.closest('[data-sheet-fold]')) { doneOpen = !doneOpen; return draw(); }
      if (pop && !(e.target.closest && e.target.closest('[data-pop]'))) { pop = null; draw(); }
    }, true);
    el.addEventListener('input', (e) => {
      if (e.target.matches && e.target.matches('[data-sheet-q]')) { sq = e.target.value; draw(); }
    });
    document.addEventListener('keydown', (e) => {
      if (parseHash(location.hash).view !== 'sheet' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.matches && e.target.matches('input,textarea,select')) return;
      if ((ctl && ctl.current()) || document.querySelector('.layer .modal, .tm-box, .nm')) return; // 모달이 열려 있으면 모달 몫
      const k = e.key.toLowerCase();
      if (k === 'escape' && pop) { pop = null; return draw(); }
      if (k === 'h') { prefs = Sheet.reduce(prefs, { sv: 'hide' }); savePrefs(); e.preventDefault(); return draw(); }
      if (k === 'f') { pop = 'filter'; e.preventDefault(); return draw(); }
    });
    el.addEventListener('click', (e) => {
      const f = e.target.closest && e.target.closest('[data-tix-fold]');
      if (f) {
        const k = f.getAttribute('data-tix-fold');
        if (tix.has(k)) tix.delete(k); else tix.add(k);
        return draw();
      }
      const t = ctl && e.target.closest && e.target.closest('[data-dec]');
      if (!t || !ctl.open(t.getAttribute('data-ticket'), t.getAttribute('data-dec'))) return;
      e.preventDefault(); e.stopPropagation(); // 카드 자체의 눌림(노드 모달)과 겹치지 않게
    });
    el.addEventListener('keydown', (e) => {
      const t = ctl && e.target.closest && e.target.closest('.drow[data-dec], .it[data-dec]');
      if (t && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        ctl.open(t.getAttribute('data-ticket'), t.getAttribute('data-dec'));
      }
    });
    layer.addEventListener('click', (e) => {
      if (!ctl) return;
      if (e.target.closest('[data-modal-close]')) return ctl.close();
      if (e.target.closest('[data-dec-submit]')) return void ctl.submit();
      const o = e.target.closest('[data-opt]');
      if (o) { e.preventDefault(); ctl.choose(o.getAttribute('data-opt')); }
    });
    layer.addEventListener('input', (e) => {
      if (!ctl || !e.target.matches('[data-dec-text]')) return;
      ctl.setText(e.target.value);
      const b = layer.querySelector('[data-dec-submit]');
      if (b) b.disabled = !ctl.canSubmit();
    });
    document.addEventListener('keydown', (e) => {
      if (!ctl || !ctl.current()) return;
      if (e.key === 'Escape') return ctl.close();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); return void ctl.submit(); }
      const typing = e.target.matches && e.target.matches('textarea,input');
      if (!typing && /^[1-9]$/.test(e.key)) ctl.chooseNth(Number(e.key));
    });

    // 뒤에서 붙는 모달(티켓·노드)이 모델을 읽고 다시 그리게 손잡이를 준다
    return load()
      .then(() => { loadSheets(); })
      .then(() => ({ getModel: () => model, redraw: draw }))
      .catch((e) => { el.innerHTML = `<main class="main surface"><div class="view"><div class="empty">보드를 못 읽었어요 (${esc(e.message)})</div></div></main>`; });
  }

  return { esc, card, sidebar, stage, page, sprite, mount, modalShell, pick, isBare, chooseWorkspace, ticketColor, shortName, slugOf, progress, parseHash, hashOf, paint, safeSrc };
});
