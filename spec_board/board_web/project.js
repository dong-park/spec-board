/* 프로젝트 종합 화면 — 사이드바의 프로젝트 줄을 누르면 뜬다. 머리·진행·요약 칩·막는 결정·확인 대기·티켓 목록.
   입력은 /api/board의 프로젝트 하나(spec_model.build_board)와 모델이다. DOM은 만지지 않고 HTML 문자열만 낸다.
   칩은 Board와 같은 board.js 조각이고, 결정 줄·노드 카드·티켓 줄은 누르면 각자의 모달이 뜨는 같은 속성을 쓴다.
   view.js가 이 파일을 쓰고 이 파일은 view.js를 모른다. 브라우저에서는 전역 BoardProject, node에서는 require. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./board.js'), require('./decisions.js'), require('./verdict.js'));
  } else root.BoardProject = factory(root.BoardCols, root.BoardDecisions, root.BoardVerdict);
})(typeof self !== 'undefined' ? self : this, function (Cols, Dec, Verdict) {
  'use strict';

  const prioRank = (t) => {
    const m = /^P(\d+)/i.exec(String(t.priority || '').trim());
    return m ? Number(m[1]) : 99;
  };

  // 프로젝트 전체 숫자 — 노드 끝남/전체와 시나리오 통과/전체. 칸 정의는 Board와 같은 Cols.summary다.
  function stats(p) {
    const tickets = (p && p.tickets) || [];
    const nodes = tickets.flatMap((t) => t.nodes || []);
    const sum = Cols.summary(nodes);
    let passed = 0, total = 0;
    for (const t of tickets) {
      const sc = t.scenarios || {};
      passed += sc.passed || 0;
      total += sc.total || 0;
    }
    return { sum, nodes, scn: { passed, total } };
  }

  // 막는 결정 = 끝나지 않은 노드를 막는 결정 — 위쪽 칩의 숫자와 같은 집합이다.
  function blockingDecisions(p, model, nodes) {
    const ids = new Set();
    for (const n of nodes) {
      if (Verdict.effective(n).state === '끝남') continue;
      for (const d of n.blocked_by_ids || []) ids.add(d);
    }
    const mine = new Set(((p && p.tickets) || []).map((t) => t.slug));
    return Dec.list(model).filter((d) => ids.has(d.display_id) && mine.has(d.ticket));
  }

  function toCheck(p) {
    const out = [];
    for (const t of (p && p.tickets) || []) {
      const ids = {};
      for (const n of t.nodes || []) ids[n.key] = n.id;
      for (const n of t.nodes || []) {
        if (!n.error && Cols.columnOf(n) === '확인 대기') out.push({ n, ctx: { ticket: t.slug, ids } });
      }
    }
    return out;
  }

  /* ui = {esc, icon, card, tk, short, slug} — view.js가 준다. */
  function html(p, model, ui) {
    const { esc, icon } = ui;
    const { sum, nodes, scn } = stats(p);
    const pct = sum.total ? Math.round((sum.done / sum.total) * 100) : 0;
    const sec = (ic, cls, label, n) =>
      `<h2 class="dgh">${icon(ic, 'st st-' + cls)}${esc(label)} <span class="n">${n}</span></h2>`;

    let h = '<div class="ov">';
    h += `<header class="ovh"><h1>${esc(ui.short({ title: p.title, slug: p.key }))}<span class="slug">${esc(ui.slug(p))}</span></h1>`;
    if (p.problem) h += `<p class="ovl"><span class="k">문제</span><span class="v">${esc(p.problem)}</span></p>`;
    if (p.outcome) h += `<p class="ovl"><span class="k">끝난 모습</span><span class="v">${esc(p.outcome)}</span></p>`;
    h += '</header>';

    h += `<div class="ovp" data-pct="${pct}"><div class="bar"><i></i></div>` +
      `<span class="pn" data-k="nodes">노드 <b>${sum.done} / ${sum.total}</b></span>` +
      `<span class="pn" data-k="scn">시나리오 <b>${scn.passed} / ${scn.total}</b> 통과</span></div>`;
    h += Cols.kpis(sum, ui);

    const decs = Dec ? blockingDecisions(p, model, nodes) : [];
    if (decs.length) {
      const g = Dec.groups([])[0];
      h += `<section class="ovs" data-sec="blocking">${sec(g.icon, g.cls, '막는 결정', decs.length)}` +
        decs.map((d) => Dec.row(d, g)).join('') + '</section>';
    }

    const chk = toCheck(p);
    if (chk.length) {
      h += `<section class="ovs" data-sec="check">${sec('s-rev', 'rev', '확인 대기', chk.length)}` +
        `<div class="cards">${chk.map((x) => ui.card(x.n, x.ctx)).join('')}</div></section>`;
    }

    const tickets = ((p && p.tickets) || []).map((t, i) => ({ t, i }))
      .sort((a, b) => prioRank(a.t) - prioRank(b.t) || a.i - b.i).map((x) => x.t);
    h += `<section class="ovs" data-sec="tickets">${sec('i-tix', 'todo', 'Tickets', tickets.length)}`;
    if (!tickets.length) h += '<p class="none">티켓 없음</p>';
    for (const t of tickets) {
      const s = Cols.summary(t.nodes || []);
      h += `<button type="button" class="trow${t.state === '끝남' ? ' is-done' : ''}" data-ticket="${esc(t.slug)}">` +
        `<span class="tp">${esc(String(t.priority || '').trim())}</span>${ui.tk(t.slug)}` +
        `<span class="tn">${esc(ui.short(t))}</span>` +
        `<span class="tc" title="노드 끝남 / 전체">${s.done} / ${s.total}</span>` +
        `<span class="td">${s.dec ? `<span class="chip dec" title="막는 결정">◆ ${s.dec}</span>` : ''}</span></button>`;
    }
    h += '</section></div>';
    return h;
  }

  return { stats, blockingDecisions, toCheck, html };
});
