/* Sheet — 시트(티켓 하나 = 작업 단위) 화면 조각. 순수 함수는 HTML 문자열만 낸다.
   side(): 사이드바 — 시트 찾기 · Inbox · Decisions · 시트 목록(진행 중 / 준비 / 끝남 접힘).
   page(): 시트 화면 — 머리(레포 › 이름, 흐름·spec.md, 저장된 보기, 끝남 숨김·필터·보기), 필터 칩 띠, 흐름 목록, 속성 패널.
   보기 설정은 mount가 localStorage에 둔다. 여기서는 받은 값만 그린다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./flow.js'), require('./verdict.js'));
  else root.BoardSheet = factory(root.BoardFlow, root.BoardVerdict);
})(typeof self !== 'undefined' ? self : this, function (Flow, Verdict) {
  'use strict';

  const GROUPS = ['진행 중', '준비', '끝남'];
  const REVIEW = { ok: '승인', fix: '수정', no: '미실행', skip: '생략' };
  const FILTER_STATES = ['진행', '확인 대기', '막힘', '시작 가능', '기다림', '끝남'];

  /* 제목이 "slug — 이름"이면 이름을, "이름 — 설명"이면 이름을 쓴다. */
  function sheetName(title, slug) {
    const parts = String(title || '').split(/\s+[—–]\s+/);
    const tail = String(slug || '').split('/').pop();
    if (parts.length > 1 && (parts[0] === tail || /^[a-z0-9._-]+$/.test(parts[0]))) return parts[1];
    return parts[0] || tail;
  }

  /* 서버 /api/sheets가 없을 때(정적 ?src=) 지금 모델에서 같은 모양을 만든다. 규칙은 spec_model.sheet_state와 같다. */
  function fromModel(model) {
    const out = [];
    for (const p of (model && model.projects) || []) {
      for (const t of p.tickets || []) {
        const nodes = (t.nodes || []).filter((n) => !n.error);
        const waves = t.waves || [];
        let group = '진행 중';
        if (t.state === '끝남' || (nodes.length && nodes.every((n) => n.state === '끝남'))) group = '끝남';
        else if (!nodes.length || (nodes.every((n) => n.state === '아직 안 함') && !waves.length)) group = '준비';
        out.push({
          workspace: model.workspace || '', repo: String(model.root || '').split('/').filter(Boolean).pop() || '',
          slug: t.slug, title: t.title, group, done: nodes.filter((n) => n.state === '끝남').length, total: nodes.length,
          blocking: (t.rows || []).filter((r) => r.kind === 'decision' && r.blocking).length,
          to_check: nodes.filter((n) => n.state === '확인 대기').length, last: waves.length ? waves[waves.length - 1].at : '', archived: !!t.archived,
        });
      }
    }
    return out.sort((a, b) => String(b.last).localeCompare(String(a.last)));
  }

  function ago(at, now) {
    if (!at) return '';
    const d = new Date(String(at).replace(' ', 'T') + (String(at).length > 10 ? ':00+09:00' : 'T23:59:00+09:00'));
    const m = Math.round(((now || Date.now()) - d.getTime()) / 60000);
    if (!isFinite(m)) return '';
    if (m < 60) return Math.max(m, 1) + '분';
    if (m < 60 * 24) return Math.round(m / 60) + '시간';
    return Math.round(m / 1440) + '일';
  }

  /* 사이드바. sheets = /api/sheets 목록, cur = {workspace, slug}, sum = 지금 워크스페이스 요약(Inbox·Decisions 숫자),
     ui = {esc, icon, nav, q(찾기 글자), doneOpen, now}. 다른 워크스페이스의 시트는 그 보드 주소로 간다. */
  function side(sheets, cur, sum, ui) {
    const esc = ui.esc;
    const q = String(ui.q || '').trim().toLowerCase();
    const inbox = ((sum && sum.decisions_open) || 0) + ((sum && sum.to_check) || 0);
    const blocking = (sum && sum.decisions_blocking) || 0;
    let h = '<aside class="side surface">' +
      '<label class="sq"><input type="search" data-sheet-q placeholder="시트 찾기" value="' + esc(ui.q || '') + '" autocomplete="off"></label>' +
      ui.nav('Inbox', 'i-inbox', '#inbox', ui.view === 'inbox', (ui.fresh && ui.fresh.size ? '<span class="newdot" title="새로 온 할 일"></span>' : '') + (inbox ? '<span class="c">' + inbox + '</span>' : '')) +
      ui.nav('Decisions', 's-dec', '#dec', ui.view === 'dec', blocking ? '<span class="badge-dec">' + blocking + '</span>' : '');
    const match = (s) => !q || (sheetName(s.title, s.slug) + ' ' + s.slug + ' ' + s.repo).toLowerCase().includes(q);
    for (const g of GROUPS) {
      const list = (sheets || []).filter((s) => !s.archived && s.group === g && match(s));
      if (!list.length) continue;
      const fold = g === '끝남' && !q;
      const open = !fold || !!ui.doneOpen;
      h += fold
        ? '<button type="button" class="sh fold" data-sheet-fold aria-expanded="' + open + '"><span class="chev">' + (open ? '▾' : '▸') + '</span>' + esc(g) + '<span class="n">' + list.length + '</span></button>'
        : '<div class="sh">' + esc(g) + '<span class="n">' + list.length + '</span></div>';
      if (!open) continue;
      for (const s of list) {
        const here = cur && s.workspace === cur.workspace && s.slug === cur.slug;
        const href = cur && s.workspace === cur.workspace ? '#s/' + s.slug : '/w/' + encodeURIComponent(s.workspace) + '/board/#s/' + s.slug;
        const st = g === '끝남' ? ['s-done', 'done'] : g === '준비' ? ['s-todo', 'todo'] : ['s-prog', 'prog'];
        const isNew = !!(ui.fresh && ui.fresh.has(s.workspace + '|' + s.slug));
        const tail = s.blocking ? '<span class="badge-dec">◆' + s.blocking + '</span>' : '<span class="rt">' + esc(ago(s.last, ui.now)) + '</span>';
        const right = isNew ? '<span class="srr"><span class="newdot" title="새로 온 할 일"></span>' + tail + '</span>' : tail; // 줄의 세 번째 칸 하나에
        h += '<a class="sr' + (here ? ' on' : '') + (g === '끝남' ? ' is-done' : '') + '" href="' + esc(href) + '"' + (cur && s.workspace !== cur.workspace ? ' data-ws="' + esc(s.workspace) + '" data-hash="#s/' + esc(s.slug) + '"' : '') + (here ? ' aria-current="page"' : '') + '>' +
          ui.icon(st[0], 'st st-' + st[1]) + '<span class="sm"><span class="tt">' + esc(sheetName(s.title, s.slug)) + '</span>' +
          '<span class="meta"><span class="tk tk-' + ui.color(s.slug) + '"></span>' + esc(s.repo) + (s.total ? ' · ' + s.done + '/' + s.total : '') + '</span></span>' + right + '</a>';
      }
    }
    const nArch = (sheets || []).filter((s) => s.archived).length;
    h += '<div class="sfoot">' + (ui.live || '') + '<a class="nav' + (ui.view === 'archive' ? ' on' : '') + '" href="#archive"><span class="t">보관</span>' + (nArch ? '<span class="c">' + nArch + '</span>' : '') + '</a>' +
      '<a class="nav' + (ui.view === 'repos' ? ' on' : '') + '" href="#repos"><span class="t">Repos &amp; 서비스</span></a></div>';
    return h + '</aside>';
  }

  // ── 보관·Repos & 서비스 ─────────────────────────────────────

  /* 보관한 시트 목록. 꺼내기 = 보관 칸만 거둔다. 시트 줄을 누르면 그 시트가 열린다. */
  function archiveHtml(sheets, cur, ui) {
    const esc = ui.esc;
    const list = (sheets || []).filter((s) => s.archived);
    if (!list.length) return '<div class="empty">보관한 시트가 없어요</div>';
    return '<div class="arch">' + list.map((s) => {
      const href = cur && s.workspace === cur.workspace ? '#s/' + s.slug : '/w/' + encodeURIComponent(s.workspace) + '/board/#s/' + s.slug;
      const other = cur && s.workspace !== cur.workspace ? ' data-ws="' + esc(s.workspace) + '" data-hash="#s/' + esc(s.slug) + '"' : '';
      return '<div class="arow"><a class="aname" href="' + esc(href) + '"' + other + '><span class="tk tk-' + ui.color(s.slug) + '"></span><b>' + esc(sheetName(s.title, s.slug)) + '</b>' +
        '<span class="meta">' + esc(s.repo) + (s.total ? ' · ' + s.done + '/' + s.total : '') + (s.blocking ? ' · ◆' + s.blocking : '') + '</span></a>' +
        '<button type="button" class="tbtn" data-arch="' + esc(s.workspace + '|' + s.slug + '|0') + '">꺼내기</button></div>';
    }).join('') + '</div>';
  }

  /* 등록된 워크스페이스(레포)와 보드 서비스 상태. repos = /api/repos. */
  function reposHtml(repos, ui) {
    const esc = ui.esc;
    if (!repos) return '<div class="empty">불러오는 중이에요</div>';
    const sv = repos.service || {};
    let h = '<div class="repos"><div class="svc"><span class="live"></span><b>보드 서비스</b>' +
      '<span class="mono">127.0.0.1:' + esc(sv.port) + '</span>' + (sv.version ? '<span class="mono">v' + esc(sv.version) + '</span>' : '') + '</div>' +
      '<div class="rh"><span>워크스페이스</span><span>경로</span><span class="r">시트</span><span class="r">보관</span></div>';
    for (const w of repos.workspaces || []) {
      h += '<a class="rr" href="/w/' + encodeURIComponent(w.workspace) + '/board/" data-ws="' + esc(w.workspace) + '" data-hash="#inbox"><span class="rn"><span class="tk tk-' + ui.color(w.workspace) + '"></span>' + esc(w.workspace) +
        '</span><span class="mono rp">' + esc(w.root) + '</span><span class="mono r">' + w.sheets + '</span><span class="mono r">' + (w.archived || '') + '</span></a>';
    }
    return h + '</div>';
  }

  // ── 시트 화면 ────────────────────────────────────────────

  const seg = (name, cur, opts, esc) => '<div class="seg">' + opts.map(([v, l]) =>
    '<button type="button" class="' + (cur === v ? 'on' : '') + '" data-sv-set="' + esc(name + ':' + v) + '">' + esc(l) + '</button>').join('') + '</div>';

  function display(p, esc) {
    const props = new Set(p.props || []);
    const sw = (k, on, label) => '<button type="button" class="row sw-row" data-sv-tog="' + k + '"><span>' + esc(label) + '</span><span class="sw' + (on ? ' on' : '') + '"></span></button>';
    return '<div class="pop dpop" data-pop>' +
      '<div class="row"><span>묶기</span>' + seg('group', p.group, [['wave', '웨이브'], ['state', '상태'], ['none', '없음']], esc) + '</div>' +
      '<div class="row"><span>순서</span>' + seg('order', p.order, [['in', '들어온 순서'], ['recent', '최근 바뀐'], ['id', 'ID']], esc) + '</div>' +
      '<hr><div class="row"><span>끝난 노드</span>' + seg('done', p.done, [['all', '모두'], ['today', '오늘'], ['hide', '숨김']], esc) + '</div>' +
      sw('empty', p.empty, '빈 웨이브 묶음') + sw('fold', p.fold, '옛 웨이브 접기') +
      '<hr><div class="h">줄에 보일 것</div><div class="pills">' +
      [['id', 'ID'], ['state', '상태'], ['time', '시각'], ['wave', '웨이브']].map(([k, l]) =>
        '<button type="button" class="' + (props.has(k) ? 'on' : '') + '" data-sv-prop="' + k + '">' + esc(l) + '</button>').join('') +
      '</div></div>';
  }

  function filterMenu(menu, t, esc) {
    let h = '<div class="pop fpop" data-pop>';
    if (menu === 'state') {
      h += '<div class="fh">상태</div>' + FILTER_STATES.map((s) => '<button type="button" class="fo" data-sv-add="' + esc('state:' + s) + '">' + esc(s) + '</button>').join('');
    } else if (menu === 'since') {
      const ws = (t.waves || []).slice().reverse();
      h += '<div class="fh">이 웨이브부터</div>' + (ws.length ? ws.map((w) => '<button type="button" class="fo" data-sv-add="since:' + w.w + '">W' + w.w + '<span class="r">' + esc(String(w.at).slice(5)) + '</span></button>').join('') : '<div class="fh">웨이브 없음</div>');
    } else {
      h += '<button type="button" class="fo" data-sv-menu="state">상태<span class="r">S</span></button>' +
        '<button type="button" class="fo" data-sv-menu="since">웨이브<span class="r">W</span></button>' +
        '<button type="button" class="fo" data-sv-add="human">사람 필요 (확인 대기·막힘)</button>' +
        '<button type="button" class="fo" data-sv-add="blocked">결정에 막힘</button>';
    }
    return h + '</div>';
  }

  function chip(f, i, esc) {
    const [k, op, v] = f.k === 'state' ? ['상태', '은', f.v] : f.k === 'since' ? ['웨이브', '부터', 'W' + f.v] : f.k === 'human' ? ['사람 필요', '', ''] : ['결정에 막힘', '', ''];
    return '<span class="fc"><span class="k">' + esc(k) + '</span>' + (op ? '<span>' + esc(op) + '</span>' : '') + (v ? '<span class="v">' + esc(v) + '</span>' : '') +
      '<button type="button" class="x" data-sv-del="' + i + '" aria-label="필터 지우기">✕</button></span>';
  }

  function props(t, model, ui) {
    const esc = ui.esc;
    const nodes = (t.nodes || []).filter((n) => !n.error);
    const done = nodes.filter((n) => n.state === '끝남').length;
    const step = nodes.length ? Math.round((done / nodes.length) * 10) : 0;
    const waves = t.waves || [];
    const rv = {};
    for (const w of waves) if (w.review) rv[w.review] = (rv[w.review] || 0) + 1;
    const tm = (w) => String(w.at).slice(11) || String(w.at).slice(5, 10); // 시각이 없는 보고서는 날짜로
    const span = !waves.length ? '' : tm(waves[0]) === tm(waves[waves.length - 1]) ? tm(waves[0]) : tm(waves[0]) + '–' + tm(waves[waves.length - 1]);
    const ids = {};
    for (const n of t.nodes || []) ids[n.key] = n.id || n.key;
    const act = waves.slice(-6).reverse().map((w) => '<div class="ar"><span class="aw">W' + w.w + '</span><span>' +
      esc((w.nodes || []).map((r) => (ids[r.key] || r.key) + ' ' + r.state).join(' · ')) + '</span><span class="at">' + esc(String(w.at).slice(11) || String(w.at).slice(5)) + '</span></div>').join('');
    return '<aside class="props">' +
      '<div class="ph">속성</div><div class="pr">' +
      '<span>진행</span><span class="pg"><i><b class="w' + step + '"></b></i>' + done + ' / ' + nodes.length + '</span>' +
      '<span>웨이브</span><span class="mono">' + waves.length + (span ? ' · ' + esc(span) : '') + '</span>' +
      (Object.keys(rv).length ? '<span>리뷰</span><span class="rvs">' + ['ok', 'fix', 'no', 'skip'].filter((k) => rv[k]).map((k) => '<span class="rv rv-' + k + '">' + REVIEW[k] + ' ' + rv[k] + '</span>').join('') + '</span>' : '') +
      '<span>레포</span><span class="mono">' + esc(model.workspace || '') + '</span>' +
      (model.branch ? '<span>브랜치</span><span class="mono">' + esc(model.branch) + '</span>' : '') +
      '<span>spec</span><span class="mono">spec/' + esc(t.slug) + '</span>' + wakeRow(t, model, ui) + '</div>' +
      (ui.tab === 'dec' ? '' : decs(t, model, ui)) + // 결정 탭에서는 본문이 같은 목록이라 패널에서 뺀다
      (act ? '<div class="ph">최근 웨이브</div><div class="act">' + act + '</div>' : '') + '</aside>';
  }

  /* 깨우기 — 사람이 답하면 깨울 담당 스레드(apply·pending을 부른 메인 스레드)와 켬/끔(ticket.json user.wake, board-wake D4) */
  function wakeRow(t, model, ui) {
    const esc = ui.esc;
    const a = t.agent || {};
    const ws = ui.workspace || model.workspace || '';
    const on = t.wake !== false;
    const who = a.thread
      ? '<a class="mono" href="codex://threads/' + esc(encodeURIComponent(a.thread)) + '" title="' + esc(a.thread + (a.since ? ' · ' + a.since + '부터' : '')) + '">' + esc(a.thread.slice(0, 13)) + '</a>'
      : ownerPick(t, ws, ui);
    // 반영 대기 — 답했지만 아직 열린 결정, 통과·고쳐줘를 남긴 확인 대기 노드. 담당에게 다시 보낼 수 있다
    const waiting = (t.rows || []).filter((r) => r && r.kind === 'decision' && (r.open != null ? r.open : r.status !== '끝남') && String((r.user || {}).answer || '').trim()).length +
      (t.nodes || []).filter((n) => n.state === '확인 대기' && (n.verdict === '통과' || n.verdict === '고쳐줘')).length;
    const nudge = a.thread && on && waiting
      ? '<button type="button" class="wk nudge" data-nudge="' + esc(ws + '|' + t.slug) + '" title="담당 스레드를 지금 깨워 반영하게 해요">반영 대기 ' + waiting + '건 보내기</button>' : '';
    // 문맥 — 담당 스레드가 읽는 문맥 크기. 크고 웨이브가 없으면 릴레이를 요청할 수 있다(board-wake D7)
    const own = (ui.owners || []).find((o) => a.thread && o.thread === a.thread) || {};
    const ctx = own.tokens ? '<span class="mono ctx' + (own.relay ? ' big' : '') + '" title="담당 스레드가 호출마다 읽는 문맥">문맥 ' + Math.round(own.tokens / 10000) + '만</span>' : '';
    const relay = own.relay
      ? '<button type="button" class="wk relay" data-relay="' + esc(ws + '|' + t.slug) + '" title="담당 스레드에 릴레이(새 스레드로 넘기기)를 요청해요. 웨이브가 없을 때만 보여요">릴레이 요청</button>'
      : (own.tokens && own.running ? '<span class="mono ctx" title="웨이브가 끝난 뒤에 넘길 수 있어요">웨이브 중</span>' : '');
    return '<span>깨우기</span><span class="pwake">' + who +
      '<button type="button" class="wk' + (on ? ' on' : '') + '" data-wake="' + esc(ws + '|' + t.slug + '|' + (on ? '0' : '1')) + '" aria-pressed="' + on + '">' + (on ? '켬' : '끔') + '</button>' + nudge + ctx + relay + '</span>';
  }

  // 담당 정하기 — 다른 시트를 맡고 있는 스레드 중에서 고른다(ui.owners = /api/outbox의 owners)
  function ownerPick(t, ws, ui) {
    const esc = ui.esc;
    const list = (ui.owners || []).map((o) => {
      const names = [...new Set((o.sheets || []).map((s) => String(s.slug).split('/').pop()))];
      return '<option value="' + esc(o.thread) + '">' + esc(o.thread.slice(0, 13) + ' · ' + names.slice(0, 2).join(', ') + (names.length > 2 ? ' 외 ' + (names.length - 2) : '')) + '</option>';
    }).join('');
    return '<span class="mono" title="메인 스레드가 spec-board pending을 부르면 생겨요">없음</span>' +
      (list ? '<select class="wk" data-owner-sel="' + esc(ws + '|' + t.slug) + '" aria-label="담당 스레드 정하기"><option value="">담당 정하기…</option>' + list + '</select>' : '');
  }

  /* 속성 패널의 결정 칸 — 이 시트의 결정 행. 답할 것(막는 결정 먼저) → 답함·반영 대기 → 끝남 순서.
     줄을 누르면 결정 모달이 열린다(view.js의 [data-dec] 위임 — Inbox·Decisions와 같은 길). 여기서는 아무것도 쓰지 않는다. */
  function decs(t, model, ui) {
    const esc = ui.esc;
    const all = (t.rows || []).filter((r) => r && r.kind === 'decision');
    if (!all.length) return '';
    const ws = ui.workspace || model.workspace || '';
    const isOpen = (d) => (d.open != null ? !!d.open : d.status !== '끝남');
    const ans = (d) => String((d.user || {}).answer || '').trim();
    const opt = (d, k) => (Array.isArray(d.options) ? d.options : []).find((o) => o && String(o.key) === String(k));
    const label = (d, k) => { const o = opt(d, k); return o ? o.key + ' ' + (o.label || '') : k; };
    const hard = (d) => isOpen(d) && d.reversible === false && !ans(d);
    const sid = (d) => String(d.display_id || d.id || '').split('-').pop(); // 시트 안이라 앞의 시트 머리는 빼고 D1만
    const todo = all.filter((d) => isOpen(d) && !ans(d)).sort((a, b) => (hard(b) ? 1 : 0) - (hard(a) ? 1 : 0));
    const waiting = all.filter((d) => isOpen(d) && ans(d));
    const done = all.filter((d) => !isOpen(d));
    const row = (d, cls, ic, sub) => '<div class="pdec is-' + cls + '" role="button" tabindex="0" data-dec="' + esc(d.display_id) + '" data-ticket="' + esc(t.slug) + '" data-dec-ws="' + esc(ws) + '">' +
      ui.icon(ic, 'st st-' + cls) + '<span class="pdt"><span class="pdh"><span class="id" title="' + esc(d.display_id) + '">' + esc(sid(d)) + '</span>' + esc(d.title) + '</span>' +
      (sub ? '<span class="pds">' + esc(sub) + '</span>' : '') + '</span></div>';
    let h = '<div class="ph">결정 <span class="n">' + (todo.length ? '답할 ' + todo.length + ' · ' : '') + '전체 ' + all.length + '</span></div><div class="pdecs">';
    h += todo.map((d) => hard(d)
      ? row(d, 'blk', 's-dec', '되돌리기 어려움' + (d.recommend && opt(d, d.recommend) ? ' · 추천 ' + label(d, d.recommend) : ''))
      : row(d, 'todo', 's-todo', d.recommend && opt(d, d.recommend) ? '추천 ' + label(d, d.recommend) + ' · 답 없으면 추천대로' : '')).join('');
    h += waiting.map((d) => row(d, 'todo', 's-todo', '답 ' + label(d, ans(d)) + ' · 반영 대기')).join('');
    h += done.map((d) => row(d, 'done', 's-done', ans(d) ? '답 ' + label(d, ans(d)) : d.recommend && opt(d, d.recommend) ? '추천대로 ' + label(d, d.recommend) : '끝남')).join('');
    return h + '</div>';
  }

  /* p = 보기 설정, open = 열린 팝오버('disp' | 'filter' | 'filter:state' | 'filter:since' | null).
     ui = {esc, icon, look, workspace, state, color, today}. */
  function page(t, model, p, open, ui) {
    const esc = ui.esc;
    const decTab = ui.tab === 'dec'; // 결정 탭(#sd/<시트>) — 본문은 이 시트의 결정 목록, 흐름 전용 버튼은 숨긴다
    const nTodo = (t.rows || []).filter((r) => r && r.kind === 'decision' && (r.open != null ? r.open : r.status !== '끝남') && !String((r.user || {}).answer || '').trim()).length;
    p = Object.assign({}, Flow.DEFAULTS, p || {});
    const repo = String(model.root || '').split('/').filter(Boolean).pop() || model.workspace || '';
    const views = [['all', '전체'], ['mine', '내 차례'], ['today', '오늘']].map(([v, l]) =>
      '<button type="button" class="vt' + (p.view === v ? ' on' : '') + '" data-sv-set="view:' + v + '">' + l + '<span class="n">' + Flow.viewCount(t, v, ui.today) + '</span></button>').join('');
    const filterOpen = !decTab && open && open.indexOf('filter') === 0;
    const filters = decTab ? [] : p.filters || [];
    const tab = (on, href, label) => '<a class="tab' + (on ? ' on' : '') + '" href="' + esc(href) + '"' + (on ? ' aria-current="page"' : '') + '>' + label + '</a>';
    let h = '<main class="main surface sheetp">' +
      '<div class="shead"><span class="crumb"><span class="tk tk-' + ui.color(t.slug) + '"></span>' + esc(repo) + ' › <b>' + esc(sheetName(t.title, t.slug)) + '</b></span>' +
      '<span class="tabs">' + tab(!decTab, '#s/' + t.slug, '흐름') +
      tab(decTab, '#sd/' + t.slug, '결정' + (nTodo ? '<span class="badge-dec">' + nTodo + '</span>' : '')) +
      '<button type="button" class="tab" data-ticket="' + esc(t.slug) + '">spec.md</button></span>' +
      (decTab ? '' : '<span class="views">' + views + '</span>') + '<span class="sp"></span>' +
      '<button type="button" class="tbtn" data-arch="' + esc((ui.workspace || model.workspace || '') + '|' + t.slug + '|1') + '">보관</button>' +
      (decTab ? '' :
        '<button type="button" class="tbtn' + (p.done === 'hide' ? ' on' : '') + '" data-sv="hide" aria-pressed="' + (p.done === 'hide') + '">끝남 숨김 <kbd>H</kbd></button>' +
        '<button type="button" class="tbtn' + (filterOpen || filters.length ? ' on' : '') + '" data-sv="filter">' + ui.icon('i-filter', 'ni') + '필터 <kbd>F</kbd></button>' +
        '<button type="button" class="tbtn' + (open === 'disp' ? ' on' : '') + '" data-sv="disp">' + ui.icon('i-disp', 'ni') + '보기</button>') + '</div>';
    if (filters.length) {
      h += '<div class="fbar">' + filters.map((f, i) => chip(f, i, esc)).join('') +
        '<button type="button" class="addf" data-sv="filter">+ 필터</button><button type="button" class="clr" data-sv="clear">지우기</button></div>';
    }
    const body = !decTab ? Flow.list(t, 0, ui, p)
      : (t.rows || []).some((r) => r && r.kind === 'decision') && ui.decMenu ? ui.decMenu(t)
        : '<div class="empty">이 시트에는 결정이 없어요</div>';
    h += '<div class="sbody"><div class="view ' + (decTab ? 'sdec' : 'slist') + '">' + body + '</div>' + props(t, model, ui) + '</div>';
    if (!decTab && open === 'disp') h += display(p, esc);
    if (filterOpen) h += filterMenu(open.split(':')[1] || '', t, esc);
    return h + '</main>';
  }

  // ── 보기 설정 다루기 (mount가 부른다) ─────────────────────

  /* data-sv-* 동작 하나를 설정에 반영한 새 객체. 바꿀 것이 없으면 같은 값을 돌려준다. */
  function reduce(p, act) {
    p = Object.assign({}, Flow.DEFAULTS, p || {});
    const n = Object.assign({}, p, { filters: (p.filters || []).slice(), props: (p.props || []).slice() });
    if (act.set) {
      const [k, v] = act.set.split(':');
      if (['group', 'order', 'done', 'view'].includes(k)) n[k] = v;
    } else if (act.tog) {
      if (act.tog === 'empty' || act.tog === 'fold') n[act.tog] = !n[act.tog];
    } else if (act.prop) {
      n.props = n.props.includes(act.prop) ? n.props.filter((x) => x !== act.prop) : n.props.concat(act.prop);
    } else if (act.add) {
      const [k, ...rest] = act.add.split(':');
      const f = rest.length ? { k, v: rest.join(':') } : { k };
      if (!n.filters.some((x) => x.k === f.k && x.v === f.v)) n.filters.push(f);
    } else if (act.del != null) {
      n.filters.splice(Number(act.del), 1);
    } else if (act.sv === 'clear') {
      n.filters = [];
    } else if (act.sv === 'hide') {
      n.done = n.done === 'hide' ? 'all' : 'hide';
    } else if (act.sv === 'done-all') {
      n.done = 'all';
    }
    return n;
  }

  /* localStorage 값 → 설정. 모르는 값은 기본으로. */
  function load(raw) {
    let o = {};
    try { o = JSON.parse(raw || '{}') || {}; } catch (e) { o = {}; }
    const d = Flow.DEFAULTS;
    const pick = (k, ok) => (ok.includes(o[k]) ? o[k] : d[k]);
    return {
      group: pick('group', ['wave', 'state', 'none']), order: pick('order', ['in', 'recent', 'id']),
      done: pick('done', ['all', 'today', 'hide']), view: pick('view', ['all', 'mine', 'today']),
      empty: typeof o.empty === 'boolean' ? o.empty : d.empty, fold: typeof o.fold === 'boolean' ? o.fold : d.fold,
      props: Array.isArray(o.props) ? o.props.filter((x) => ['id', 'state', 'time', 'wave'].includes(x)) : d.props.slice(),
      filters: Array.isArray(o.filters) ? o.filters.filter((f) => f && ['state', 'since', 'human', 'blocked'].includes(f.k)) : [],
    };
  }

  return { GROUPS, sheetName, fromModel, ago, side, page, props, reduce, load, archiveHtml, reposHtml };
});
