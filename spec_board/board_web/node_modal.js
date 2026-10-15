/* 노드 모달 — 카드를 누르면 열린다. 담당 시나리오·먼저 끝나야 함·다음과 상태별 버튼을 보인다.
   통과·고쳐줘는 사람 칸 저장소(레포 밖) `nodes/<노드>.json`의 user.verdict·user.fix에만 쓴다(D3) — 상태는 에이전트 몫이다.
   줄 댓글은 같은 파일의 comments에 덧붙이기만 한다(POST /api/comment) — 남의 댓글·user 칸은 건드리지 않는다.
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

  /* 댓글 — PR 리뷰처럼 줄마다 스레드를 단다. 저장은 사람 칸 저장소 nodes/<노드>.json comments(덧붙이기만). 규칙은 spec_model.comment_threads와 같다. */
  const ak = (sec, text) => sec + '\n' + text;
  function threadsOf(comments) {
    const cs = Array.isArray(comments) ? comments : [];
    return cs.filter((c) => !c.reply_to).map((r) => {
      const all = [r, ...cs.filter((c) => c.reply_to === r.id)];
      let resolved = false;
      for (const c of all) if (typeof c.resolve === 'boolean') resolved = c.resolve;
      const entries = all.filter((c) => c.text || (Array.isArray(c.images) && c.images.length));
      return { id: r.id, anchor: r.anchor || null, entries, resolved,
        waiting: !resolved && entries.length > 0 && entries[entries.length - 1].by === 'user' };
    });
  }
  const BY = { user: '나', agent: '에이전트' };
  // 오른쪽 댓글 열의 스레드 머리에 "어느 절의 어느 줄"인지 보인다
  const SEC = { why: '왜 했나', dec: '정한 것', gwt: '시나리오', check: '확인할 것', crit: '완료 기준' };
  const cmText = (t) => rich(t).replace(/\n/g, '<br>');
  // 댓글 이미지 주소를 만들려면 어느 워크스페이스·티켓·노드인지 알아야 한다 — dialog()가 그릴 때마다 적어 둔다
  let IMG = { ws: '', slug: '', key: '' };
  const cmImg = (name) => evidenceUrl(IMG.ws, IMG.slug, IMG.key, name);
  const cmThumbs = (names) => (names && names.length
    ? '<div class="nm-cm-imgs">' + names.map((n) => '<button type="button" class="nm-cm-img" data-nm="zoom" data-name="' + esc(n) + '" aria-label="이미지 크게 보기">' +
      '<img src="' + esc(cmImg(n)) + '" alt="첨부 이미지" loading="lazy"></button>').join('') + '</div>' : '');
  // 줄 인용 — 누르면 그 줄과 스레드를 같이 강조한다(cm-focus)
  const toLine = (a, id) => '<button type="button" class="nm-to" data-nm="cm-focus" data-thread="' + esc(id || '') + '">' +
    (SEC[a.sec] ? '<b>' + esc(SEC[a.sec]) + '</b> · ' : '') + rich(a.text) + '</button>';
  // general: 오른쪽 열 맨 아래에 늘 있는 노드 전체 댓글 칸. 쓰기 시작하기 전(cm 없음)에는 포커스를 가져가지 않는다
  function composer(ui, reply, general) {
    const active = !general || !!ui.cm;
    const att = (ui.cmImages || []).map((n) => '<span class="nm-cm-chip"><button type="button" class="nm-cm-img" data-nm="zoom" data-name="' + esc(n) +
      '" aria-label="이미지 크게 보기"><img src="' + esc(cmImg(n)) + '" alt="첨부 이미지"></button>' +
      '<button type="button" class="nm-cm-x" data-nm="cm-unattach" data-name="' + esc(n) + '" aria-label="이미지 빼기">×</button></span>').join('');
    const ph = general ? '노드 전체에 댓글 (줄에 달려면 왼쪽 +, 스크린샷은 붙여넣기)' : (reply ? '답글' : '댓글') + ' (Ctrl/⌘+Enter로 남기기, 스크린샷은 붙여넣기)';
    return '<div class="nm-cm-new"' + (active ? ' data-cm-active' : '') + '><textarea class="nm-cm-in" rows="3" maxlength="4000" placeholder="' + ph +
      '" aria-label="' + (reply ? '답글' : '댓글') + '">' + esc(active ? ui.cmDraft : '') + '</textarea>' +
      (att ? '<div class="nm-cm-imgs">' + att + '</div>' : '') +
      '<div class="nm-cm-act"><label class="btn nm-cm-file">이미지<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden data-nm-cm-file></label>' +
      (active ? '<button type="button" class="btn" data-nm="cm-cancel">취소</button>' : '') +
      '<button type="button" class="btn btn-primary" data-nm="cm-send">' + (reply ? '답글 남기기' : '댓글 남기기') + '</button></div></div>';
  }
  function threadHtml(t, ui) {
    const cm = ui.cm;
    const q = t.anchor ? toLine(t.anchor, t.id) : '';
    // 누가 썼나 — 아바타(AI·나)와 내 글은 옅은 색 말풍선(색은 node_modal.css의 .by-user)
    const entries = t.entries.map((e) => '<div class="nm-cm-e by-' + (e.by === 'user' ? 'user' : 'agent') + '"><span class="nm-av" aria-hidden="true">' +
      (e.by === 'user' ? '나' : 'AI') + '</span><p class="nm-cm-m"><b>' + esc(BY[e.by] || e.by) + '</b><span>' +
      esc(String(e.at || '').slice(5)) + '</span></p>' + (e.text ? '<p class="nm-cm-t">' + cmText(e.text) + '</p>' : '') + cmThumbs(e.images) + '</div>').join('');
    const replying = cm && cm.reply === t.id;
    const on = ui.cmFocus === t.id ? ' on' : '';
    if (t.resolved) {
      const first = t.entries.length ? String(t.entries[0].text || '(이미지)').split('\n')[0] : '';
      return '<details class="nm-cm is-done' + on + '" data-cm-thread="' + esc(t.id) + '"' + (on ? ' open' : '') + '><summary>해결됨 · ' + esc(first.length > 40 ? first.slice(0, 40) + '…' : first) +
        '</summary>' + q + entries + '<div class="nm-cm-bar"><button type="button" class="nm-cm-b" data-nm="cm-resolve" data-thread="' + esc(t.id) + '" data-on="0">다시 열기</button></div></details>';
    }
    const bar = replying ? composer(ui, true) : '<div class="nm-cm-bar">' + (t.waiting ? '<span class="nm-cm-w">에이전트 답을 기다려요</span>' : '') +
      '<button type="button" class="nm-cm-b" data-nm="cm-reply" data-thread="' + esc(t.id) + '">답글</button>' +
      '<button type="button" class="nm-cm-b" data-nm="cm-resolve" data-thread="' + esc(t.id) + '" data-on="1">해결</button></div>';
    return '<div class="nm-cm' + on + '" data-cm-thread="' + esc(t.id) + '">' + q + entries + bar + '</div>';
  }

  /* 모달 HTML. ticket은 노드가 속한 티켓(nodes·rows)이고 ui는 {fixing, draft, busy, msg, err, commits}다. */
  function dialog(node, ctx) {
    ctx = ctx || {};
    const ticket = ctx.ticket || {};
    IMG = { ws: ctx.workspace || '', slug: ticket.slug || '', key: node.key };
    const ui = ctx.ui || {};
    const eff = Verdict.effective(node);
    const threads = threadsOf(node.comments);
    const byKey = {};
    threads.forEach((t) => { if (t.anchor) (byKey[ak(t.anchor.sec, t.anchor.text)] = byKey[ak(t.anchor.sec, t.anchor.text)] || []).push(t); });
    const used = new Set();
    const order = [];   // 본문에 나온 순서대로 모은 줄 스레드 — 오른쪽 열이 이 순서를 따른다
    const cm = ui.cm || null;
    const focus = ui.cmFocus || '';
    // 줄 하나에 붙는 + 버튼(왼쪽 여백)과 댓글 수 표시(오른쪽 끝). 스레드 자체는 오른쪽 댓글 열에 있다
    const plus = (sec, text) => '<button type="button" class="nm-cm-add" data-nm="cm-new" data-sec="' + esc(sec) + '" data-text="' + esc(text) +
      '" aria-label="이 줄에 댓글" title="이 줄에 댓글">+</button>';
    // 줄(.nm-ln)에 덧붙일 클래스 — 스레드가 있으면 has, 강조한 스레드나 쓰고 있는 줄이면 hl
    const mark = (sec, text) => {
      const k = ak(sec, text);
      const ts = byKey[k] || [];
      const writing = cm && !cm.reply && cm.anchor && ak(cm.anchor.sec, cm.anchor.text) === k;
      return (ts.length ? ' has' : '') + (writing || ts.some((t) => t.id === focus) ? ' hl' : '');
    };
    const tail = (sec, text) => {
      const k = ak(sec, text);
      const ts = byKey[k] || [];
      if (!used.has(k)) { used.add(k); order.push(...ts); }
      if (!ts.length) return '';
      const n = ts.reduce((a, t) => a + t.entries.length, 0);
      return '<button type="button" class="nm-pin' + (ts.every((t) => t.resolved) ? ' is-done' : '') + '" data-nm="cm-focus" data-thread="' + esc(ts[0].id) +
        '" aria-label="이 줄 댓글 ' + n + '개 보기">💬 ' + n + '</button>';
    };

    const why = (node.why && node.why.length ? node.why : (node.problem ? [node.problem] : []));
    let body = '';
    if (why.length) body += section('왜 했나', '<ul class="nm-plain">' + why.map((x) => '<li class="nm-ln' + mark('why', x) + '">' + plus('why', x) + rich(x) + tail('why', x) + '</li>').join('') + '</ul>');
    const choices = decidedOf(node, ticket);
    if (choices.length) {
      body += section('정한 것', choices.map((d) => '<div class="nm-dec nm-ln' + mark('dec', d.q) + '">' + plus('dec', d.q) + '<p class="nm-q">' + esc(d.q) + '</p><p class="nm-a">' + rich(d.a) + '</p>' + tail('dec', d.q) + '</div>').join(''));
    }
    const scen = gwtRows(node, ticket);
    if (scen.length) {
      body += '<section class="nm-s">' + scen.map((r) => (scen.length > 1 ? '<p class="nm-sc">' + esc(r.title) + '</p>' : '') +
        '<dl class="nm-gwt">' + [['Given', r.given], ['When', r.when], ['Then', r.then]].filter((x) => x[1]).map((x) => {
          const t = r.id + ' ' + x[0] + ': ' + x[1];
          return '<div class="nm-r nm-ln' + mark('gwt', t) + '">' + plus('gwt', t) + '<dt>' + x[0] + '</dt><dd>' + rich(x[1]) + tail('gwt', t) + '</dd></div>';
        }).join('') + '</dl>').join('') + '</section>';
    }
    const items = checkItems(node);
    if (node.state === '확인 대기' && (items.length || (node.checks && node.checks.intro))) {
      const intro = node.checks.intro ? '<p class="nm-intro" data-nm-intro>' + rich(node.checks.intro) + '</p>' : '';
      const boxes = items.map((t, i) => '<li class="nm-i nm-ln nm-col' + mark('check', t) + '">' + plus('check', t) + '<label class="nm-chk"><input type="checkbox" data-nm-check="' + i + '"' +
        ((ui.checked || []).includes(i) ? ' checked' : '') + '><span class="nm-t">' + rich(t) + '</span></label>' + tail('check', t) + '</li>');
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
        ? '<ul class="nm-plain">' + crit.map((c) => '<li class="nm-ln' + mark('crit', c.text) + '">' + plus('crit', c.text) + rich(c.text) + tail('crit', c.text) + '</li>').join('') + '</ul>'
        : '<ul class="nm-crit">' + crit.map((c) => '<li class="nm-ln' + mark('crit', c.text) + (c.done ? ' on' : '') + '">' + plus('crit', c.text) + '<span class="nm-bx" aria-hidden="true">' + (c.done ? '✓' : '') + '</span>' +
          '<span class="nm-t"><span class="nm-sr">' + (c.done ? '완료: ' : '아직: ') + '</span>' + rich(c.text) + tail('crit', c.text) + '</span></li>').join('') + '</ul>');
    }
    if (node.verdict === '고쳐줘' && node.fix) {
      body += section('고쳐줘', '<p class="nm-p" data-nm-fix>' + esc(node.fix) + '</p>');
    }
    // 오른쪽 댓글 열 — 본문 순서의 줄 스레드, 그다음 줄이 없어진 스레드와 노드 전체 댓글. 해결된 것은 접어서 맨 아래
    const all = [...order, ...threads.filter((t) => !order.includes(t))];
    const live = all.filter((t) => !t.resolved);
    const waitN = live.filter((t) => t.waiting).length;
    const draft = cm && !cm.reply && cm.anchor ? '<div class="nm-cm is-draft">' + toLine(cm.anchor) + composer(ui, false) + '</div>' : '';
    const general = !node.error && (!cm || (!cm.reply && !cm.anchor));
    const rail = '<aside class="nm-rail" data-nm-comments aria-label="댓글"><div class="nm-rh">댓글 <span class="c">' + all.length + '</span>' +
      (waitN ? '<span class="w"><i></i>답 기다림 ' + waitN + '</span>' : '') + '</div><div class="nm-rl">' + draft +
      live.map((t) => threadHtml(t, ui)).join('') + all.filter((t) => t.resolved).map((t) => threadHtml(t, ui)).join('') +
      (all.length || draft ? '' : '<p class="nm-cm-none">아직 댓글이 없어요. 줄 왼쪽 + 로 그 줄에 달 수 있어요.</p>') + '</div>' +
      (general ? '<div class="nm-rc">' + composer(ui, false, true) + '</div>' : '') + '</aside>';
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
      `<div class="nm-grid"><div class="nm-main"><div class="nm-body">${body}${commits}</div>` +
      (foot ? `<footer class="nm-foot">${foot}</footer>` : '') + `${msg}</div>${rail}</div></section>`;
  }

  /* DOM 없는 컨트롤러. o = { fetch, getModel(), redraw(), render(html), color?(slug) }.
     요청은 이 안에서만 나간다 — 취소는 아무 요청도 만들지 않는다. */
  function controller(o) {
    const st = { open: null, fixing: false, draft: '', busy: false, msg: '', err: '', commits: null, checked: [], zoom: '', cm: null, cmDraft: '', cmImages: [], cmUp: 0, cmFocus: '' };
    const model = () => o.getModel() || {};
    const enc = encodeURIComponent;
    // 연 노드의 워크스페이스 — 모든 레포를 모은 Inbox에서 열었으면 그 줄의 것, 아니면 지금 보드의 것
    const wsOf = () => (st.open && st.open.ws) || model().workspace || '';

    function cur() {
      if (!st.open) return null;
      for (const p of model().projects || []) {
        for (const t of p.tickets || []) {
          if (t.slug !== st.open.ticket || (st.open.ws && t.workspace && t.workspace !== st.open.ws)) continue;
          const n = (t.nodes || []).find((x) => x.key === st.open.key);
          if (n) return { ticket: t, node: n };
        }
      }
      return null;
    }
    function show() {
      const c = cur();
      o.render(c ? dialog(c.node, { ticket: c.ticket, workspace: wsOf(), color: o.color ? o.color(c.ticket.slug) : '', ui: st }) : '');
    }
    const flash = (msg, err) => { st.msg = err ? '' : msg; st.err = err ? msg : ''; };
    const reset = () => Object.assign(st, { fixing: false, draft: '', busy: false, msg: '', err: '', commits: null, checked: [], zoom: '', cm: null, cmDraft: '', cmImages: [], cmUp: 0, cmFocus: '' });

    async function call(method, path, body) {
      const init = { method };
      if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
      let r;
      try { r = await o.fetch(path, init); } catch (e) { return { ok: false, status: 0, j: { error: '서버에 닿지 않았어요' } }; }
      let j = {};
      try { j = await r.json(); } catch (e) { /* 본문 없는 응답 */ }
      return { ok: r.ok, status: r.status, j };
    }
    const base = (k) => `/w/${enc(wsOf())}/api/${k}`;
    const needWs = () => !wsOf() && (flash('서버에 연결된 보드에서만 쓸 수 있어요', true), show(), true);

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

    // 댓글 하나 덧붙이기 — 서버가 지금 목록 전체를 돌려주니 그것으로 바꾼다
    function postComment(c, comment, done) {
      return call('POST', base('comment'), { sheet: c.ticket.slug, id: c.node.key, comment }).then((r) => {
        if (r.ok && Array.isArray(r.j.comments)) {
          c.node.comments = r.j.comments;
          st.cm = null; st.cmDraft = ''; st.cmImages = [];
          flash(done);
        } else {
          flash(r.j.error || `저장하지 못했어요 (${r.status})`, true);
        }
      });
    }

    const api = {
      state: st,
      html: () => { const c = cur(); return c ? dialog(c.node, { ticket: c.ticket, workspace: wsOf(), ui: st }) : ''; },
      open(ticket, key, ws) { reset(); st.open = { ticket, key, ws: ws || '' }; show(); },
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
      cmNew(data) {
        if (!cur() || st.busy) return;
        const sec = data && data.sec;
        st.cm = { anchor: sec ? { sec, text: String(data.text || '') } : null, reply: '' };
        st.cmDraft = ''; st.cmImages = []; st.err = ''; st.msg = ''; st.fixing = false;
        show();
      },
      cmReply(id) { if (!cur() || st.busy) return; st.cm = { anchor: null, reply: String(id || '') }; st.cmDraft = ''; st.cmImages = []; st.err = ''; st.msg = ''; show(); },
      // 오른쪽 열 맨 아래 칸에 바로 쓰기 시작하면 노드 전체 댓글로 연다(다시 그리지 않는다 — 입력 중 포커스 유지)
      setCmDraft(t) { if (!st.cm && cur()) st.cm = { anchor: null, reply: '' }; st.cmDraft = String(t || ''); },
      cmCancel() { st.cm = null; st.cmDraft = ''; st.cmImages = []; st.err = ''; show(); },
      // 줄의 댓글 수나 스레드 인용을 누르면 그 줄과 스레드를 같이 강조한다. 다시 누르면 푼다
      cmFocus(id) { if (!cur()) return; st.cmFocus = st.cmFocus === id ? '' : String(id || ''); show(); },
      // 스크린샷 한 장을 올려 댓글 칸에 붙인다. 파일은 서버 evidence 폴더에 먼저 올라가고, 댓글을 남길 때 이름만 같이 간다.
      async cmAttach(file) {
        const c = cur();
        if (!c || st.busy || !file) return;
        if (!st.cm) st.cm = { anchor: null, reply: '' };   // 맨 아래 칸에 바로 붙여넣은 경우
        if (needWs()) return;
        if (!/^image\/(png|jpeg|webp|gif)$/.test(String(file.type || ''))) { flash('png·jpg·webp·gif 이미지만 붙일 수 있어요', true); show(); return; }
        if (file.size > 8 * 1024 * 1024) { flash('이미지는 8MB 이하여야 해요', true); show(); return; }
        // 올리는 중인 장수도 센다 — 여러 장을 한 번에 붙이면 업로드가 동시에 돈다
        if (st.cmImages.length + st.cmUp >= 6) { flash('이미지는 댓글 하나에 6장까지예요', true); show(); return; }
        st.cmUp += 1;
        let r;
        try {
          const resp = await o.fetch(`${base('comment-image')}?sheet=${enc(c.ticket.slug)}&id=${enc(c.node.key)}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
          let j = {}; try { j = await resp.json(); } catch (e) { /* 본문 없음 */ }
          r = { ok: resp.ok, status: resp.status, j };
        } catch (e) { r = { ok: false, status: 0, j: { error: '서버에 닿지 않았어요' } }; } finally { st.cmUp -= 1; }
        if (r.ok && r.j.name) { st.cmImages.push(r.j.name); st.err = ''; } else flash(r.j.error || `이미지를 올리지 못했어요 (${r.status})`, true);
        show();
      },
      cmUnattach(name) { st.cmImages = st.cmImages.filter((n) => n !== name); show(); },
      cmSend() {
        const text = st.cmDraft.trim();
        if (!st.cm) return Promise.resolve();
        if (!text && !st.cmImages.length) { flash('댓글을 적어 주세요', true); show(); return Promise.resolve(); }
        if (needWs()) return Promise.resolve();
        const imgs = st.cmImages.length ? { images: st.cmImages.slice() } : {};
        const cmt = st.cm.reply ? { text, reply_to: st.cm.reply, ...imgs } : { text, ...imgs, ...(st.cm.anchor ? { anchor: st.cm.anchor } : {}) };
        return guard((c) => postComment(c, cmt, '댓글을 남겼어요. 에이전트가 다음 턴에 답합니다.'));
      },
      cmResolve(id, on) {
        if (needWs()) return Promise.resolve();
        return guard((c) => postComment(c, { reply_to: String(id || ''), resolve: !!on }, on ? '해결로 닫았어요.' : '다시 열었어요.'));
      },
      dispatch(a, data) {
        switch (a) {
          case 'cm-new': return api.cmNew(data);
          case 'cm-reply': return api.cmReply(data && data.thread);
          case 'cm-cancel': return api.cmCancel();
          case 'cm-focus': return api.cmFocus(data && data.thread);
          case 'cm-send': return api.cmSend();
          case 'cm-unattach': return api.cmUnattach(data && data.name);
          case 'cm-resolve': return api.cmResolve(data && data.thread, data && data.on === '1');
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
        // 다시 그려도 같은 노드면 본문·댓글 열 스크롤을 지킨다 — 아래쪽 줄에 댓글을 달다가 맨 위로 튀지 않게
        const old = host.querySelector('.nm');
        const keep = ['.nm-body', '.nm-rl', '.nm-grid'].map((s) => (old && old.querySelector(s) ? old.querySelector(s).scrollTop : 0));
        const key = old ? old.dataset.key : null;
        host.innerHTML = html;
        const now = host.querySelector('.nm');
        if (now && key === now.dataset.key) ['.nm-body', '.nm-rl', '.nm-grid'].forEach((s, i) => { const el = now.querySelector(s); if (el) el.scrollTop = keep[i]; });
        const i = host.querySelector('.nm-in');
        if (i) i.focus();
        const ci = host.querySelector('[data-cm-active] .nm-cm-in');
        if (ci) { ci.focus({ preventScroll: true }); ci.scrollIntoView({ block: 'nearest' }); }
      },
    });
    doc.addEventListener('click', (e) => {
      const t = e.target && e.target.closest ? e.target : null;
      if (!t) return;
      const b = t.closest('[data-nm]');
      if (b && host.contains(b)) {
        c.dispatch(b.dataset.nm, b.dataset);
        if (b.dataset.nm === 'cm-focus') {   // 강조한 줄과 스레드가 둘 다 보이게
          const th = host.querySelector('.nm-rail .nm-cm.on');
          const ln = host.querySelector('.nm-body .nm-ln.hl');
          if (th) th.scrollIntoView({ block: 'nearest' });
          if (ln) ln.scrollIntoView({ block: 'nearest' });
        }
        return;
      }
      if (t.closest('[data-dec]')) return; // ◆ 칩은 결정 모달 몫이다
      const card = t.closest(OPENER);
      if (card && !host.contains(card)) c.open(card.dataset.tkt, card.dataset.key, card.dataset.ws);
    });
    doc.addEventListener('input', (e) => {
      if (!e.target.matches) return;
      if (e.target.matches('.nm-in')) c.setDraft(e.target.value);
      else if (e.target.matches('.nm-cm-in')) c.setCmDraft(e.target.value);
    });
    doc.addEventListener('change', (e) => {
      const fi = e.target.matches && e.target.matches('[data-nm-cm-file]') ? e.target : null;
      if (fi && host.contains(fi)) { Array.from(fi.files || []).forEach((f) => c.cmAttach(f)); fi.value = ''; return; }
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
    doc.addEventListener('paste', (e) => {
      if (!e.target.matches || !e.target.matches('.nm-cm-in') || !e.clipboardData) return;
      const files = Array.from(e.clipboardData.files || []).filter((f) => /^image\//.test(f.type));
      if (!files.length) return;
      e.preventDefault();
      files.forEach((f) => c.cmAttach(f));
    });
    doc.addEventListener('dragover', (e) => { if (e.target.matches && e.target.matches('.nm-cm-in')) e.preventDefault(); });
    doc.addEventListener('drop', (e) => {
      if (!e.target.matches || !e.target.matches('.nm-cm-in') || !e.dataTransfer) return;
      const files = Array.from(e.dataTransfer.files || []).filter((f) => /^image\//.test(f.type));
      if (!files.length) return;
      e.preventDefault();
      files.forEach((f) => c.cmAttach(f));
    });
    doc.addEventListener('keydown', (e) => {
      if (!c.state.open) {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches(OPENER)) {
          e.preventDefault(); c.open(e.target.dataset.tkt, e.target.dataset.key, e.target.dataset.ws);
        }
        return;
      }
      if (e.key === 'Escape') { if (c.state.zoom) c.unzoom(); else if (c.state.cm) c.cmCancel(); else if (c.state.fixing) c.cancelFix(); else c.close(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.matches && e.target.matches('.nm-cm-in')) { e.preventDefault(); c.cmSend(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.matches && e.target.matches('.nm-in')) { e.preventDefault(); c.sendFix(); }
    });
    return c;
  }

  return { VERBS, actions, dialog, controller, mount, esc, rich, isImage, evidenceUrl, composeFix, checkItems, threadsOf };
});
