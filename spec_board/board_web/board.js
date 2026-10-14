/* Board — 칸 배정과 기다림 정렬.
   입력은 /api/board 노드(spec_model.build_board)다. 칸은 읽을 때 계산한다: 저장하는 상태는 여섯이고,
   "시작 가능"과 "기다림"은 저장값이 아니다. DOM은 만지지 않는다 — html()은 문자열만 낸다.
   브라우저에서는 전역 BoardCols로, node에서는 require로 같은 파일을 쓴다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./verdict.js'));
  else root.BoardCols = factory(root.BoardVerdict);
})(typeof self !== 'undefined' ? self : this, function (Verdict) {
  'use strict';

  // 칸은 다섯뿐이다. 결정 칸과 내 차례 칸은 없다 — 결정은 막힌 카드의 ◆ 칩으로만 보인다.
  const COLUMNS = ['시작 가능', '진행', '확인 대기', '기다림', '끝남'];
  const LANE = { '시작 가능': ['ready', 's-todo'], '진행': ['prog', 's-prog'], '확인 대기': ['rev', 's-rev'], '기다림': ['wait', 's-wait'], '끝남': ['done', 's-done'] };
  // 기다림 칸 안의 순서 — 막힘이 맨 위, 보류, 앞 노드를 기다리는 노드, 읽기 실패 순이다.
  const WAIT_ORDER = { '막힘': 0, '보류': 1, '아직 안 함': 2 };

  // 확인 결과(통과·고쳐줘)를 에이전트가 반영하기 전에도 카드는 파생 상태의 칸에 놓는다 — 저장값은 안 바꾼다.
  function columnOf(node) {
    if (!node || node.error) return '기다림';
    const s = Verdict.effective(node).state;
    if (s === '끝남') return '끝남';
    if (s === '진행' || s === '확인 대기') return s;
    if (s === '아직 안 함' && !(node.waiting_on || []).length) return '시작 가능';
    return '기다림'; // 막힘 · 보류 · 앞 노드를 기다리는 아직 안 함
  }

  const waitRank = (n) => (n.error ? 3 : (WAIT_ORDER[n.state] != null ? WAIT_ORDER[n.state] : 3));

  /* 노드 목록 → {칸: [노드…]}. 입력 순서는 같은 칸 안에서 유지하고, 기다림만 순위로 다시 센다. */
  function assign(nodes) {
    const cols = {};
    for (const c of COLUMNS) cols[c] = [];
    for (const n of nodes || []) cols[columnOf(n)].push(n);
    cols['기다림'] = cols['기다림']
      .map((n, i) => [waitRank(n), i, n])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map((x) => x[2]);
    return cols;
  }

  /* 위쪽 요약 숫자 — 시작 가능·진행·막는 결정·끝남. 막는 결정은 끝나지 않은 노드를 막는 서로 다른 결정 수다. */
  function summary(nodes) {
    const cols = assign(nodes);
    const dec = new Set();
    for (const n of nodes || []) {
      if (Verdict.effective(n).state === '끝남') continue;
      for (const d of n.blocked_by_ids || []) dec.add(d);
    }
    return { ready: cols['시작 가능'].length, prog: cols['진행'].length, dec: dec.size, done: cols['끝남'].length, total: (nodes || []).length };
  }

  /* 위쪽 요약 칩 넷 — Board와 프로젝트 종합 화면이 같은 정의·같은 조각을 쓴다. s = summary(nodes). */
  function kpis(s, ui) {
    const kpi = (cls, ic, title, body) =>
      `<span class="kpi ${cls}" title="${ui.esc(title)}">${ui.icon(ic, '', 14)}<b>${body}</b></span>`;
    return `<div class="wtop">` +
      kpi('go', 's-todo', '시작 가능', s.ready) +
      kpi('run', 's-prog', '진행', s.prog) +
      kpi('me', 's-dec', '막는 결정', s.dec) +
      kpi('fin', 's-done', '끝남', `${s.done}<span class="of"> / ${s.total}</span>`) +
      `</div>`;
  }

  /* 화면 조각. tickets = [{slug, title, nodes}], ui = {card, esc, icon}.
     카드 그리기는 ui.card가 한다 — 이 모듈은 어느 칸에 놓을지만 안다. */
  function html(tickets, ui) {
    const items = [];
    for (const t of tickets || []) {
      const ids = {};
      for (const n of t.nodes || []) ids[n.key] = n.id;
      for (const n of t.nodes || []) items.push({ n, ctx: { ticket: t.slug, ids } });
    }
    const nodes = items.map((x) => x.n);
    const ctxOf = new Map(items.map((x) => [x.n, x.ctx]));
    const cols = assign(nodes);
    const s = summary(nodes);

    const lanes = COLUMNS.map((c) => {
      const [k, ic] = LANE[c];
      const cards = cols[c].map((n) => ui.card(Object.assign({}, n, { column: c }), ctxOf.get(n))).join('');
      return `<section class="lane l-${k}" data-col="${ui.esc(c)}"><div class="bch">${ui.icon(ic, '', 14)}${ui.esc(c)}` +
        `<span class="n">${cols[c].length}</span></div>${cards}</section>`;
    }).join('');

    return `<div class="bwrap">${kpis(s, ui)}<div class="board">${lanes}</div></div>`;
  }

  return { COLUMNS, columnOf, assign, summary, kpis, html };
});
