/* 노드 모달 — 카드를 누르면 열린다. 담당 시나리오·먼저 끝나야 함·다음과 상태별 버튼을 보인다.
   통과·고쳐줘는 `rows/nodes/<노드>.json`의 user.verdict·user.fix에만 쓴다(D3) — 상태는 에이전트 몫이다.
   보드는 runner를 띄우거나 멈추지 않는다 — 실행은 채팅의 /go다(D-R2).
   순수 함수(actions·dialog)와 DOM 없는 controller, DOM을 만지는 mount로 나눴다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./verdict.js'));
  else root.BoardNodeModal = factory(root.BoardVerdict);
})(typeof self !== 'undefined' ? self : this, function (Verdict) {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // 버튼 표 — 저장 상태마다 이 버튼들만 보인다.
  const VERBS = {
    fix: { label: '고쳐줘' },
    pass: { label: '통과', primary: true },
    commits: { label: '커밋 보기' },
  };

  function verbIds(node) {
    if (!node || node.error) return [];
    switch (node.state) {
      case '확인 대기': return ['fix', 'pass'];
      case '끝남': return ['commits'];
      default: return []; // 시작 가능·막힘·보류·기다림은 사람이 누를 것이 없다 — 시작은 채팅의 /go, 막힘은 결정 메뉴가 푼다
    }
  }

  function actions(node) {
    return verbIds(node);
  }

  const find = (list, key) => (list || []).find((x) => x.key === key || x.id === key);

  function section(title, body) {
    return `<section class="nm-s"><h3 class="nm-h">${esc(title)}</h3>${body}</section>`;
  }
  const listOf = (items) => (items.length ? `<ul class="nm-list">${items.join('')}</ul>` : '');
  const dim = (t) => `<p class="nm-dim">${esc(t)}</p>`;
  const OPENER = '.card[data-tkt][data-key], [data-nm-open][data-tkt][data-key]';
  // 글 안의 `코드`와 **굵게**만 태그로 — esc 뒤에 바꾸므로 다른 태그는 못 만든다
  const rich = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const isImage = (f) => /\.(png|jpe?g|webp|gif)$/i.test(String(f));
  // 근거 이미지 주소 — 서버의 GET /w/<w>/api/evidence. 같은 출처라 CSP(default-src 'self')를 그대로 지킨다
  const evidenceUrl = (ws, slug, key, name) =>
    `/w/${encodeURIComponent(ws || '')}/api/evidence?sheet=${encodeURIComponent(slug)}&id=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}`;
  const checkItems = (node) => ((node && node.checks && node.checks.items) || []);
  /* 결정의 고른 답 — 답 칸이 있으면 그것, 없으면 로그의 "→ K"(마지막), 그것도 없으면 추천. 선택지 글자가 아니라 그 글을 보인다. */
  function choiceText(r) {
    const opts = r.options || [];
    const byKey = (k) => opts.find((o) => o.key === k);
    const ans = String((r.user && r.user.answer) || '').trim();
    if (ans) return byKey(ans) ? byKey(ans).label : ans;
    const hit = [...(r.log || [])].reverse().map((l) => /→\s*([A-Za-z0-9]+)/.exec(l)).find(Boolean);
    const o = byKey(hit ? hit[1] : r.recommend);
    return o ? o.label : '';
  }
  // 이 노드를 막았다가 이미 정해진 결정들 — 질문과 고른 답만
  const decidedOf = (node, ticket) => (ticket.rows || [])
    .filter((r) => r.kind === 'decision' && !r.open && (r.blocked_nodes || []).includes(node.key))
    .map((r) => ({ q: r.title, a: choiceText(r) })).filter((d) => d.a);
  // 담당 시나리오 가운데 Given·When·Then이 있는 것
  const gwtRows = (node, ticket) => (node.rows || []).map((rid) => (ticket.rows || []).find((x) => x.id === rid))
    .filter((r) => r && (r.given || r.when || r.then));

  // 상태 배지 — 아이콘과 색은 Tickets 목록과 같다 (board.css의 .st-*)
  const BADGE = { '진행': ['s-prog', 'prog'], '확인 대기': ['s-rev', 'rev'], '막힘': ['s-blk', 'blk'], '끝남': ['s-done', 'done'], '보류': ['s-wait', 'hold'] };
  const hintOf = (n) => (n ? `${n}개 체크됨 — 고쳐줘로 보내기` : '문제가 있으면 체크하고 고쳐줘');
  // 고쳐줘로 보낼 글 — 체크한 항목(줄마다 "- ")과 자유 입력. 둘 다 비면 빈 문자열이다
  function composeFix(node, checked, free) {
    const lines = checkItems(node).filter((_, i) => (checked || []).includes(i)).map((t) => `- ${t}`);
    const f = String(free || '').trim();
    return [...lines, ...(f ? [f] : [])].join('\n');
  }

  /* 모달 HTML. ticket은 노드가 속한 티켓(nodes·rows)이고 ui는 {fixing, draft, busy, msg, err, commits}다. */
  function dialog(node, ctx) {
    ctx = ctx || {};
    const ticket = ctx.ticket || {};
    const ui = ctx.ui || {};
    const eff = Verdict.effective(node);

    const why = (node.why && node.why.length ? node.why : (node.problem ? [node.problem] : []));
    let body = '';
    if (why.length) body += section('왜 했나', '<ul class="nm-plain">' + why.map((x) => '<li>' + rich(x) + '</li>').join('') + '</ul>');
    const choices = decidedOf(node, ticket);
    if (choices.length) {
      body += section('정한 것', choices.map((d) => '<div class="nm-dec"><p class="nm-q">' + esc(d.q) + '</p><p class="nm-a">' + rich(d.a) + '</p></div>').join(''));
    }
    const scen = gwtRows(node, ticket);
    if (scen.length) {
      body += '<section class="nm-s">' + scen.map((r) => (scen.length > 1 ? '<p class="nm-sc">' + esc(r.title) + '</p>' : '') +
        '<dl class="nm-gwt">' + [['Given', r.given], ['When', r.when], ['Then', r.then]].filter((x) => x[1]).map((x) =>
          '<div class="nm-r"><dt>' + x[0] + '</dt><dd>' + rich(x[1]) + '</dd></div>').join('') + '</dl>').join('') + '</section>';
    }
    const items = checkItems(node);
    if (node.state === '확인 대기' && (items.length || (node.checks && node.checks.intro))) {
      const intro = node.checks.intro ? '<p class="nm-intro" data-nm-intro>' + rich(node.checks.intro) + '</p>' : '';
      const boxes = items.map((t, i) => '<li class="nm-i"><label class="nm-chk"><input type="checkbox" data-nm-check="' + i + '"' +
        ((ui.checked || []).includes(i) ? ' checked' : '') + '><span class="nm-t">' + rich(t) + '</span></label></li>');
      body += section('확인할 것', intro + listOf(boxes));
    }
    if ((node.evidence || []).length) {
      const imgs = node.evidence.filter(isImage);
      const others = node.evidence.filter((f) => !isImage(f));
      const thumbs = imgs.map((f) => '<button type="button" class="nm-th" data-nm="zoom" data-name="' + esc(f) + '" aria-label="' + esc(f) + ' 크게 보기">' +
        '<img src="' + esc(evidenceUrl(ctx.workspace, ticket.slug, node.key, f)) + '" alt="' + esc(f) + '" loading="lazy"><span>' + esc(f.replace(/\.[^.]+$/, '')) + '</span></button>').join('');
      body += '<section class="nm-s">' + (thumbs ? '<div class="nm-thumbs">' + thumbs + '</div>' : '') +
        listOf(others.map((f) => '<li class="nm-i"><span class="nm-t nm-mono">' + esc(f) + '</span></li>')) + '</section>';
    }
    const crit = node.criteria || [];
    if (crit.length) {
      // 끝남인데 하나도 체크돼 있지 않으면 체크 상태를 적지 않은 것이다 — 빈 상자로 "안 했다"고 읽히지 않게 목록만 보인다
      const plain = node.state === '끝남' && !crit.some((c) => c.done);
      body += section('완료 기준', plain
        ? '<ul class="nm-plain">' + crit.map((c) => '<li>' + rich(c.text) + '</li>').join('') + '</ul>'
        : '<ul class="nm-crit">' + crit.map((c) => '<li class="' + (c.done ? 'on' : '') + '"><span class="nm-bx" aria-hidden="true">' + (c.done ? '✓' : '') + '</span>' +
          '<span class="nm-t"><span class="nm-sr">' + (c.done ? '완료: ' : '아직: ') + '</span>' + rich(c.text) + '</span></li>').join('') + '</ul>');
    }
    if (node.verdict === '고쳐줘' && node.fix) {
      body += section('고쳐줘', '<p class="nm-p" data-nm-fix>' + esc(node.fix) + '</p>');
    }
    if (eff.pending === '통과') body += dim('통과를 남겼어요. 에이전트가 반영하면 끝남으로 바뀝니다.');
    if (eff.pending === '고쳐줘') body += dim('고쳐줘를 남겼어요. 에이전트가 이어받으면 진행으로 돌아갑니다.');


    let foot = '';
    if (ui.fixing) {
      foot = `<textarea class="nm-in" rows="3" maxlength="2000" placeholder="${items.length ? '체크한 항목 말고 더 고칠 것이 있으면 적어 주세요' : '무엇을 고칠까요?'} (Ctrl/⌘+Enter로 보내기)" aria-label="고칠 내용">${esc(ui.draft)}</textarea>` +
        `<button type="button" class="btn btn-primary" data-nm="send">보내기</button>` +
        `<button type="button" class="btn" data-nm="cancel">취소</button>`;
    } else {
      const hint = node.state === '확인 대기' && items.length ? `<span class="nm-hint" data-nm-hint>${esc(hintOf((ui.checked || []).length))}</span>` : '';
      foot = hint + actions(node).map((id) => {
        const v = VERBS[id];
        const pressed = (id === 'pass' && node.verdict === '통과') || (id === 'fix' && node.verdict === '고쳐줘');
        return `<button type="button" class="btn${v.primary ? ' btn-primary' : ''}" data-nm="${id}"` +
          `${id === 'pass' || id === 'fix' ? ` aria-pressed="${pressed}"` : ''}>${esc(v.label)}</button>`;
      }).join('');
    }

    const msg = ui.err ? `<p class="nm-msg nm-err" role="alert">${esc(ui.err)}</p>`
      : ui.msg ? `<p class="nm-msg" role="status">${esc(ui.msg)}</p>` : '';
    let commits = '';
    if (Array.isArray(ui.commits)) {
      commits = ui.commits.length
        ? section('커밋', listOf(ui.commits.map((c) => `<li class="nm-i"><span class="id">${esc(c.hash)}</span>` +
          `<span class="nm-t">${esc(c.subject || (c.verified ? '' : '이 레포에서 찾지 못한 해시'))}</span></li>`)))
        : section('커밋', dim('브리프에 적힌 커밋이 없어요'));
    }

    const tk = ctx.color ? `<span class="tk tk-${esc(ctx.color)}"></span>` : '';
    const bd = BADGE[eff.state] || ['s-todo', 'todo'];
    const badge = `<span class="nm-st is-${bd[1]}"><svg class="st st-${bd[1]}" width="12" height="12" aria-hidden="true"><use href="#${bd[0]}"/></svg>` +
      `${esc(eff.pending ? `${node.state} · ${eff.pending}` : node.state)}</span>`;
    const zoom = ui.zoom && (node.evidence || []).includes(ui.zoom)
      ? `<div class="nm-lb" data-nm="unzoom"><img src="${esc(evidenceUrl(ctx.workspace, ticket.slug, node.key, ui.zoom))}" alt="${esc(ui.zoom)}"></div>` : '';
    return `<div class="nm-scrim" data-nm="close"></div>` + zoom +
      `<section class="nm surface" role="dialog" aria-modal="true" aria-label="${esc(node.id)} ${esc(node.title)}" data-key="${esc(node.key)}">` +
      `<header class="nm-top">${tk}<span class="id">${esc(node.id)}</span>${badge}` +
      `<button type="button" class="nm-x" data-nm="close" aria-label="닫기">✕</button></header>` +
      `<h2 class="nm-title">${esc(node.title)}</h2>` +
      `<div class="nm-body">${body}${commits}</div>` +
      `<footer class="nm-foot">${foot}</footer>${msg}</section>`;
  }

  /* DOM 없는 컨트롤러. o = { fetch, getModel(), redraw(), render(html), color?(slug) }.
     요청은 이 안에서만 나간다 — 취소는 아무 요청도 만들지 않는다. */
  function controller(o) {
    const st = { open: null, fixing: false, draft: '', busy: false, msg: '', err: '', commits: null, checked: [], zoom: '' };
    const model = () => o.getModel() || {};
    const enc = encodeURIComponent;

    function cur() {
      if (!st.open) return null;
      for (const p of model().projects || []) {
        for (const t of p.tickets || []) {
          if (t.slug !== st.open.ticket) continue;
          const n = (t.nodes || []).find((x) => x.key === st.open.key);
          if (n) return { ticket: t, node: n };
        }
      }
      return null;
    }
    function show() {
      const c = cur();
      o.render(c ? dialog(c.node, { ticket: c.ticket, workspace: model().workspace, color: o.color ? o.color(c.ticket.slug) : '', ui: st }) : '');
    }
    const flash = (msg, err) => { st.msg = err ? '' : msg; st.err = err ? msg : ''; };
    const reset = () => Object.assign(st, { fixing: false, draft: '', busy: false, msg: '', err: '', commits: null, checked: [], zoom: '' });

    async function call(method, path, body) {
      const init = { method };
      if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
      let r;
      try { r = await o.fetch(path, init); } catch (e) { return { ok: false, status: 0, j: { error: '서버에 닿지 않았어요' } }; }
      let j = {};
      try { j = await r.json(); } catch (e) { /* 본문 없는 응답 */ }
      return { ok: r.ok, status: r.status, j };
    }
    const base = (k) => `/w/${enc(model().workspace || '')}/api/${k}`;
    const needWs = () => !model().workspace && (flash('서버에 연결된 보드에서만 쓸 수 있어요', true), show(), true);

    async function guard(fn) {
      if (st.busy || !cur()) return;
      st.busy = true; st.err = ''; st.msg = '';
      try { await fn(cur()); } finally { st.busy = false; show(); }
    }

    // 사람 칸 쓰기. base는 화면이 마지막으로 본 값이라 다른 곳에서 먼저 바꿨으면 409로 되돌아온다.
    function saveUser(c, patch, done) {
      return call('POST', base('node'), {
        sheet: c.ticket.slug, id: c.node.key, user: patch,
        base: { verdict: c.node.verdict || '', fix: c.node.fix || '' },
      }).then((r) => {
        if (r.ok && r.j.user) {
          c.node.verdict = String(r.j.user.verdict || '');
          c.node.fix = String(r.j.user.fix || '');
          st.fixing = false; st.draft = '';
          flash(done);
          o.redraw();
        } else if (r.status === 409 && r.j.user) {
          c.node.verdict = String(r.j.user.verdict || '');
          c.node.fix = String(r.j.user.fix || '');
          st.fixing = false;
          flash('다른 곳에서 먼저 바꿨어요. 지금 값으로 다시 보여 드려요.', true);
          o.redraw();
        } else {
          flash(r.j.error || `저장하지 못했어요 (${r.status})`, true);
        }
      });
    }

    const api = {
      state: st,
      html: () => { const c = cur(); return c ? dialog(c.node, { ticket: c.ticket, workspace: model().workspace, ui: st }) : ''; },
      open(ticket, key) { reset(); st.open = { ticket, key }; show(); },
      close() { reset(); st.open = null; show(); },
      startFix() { const c = cur(); if (!c || st.busy || c.node.state !== '확인 대기') return; st.fixing = true; st.err = ''; st.msg = ''; show(); },
      setDraft(t) { st.draft = String(t || ''); },
      // 체크는 다시 그리지 않는다 (스크롤·포커스를 지키려고)
      toggleCheck(i, on) {
        const n = Number(i);
        st.checked = st.checked.filter((x) => x !== n);
        if (on) st.checked.push(n);
      },
      zoom(name) { st.zoom = String(name || ''); show(); },
      unzoom() { st.zoom = ''; show(); },
      cancelFix() { st.fixing = false; st.draft = ''; st.err = ''; show(); }, // 아무것도 쓰지 않는다
      sendFix() {
        const c0 = cur();
        const text = composeFix(c0 && c0.node, st.checked, st.draft);
        if (!text) { flash('고칠 항목을 체크하거나 내용을 적어 주세요', true); show(); return Promise.resolve(); }
        if (needWs()) return Promise.resolve();
        return guard((c) => saveUser(c, { verdict: '고쳐줘', fix: text }, '고쳐줘를 보냈어요. 에이전트가 이어받으면 진행으로 돌아갑니다.'));
      },
      pass() {
        const c = cur();
        if (!c || c.node.state !== '확인 대기') return Promise.resolve();
        if (needWs()) return Promise.resolve();
        return guard((cc) => saveUser(cc, { verdict: '통과' }, '통과를 남겼어요. 에이전트가 반영하면 끝남으로 바뀝니다.'));
      },
      commits() {
        if (needWs()) return Promise.resolve();
        return guard(async (c) => {
          const r = await call('GET', `${base('commits')}?sheet=${enc(c.ticket.slug)}&id=${enc(c.node.key)}`);
          if (r.ok) st.commits = r.j.commits || []; else flash(r.j.error || `커밋을 못 읽었어요 (${r.status})`, true);
        });
      },
      dispatch(a, data) {
        switch (a) {
          case 'close': return api.close();
          case 'zoom': return api.zoom(data && data.name);
          case 'unzoom': return api.unzoom();
          case 'fix': return api.startFix();
          case 'cancel': return api.cancelFix();
          case 'send': return api.sendFix();
          case 'pass': return api.pass();
          case 'commits': return api.commits();
          default: return undefined;
        }
      },
    };
    return api;
  }

  /* 브라우저 진입 — 카드(.card[data-tkt][data-key])를 누르면 연다.
     o = { getModel, redraw?, fetch?, color? }. 속성 이름은 티켓 모달(data-ticket·data-act)과 겹치지 않게 data-tkt·data-nm이다. */
  function mount(o) {
    const doc = document;
    const host = doc.createElement('div');
    host.className = 'nm-host';
    doc.body.appendChild(host);
    const c = controller({
      fetch: o.fetch || ((p, i) => fetch(p, i)),
      getModel: () => {
        const m = o.getModel() || {};
        if (!m.workspace) { const w = new URLSearchParams(location.search).get('w'); if (w) m.workspace = w; }
        return m;
      },
      redraw: o.redraw || (() => window.dispatchEvent(new Event('hashchange'))),
      color: o.color,
      render(html) {
        host.innerHTML = html;
        const i = host.querySelector('.nm-in');
        if (i) i.focus();
      },
    });
    doc.addEventListener('click', (e) => {
      const t = e.target && e.target.closest ? e.target : null;
      if (!t) return;
      const b = t.closest('[data-nm]');
      if (b && host.contains(b)) { c.dispatch(b.dataset.nm, b.dataset); return; }
      if (t.closest('[data-dec]')) return; // ◆ 칩은 결정 모달 몫이다
      const card = t.closest(OPENER);
      if (card && !host.contains(card)) c.open(card.dataset.tkt, card.dataset.key);
    });
    doc.addEventListener('input', (e) => { if (e.target.matches && e.target.matches('.nm-in')) c.setDraft(e.target.value); });
    doc.addEventListener('change', (e) => {
      const b = e.target.matches && e.target.matches('[data-nm-check]') ? e.target : null;
      if (!b || !host.contains(b)) return;
      c.toggleCheck(b.dataset.nmCheck, b.checked);
      // 다시 그리지 않으므로 체크 수와 버튼 옆 안내만 글자를 바꾼다
      const n = c.state.checked.length;
      const cnt = host.querySelector('[data-nm-count]');
      if (cnt) cnt.textContent = cnt.textContent.replace(/^\d+/, String(n));
      const h = host.querySelector('[data-nm-hint]');
      if (h) h.textContent = hintOf(n);
    });
    doc.addEventListener('keydown', (e) => {
      if (!c.state.open) {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches(OPENER)) {
          e.preventDefault(); c.open(e.target.dataset.tkt, e.target.dataset.key);
        }
        return;
      }
      if (e.key === 'Escape') { if (c.state.zoom) c.unzoom(); else if (c.state.fixing) c.cancelFix(); else c.close(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.matches && e.target.matches('.nm-in')) { e.preventDefault(); c.sendFix(); }
    });
    return c;
  }

  return { VERBS, actions, dialog, controller, mount, esc, rich, isImage, evidenceUrl, composeFix, checkItems };
});
