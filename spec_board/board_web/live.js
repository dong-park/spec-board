/* 실시간 알림 — /api/events(SSE) 신호로 다시 받은 모든 레포 모델(/api/inbox)에서 "새로 생긴 할 일"을 골라 알린다.
   이 파일은 순수 함수만 둔다(새 항목 고르기·문구·설정·HTML 조각). EventSource·Notification·타이머는 view.js가 다룬다.
   항목 키는 Inbox 줄의 키와 같다 — 결정 d|<ws>|<시트>|<결정 id>, 확인 c|<ws>|<시트>|<노드 key>.
   브라우저에서는 전역 BoardLive로, node에서는 require로 같은 파일을 쓴다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./decisions.js'), require('./sheet.js'));
  else root.BoardLive = factory(root.BoardDecisions, root.BoardSheet);
})(typeof self !== 'undefined' ? self : this, function (Dec, Sheet) {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const KIND = { blk: '막는 결정', chk: '확인 대기', ask: '답할 결정' };
  const ORDER = ['blk', 'chk', 'ask'];
  const BASE_TITLE = 'Working Board';

  /* 지금 사람이 해야 할 일 — 답 없는 열린 결정(막는 것은 blk, 나머지 ask)과 아직 안 누른 확인 대기 노드(chk).
     답했거나 통과·고쳐줘를 남긴 것은 할 일이 아니다. 키 → 항목 Map. */
  function todo(model) {
    const out = new Map();
    for (const p of (model && model.projects) || []) {
      for (const t of p.tickets || []) {
        if (t.archived) continue;
        const ws = t.workspace || model.workspace || '';
        const sheet = Sheet && Sheet.sheetName ? Sheet.sheetName(t.title, t.slug) : (t.title || t.slug);
        for (const r of t.rows || []) {
          if (!r || r.kind !== 'decision' || !Dec.isOpen(r) || Dec.answerOf(r)) continue;
          const key = 'd|' + ws + '|' + t.slug + '|' + r.display_id;
          out.set(key, { key, kind: Dec.isBlocking(r) ? 'blk' : 'ask', ws, ticket: t.slug, sheet, id: r.display_id, title: r.title || '', dec: r.display_id });
        }
        for (const n of t.nodes || []) {
          if (n.state !== '확인 대기' || n.error || n.verdict === '통과' || n.verdict === '고쳐줘') continue;
          const key = 'c|' + ws + '|' + t.slug + '|' + n.key;
          out.set(key, { key, kind: 'chk', ws, ticket: t.slug, sheet, id: n.id || n.key, title: n.title || '', node: n.key });
        }
      }
    }
    return out;
  }

  // 새로 생긴 할 일 — 처음 받은 모델(prev 없음)은 기준만 잡고 알리지 않는다. 막는 결정 → 확인 → 답할 결정 순.
  function added(prev, next) {
    if (!prev) return [];
    return [...next.values()].filter((x) => !prev.has(x.key)).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  }

  function summary(items) {
    const n = {};
    for (const x of items) n[x.kind] = (n[x.kind] || 0) + 1;
    return '새로 ' + items.length + '개 — ' + ORDER.filter((k) => n[k]).map((k) => KIND[k] + ' ' + n[k]).join(' · ');
  }

  // 데스크톱 알림 한 장. 하나면 그 항목, 여럿이면 묶어서. tag가 같으면 브라우저가 겹치지 않고 바꿔 끼운다(탭이 여럿일 때).
  function notice(items) {
    if (items.length === 1) {
      const x = items[0];
      return { title: KIND[x.kind] + ' · ' + x.sheet, body: x.id + ' ' + x.title + ' — ' + x.ws, tag: x.key, item: x };
    }
    return { title: summary(items), body: '눌러서 Inbox 열기', tag: 'batch|' + items.map((x) => x.key).sort().join(','), item: null };
  }

  /* 알림 설정 — 이 브라우저에만(localStorage). on은 사람이 "켜기"를 눌러 권한을 받았을 때만 참이 된다. */
  const DEFAULTS = Object.freeze({ on: false, blk: true, chk: true, ask: false });
  function load(raw) {
    let j = {};
    try { j = JSON.parse(raw || '{}') || {}; } catch (e) { j = {}; }
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (typeof j[k] === 'boolean') out[k] = j[k];
    return out;
  }
  const wanted = (items, prefs) => items.filter((x) => prefs[x.kind]);

  const title = (n) => (n > 0 ? '(' + n + ') ' : '') + BASE_TITLE;

  /* ── HTML 조각 ── */

  // Inbox 머리의 종 버튼과 설정 팝오버. support = 'yes' | 'no'(Notification 없음 — 폰 등) | 'denied'
  function bell(prefs, open, support) {
    const on = prefs.on && support === 'yes';
    let h = '<span class="nt" data-nt><button type="button" class="tbtn' + (on ? ' on' : '') + '" data-nt-pop aria-expanded="' + !!open + '">' +
      '<svg class="ni" width="15" height="15" aria-hidden="true"><use href="#i-bell"/></svg>' + (on ? '알림 켜짐' : '알림 켜기') + '</button>';
    if (!open) return h + '</span>';
    const box = (k, label, sub) => '<label class="nt-o"><input type="checkbox" data-nt-opt="' + k + '"' + (prefs[k] ? ' checked' : '') + '>' +
      '<span><b>' + label + '</b><span>' + sub + '</span></span></label>';
    h += '<div class="nt-pop" role="dialog" aria-label="알림 설정"><b class="nt-h">이 브라우저로 알림 받기</b>';
    if (support === 'no') {
      h += '<p>이 브라우저는 데스크톱 알림을 못 띄워요. 새 항목은 화면 안 알림과 탭 제목 숫자로 알려 드려요.</p>';
    } else {
      h += '<p>탭을 안 보고 있을 때 데스크톱 알림을 띄웁니다. 보고 있을 때는 화면 안에만 띄웁니다.</p>' +
        box('blk', '막는 결정', '되돌리기 어려워 노드가 멈춘 결정 — 바로 답해야 함') +
        box('chk', '확인 대기', '에이전트가 끝내고 통과·고쳐줘를 기다리는 노드') +
        box('ask', '답할 결정 (되돌리기 쉬움)', '답이 없으면 추천대로 가므로 기본은 끔');
      if (support === 'denied') h += '<p class="nt-err">브라우저 설정에서 이 사이트의 알림이 막혀 있어요.</p>';
    }
    h += '<div class="nt-f">' + (on ? '<button type="button" class="btn" data-nt-off>끄기</button>' : '<button type="button" class="btn" data-nt-later>나중에</button>') +
      (on || support !== 'yes' ? '<button type="button" class="btn" data-nt-later>닫기</button>' : '<button type="button" class="btn btn-primary" data-nt-on>켜기</button>') + '</div></div>';
    return h + '</span>';
  }

  // 보고 있을 때의 화면 안 알림 (오른쪽 아래)
  function toast(items) {
    if (!items || !items.length) return '';
    const wss = [...new Set(items.map((x) => x.ws))].join(' · ');
    return '<div class="toast" role="status"><div class="tt"><b>' + esc(items.length === 1 ? KIND[items[0].kind] + ' · ' + items[0].id + ' ' + items[0].title : summary(items)) + '</b>' +
      '<span>' + esc(wss) + ' · 방금</span></div><button type="button" class="btn" data-toast-go>보기</button>' +
      '<button type="button" class="x" data-toast-x aria-label="닫기">✕</button></div>';
  }

  // 사이드바 맨 아래 연결 상태 한 줄. ok = SSE 연결됨, retry = 다시 붙는 중, off = SSE 없이 3초마다 묻기
  const LIVE = { ok: '실시간 연결됨', retry: '다시 연결하는 중…', off: '3초마다 확인' };
  const liveLine = (s) => (LIVE[s] ? '<div class="live live-' + s + '"><i></i>' + LIVE[s] + '</div>' : '');

  return { KIND, BASE_TITLE, DEFAULTS, todo, added, summary, notice, load, wanted, title, bell, toast, liveLine };
});
