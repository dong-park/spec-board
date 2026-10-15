/* 결정 메뉴와 결정 모달 — 순수 함수는 HTML 문자열(또는 조각)만 낸다.
   입력은 `/api/board`의 모델이다. 결정은 티켓 rows(kind=decision)에만 있고, 한 줄 목록은 list(model)이 모은다.
   답은 `user.answer` 하나로만 간다 — 상태·담당·막는 칸은 에이전트 몫이라 여기서 쓰지 않는다.
   view.js와 서로 가져오지 않는다: 이 파일은 아무것도 require하지 않고, view.js가 이 파일을 쓴다.
   브라우저에서는 전역 BoardDecisions로, node에서는 require로 같은 파일을 쓴다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoardDecisions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const icon = (id, cls, size) =>
    `<svg class="${cls || ''}" width="${size || 14}" height="${size || 14}" aria-hidden="true"><use href="#${id}"/></svg>`;

  const MSG_CONFLICT = '다른 곳에서 먼저 바꿨어요';
  const MSG_FAILED = '저장하지 못했어요';
  const FREE = '__free__'; // "직접 쓰기"를 고른 상태 — 서버로는 가지 않는다
  const MAX_TEXT = 4000;   // sheet.py MAX_TEXT와 같다. 넘기면 서버가 잘라 버린다

  const answerOf = (d) => String((d.user || {}).answer || '').trim();
  const isOpen = (d) => (d.open != null ? !!d.open : d.status !== '끝남');
  // spec_model.py의 blocking과 같은 식 — 답을 로컬에서 바꾼 뒤에도 서버 없이 다시 센다
  const isBlocking = (d) => isOpen(d) && d.reversible === false && !answerOf(d);
  const optionsOf = (d) => (Array.isArray(d.options) ? d.options : []).filter((o) => o && o.key != null);
  const optOf = (d, key) => optionsOf(d).find((o) => String(o.key) === String(key));
  const hasRec = (d) => !!optOf(d, d.recommend);
  const keyOf = (d) => `${d.ticket || ''}|${d.id}`;
  const tail = (s) => String(s || '').split('/').filter(Boolean).pop() || '';
  // 같은 시트인가 — 모든 레포를 모은 모델(/api/inbox)에서는 워크트리끼리 시트 이름이 겹칠 수 있어 워크스페이스까지 본다.
  // ws가 없으면(한 워크스페이스 모델·옛 호출) 시트 이름만 본다.
  const sameTicket = (t, slug, ws) => t.slug === slug && (!ws || !t.workspace || t.workspace === ws);

  /* 결정 한 줄 목록. 서버는 복제본을 안 준다 — 티켓 rows의 결정 행을 그대로(같은 객체) 모아 ticket·project·workspace를 붙인다.
     같은 객체라 로컬에서 답을 바꾸면 한 곳만 고치면 된다. 순서는 프로젝트 → 티켓 → 행이다. */
  function list(model) {
    const out = [];
    for (const p of (model && model.projects) || []) {
      for (const t of p.tickets || []) {
        if (t.archived) continue; // 보관한 시트의 결정은 모으지 않는다
        for (const r of t.rows || []) {
          if (!r || r.kind !== 'decision') continue;
          r.ticket = t.slug;
          r.project = p.key;
          r.workspace = t.workspace || (model && model.workspace) || '';
          r.repo = t.repo || '';
          out.push(r);
        }
      }
    }
    return out;
  }

  /* 세 묶음 — 막는 결정 · 답할 결정 · 끝남. 막는 결정이 맨 위다.
     답할 결정 안에서는 아직 답 없는 줄이 먼저고, 답은 했지만 에이전트가 아직 안 읽은 줄이 뒤다. */
  function groups(decisions) {
    const all = Array.isArray(decisions) ? decisions : [];
    const blocking = all.filter(isBlocking);
    const done = all.filter((d) => !isOpen(d));
    const ask = all.filter((d) => isOpen(d) && !isBlocking(d))
      .map((d, i) => ({ d, i, a: answerOf(d) ? 1 : 0 }))
      .sort((x, y) => x.a - y.a || x.i - y.i).map((x) => x.d);
    return [
      { key: 'blocking', label: '막는 결정', icon: 's-dec', cls: 'blk', items: blocking },
      { key: 'ask', label: '답할 결정', icon: 's-todo', cls: 'todo', items: ask },
      { key: 'done', label: '끝남', icon: 's-done', cls: 'done', items: done },
    ];
  }

  const blockingCount = (decisions) => (Array.isArray(decisions) ? decisions : []).filter(isBlocking).length;

  // 로컬에서 답을 바꾼 뒤 사이드바 숫자를 다시 맞춘다. 결정 행은 티켓 rows에 한 벌뿐이다.
  function applyUser(model, ticket, id, user, ws) {
    if (!model) return;
    for (const p of model.projects || []) {
      for (const t of p.tickets || []) {
        if (!sameTicket(t, ticket, ws)) continue;
        for (const r of t.rows || []) {
          if (!r || String(r.id) !== String(id) || r.kind !== 'decision') continue;
          r.user = { ...(r.user || {}), ...user };
          r.blocking = isBlocking(r);
        }
      }
    }
    const all = list(model);
    const s = (model.summary = model.summary || {});
    s.decisions_open = all.filter(isOpen).length;
    s.decisions_blocking = blockingCount(all);
  }

  function find(model, ticket, display, ws) {
    const all = list(model).filter((d) => !ws || !d.workspace || d.workspace === ws);
    return all.find((d) => d.display_id === display && (!ticket || d.ticket === ticket))
      || all.find((d) => d.display_id === display) || null;
  }

  // 모든 레포 화면에서 줄이 어디서 왔는지 — 워크스페이스 키(같은 레포의 워크트리도 구분된다)
  const whereOf = (d) => (d.workspace ? `<span class="where">${esc(d.workspace)}</span>` : '');

  /* ── 결정 메뉴 ─────────────────────────────────────── */

  function metaOf(d) {
    const bits = [tail(d.ticket)];
    if (!isOpen(d)) {
      bits.push(answerOf(d) ? '사용자 답' : (d.reversible !== false && hasRec(d) ? '추천대로' : '답 없이 끝남'));
    } else if (isBlocking(d)) {
      const ids = d.blocked_node_ids || [];
      bits.push('되돌리기 어려움');
      if (ids.length) bits.push(`막는 노드 ${ids.join(', ')}`);
    } else if (answerOf(d)) {
      bits.push('답함 · 반영 대기');
    } else if (d.reversible !== false) {
      bits.push('되돌리기 쉬움');
      if (hasRec(d)) bits.push('답 없으면 추천대로');
    }
    return bits.filter(Boolean).join(' · ');
  }

  function opsOf(d) {
    const a = answerOf(d);
    const ops = optionsOf(d).slice(0, 4).map((o) => {
      const on = a !== '' && String(o.key) === a;
      const rec = String(o.key) === String(d.recommend);
      return `<span class="op${on ? ' ans' : ''}${rec && !on ? ' rec' : ''}"${rec ? ' title="추천"' : ''}>` +
        `${on ? '✓ ' : ''}${esc(o.key)} ${esc(o.label || '')}</span>`;
    });
    if (a && !optOf(d, a)) ops.push(`<span class="op ans">✓ ${esc(a)}</span>`);
    return ops.join('');
  }

  function row(d, g, global, short) {
    const id = short ? String(d.display_id || '').split('-').pop() : d.display_id; // 시트 안에서는 시트 머리를 뺀 D1
    return `<div class="drow is-${g.cls}" role="button" tabindex="0" data-dec="${esc(d.display_id)}" data-ticket="${esc(d.ticket)}" data-dec-ws="${esc(d.workspace || '')}">` +
      icon(g.icon, 'st st-' + g.cls) +
      `<span class="id" title="${esc(d.display_id)}">${esc(id)}</span>` +
      `<div class="ti"><b>${esc(d.title)}</b><div class="m">${esc(metaOf(d))}</div></div>` +
      `<div class="ops">${opsOf(d)}</div>${global ? whereOf(d) : ''}</div>`;
  }

  // opts.short — 한 시트만 보일 때(시트의 결정 탭) ID를 줄인다
  function menu(model, opts) {
    const gs = groups(list(model));
    const global = !!(model && model.global);
    const short = !!(opts && opts.short);
    let h = '<div class="dlist">';
    for (const g of gs) {
      h += `<h2 class="dgh" data-group="${g.key}">${icon(g.icon, 'st st-' + g.cls)}${esc(g.label)} <span class="n">${g.items.length}</span></h2>`;
      h += g.items.map((d) => row(d, g, global, short)).join('');
    }
    return h + '</div>';
  }

  /* ── 결정 모달 ─────────────────────────────────────── */

  const CONF = { high: '높음', mid: '중간', low: '낮음' };

  function unlocks(d, model) {
    const keys = d.blocked_nodes || [];
    if (!keys.length) return '<div class="rel is-none">막는 노드 없음</div>';
    const slug = d.ticket;
    let nodes = [];
    for (const p of (model && model.projects) || []) {
      for (const t of p.tickets || []) if (sameTicket(t, slug, d.workspace)) nodes = t.nodes || [];
    }
    return keys.map((k) => {
      const n = nodes.find((x) => x.key === k) || { key: k, id: k, title: '' };
      const others = (n.blocked_by || []).filter((x) => String(x) !== String(d.id)).length;
      return `<div class="rel">${icon('s-wait', 'st st-wait', 12)}<span class="id">${esc(n.id || k)}</span>` +
        `<span class="rt-t">${esc(n.title || '')}</span>` +
        (others ? `<span class="chip" title="다른 열린 결정도 이 노드를 막는다">결정 +${others}</span>` : '') + '</div>';
    }).join('');
  }

  function stateText(d) {
    if (!isOpen(d)) return '끝남';
    if (isBlocking(d)) return '막는 결정';
    return answerOf(d) ? '답함 · 반영 대기' : '답할 결정';
  }

  /* 모달 조각 — view.js의 modalShell이 틀을 입힌다. st = 컨트롤러 state. */
  function modalParts(d, st, model) {
    st = st || {};
    const open = isOpen(d);
    const opts = optionsOf(d);
    const choice = st.choice || '';
    const gwt = [['Given', d.given], ['When', d.when], ['Then', d.then]].filter((x) => x[1]);

    let main = `<h1>${icon('s-dec', 'st st-blk', 18)}${esc(d.title)}</h1>`;
    if (gwt.length) {
      main += '<dl class="gwt">' + gwt.map((x) => `<dt>${x[0]}</dt><dd>${esc(x[1])}</dd>`).join('') + '</dl>';
    }
    main += '<div class="mh">답</div>';
    opts.forEach((o, i) => {
      const on = choice === String(o.key);
      const rec = String(o.key) === String(d.recommend);
      main += `<label class="mo${on ? ' on' : ''}${rec ? ' rec' : ''}${open ? '' : ' is-ro'}"${open ? ` data-opt="${esc(o.key)}"` : ''}>` +
        icon(on ? 's-done' : 's-todo', 'st st-' + (on ? 'done' : 'todo'), 16) +
        `<div><b>${esc(o.key)} ${esc(o.label || '')}</b>${rec ? '<span class="tag">추천</span>' : ''}` +
        (o.why ? `<div class="y">${esc(o.why)}</div>` : '') + '</div>' +
        (open && i < 9 ? `<kbd>${i + 1}</kbd>` : '') + '</label>';
    });
    const freeOn = choice === FREE;
    main += `<label class="mo free${freeOn ? ' on' : ''}${open ? '' : ' is-ro'}"${open ? ` data-opt="${FREE}"` : ''}>` +
      icon(freeOn ? 's-done' : 's-todo', 'st st-' + (freeOn ? 'done' : 'todo'), 16) +
      '<div>직접 쓰기…</div></label>';
    if (open) {
      main += `<textarea class="free-text" data-dec-text rows="2" maxlength="${MAX_TEXT}" placeholder="선택지에 없는 답을 한두 줄로">${esc(st.text || '')}</textarea>`;
    } else if (answerOf(d) && !optOf(d, answerOf(d))) {
      main += `<div class="mo on is-ro">${icon('s-done', 'st st-done', 16)}<div>${esc(answerOf(d))}</div></div>`;
    }
    if (st.notice) main += `<div class="note" role="status">${esc(st.notice)}</div>`;

    const pp = (k, v) => `<div class="pp"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
    let side = pp('상태', esc(stateText(d)));
    side += pp('되돌리기', d.reversible === false ? '어려움' : d.reversible === true ? '쉬움' : '—');
    if (CONF[d.confidence]) side += pp('확신', CONF[d.confidence]);
    side += `<div class="ph">답하면 풀림</div>${unlocks(d, model)}`;

    const foot = open
      ? `<span class="kb"><kbd>1</kbd>…<kbd>${Math.max(1, Math.min(9, opts.length))}</kbd> 고르기</span>` +
        `<button class="btn-primary" type="button" data-dec-submit${st.can ? '' : ' disabled'}>${st.busy ? '저장 중…' : '답하기'}</button>`
      : '<span class="kb">끝난 결정이에요</span>';

    const project = (model && model.global && d.workspace ? `${esc(d.workspace)} › ` : '') + (d.project ? `${esc(d.project)} › ` : '');
    return {
      label: d.title,
      crumb: `${project}${esc(tail(d.ticket))} › <b>${esc(d.display_id)}</b>`,
      ticket: d.ticket, main, side, foot,
    };
  }

  /* ── 컨트롤러 — 모달 상태와 답하기. DOM을 모른다 ─────────
     opts.getModel()      지금 모델
     opts.post(url, body) → Promise<{status, json}>  (view.js가 fetch를 감싸 준다)
     opts.onChange()      모달을 다시 그리라는 신호
     opts.onSaved()       답이 저장됐다 — 사이드바·메뉴를 다시 그리고 모델을 다시 읽는다
     opts.onConflict()    409로 서버 값을 받았다 — 모달은 그대로 두고 뒤 화면만 서버 값에 맞춘다 */
  function controller(opts) {
    const st = { open: null, choice: '', text: '', busy: false, notice: '', focusText: false };
    const change = () => { if (opts.onChange) opts.onChange(); };
    const model = () => opts.getModel() || {};
    const current = () => {
      if (!st.open) return null;
      return list(model()).find((d) => d.ticket === st.open.ticket && String(d.id) === String(st.open.id)
        && (!st.open.ws || !d.workspace || d.workspace === st.open.ws)) || null;
    };
    const value = () => (st.choice === FREE ? st.text.trim() : st.choice);

    function seed(d) {
      const a = answerOf(d);
      st.choice = a ? (optOf(d, a) ? String(optOf(d, a).key) : FREE) : '';
      st.text = a && !optOf(d, a) ? a : '';
    }

    const api = {
      state: st,
      // 모달 조각에 넘길 모양 — state에 "답하기를 눌러도 되는가"를 얹는다
      view: () => ({ ...st, can: api.canSubmit() }),
      current,
      value,
      canSubmit() {
        const d = current();
        return !!d && isOpen(d) && !st.busy && value() !== '' && value() !== answerOf(d);
      },
      open(ticket, display, ws) {
        const d = find(model(), ticket, display, ws);
        if (!d) return false;
        st.open = { ticket: d.ticket, id: d.id, ws: d.workspace || '' };
        st.busy = false; st.notice = ''; st.focusText = false;
        seed(d);
        change();
        return true;
      },
      close() {
        if (!st.open) return;
        st.open = null; st.busy = false; st.notice = '';
        change();
      },
      choose(key) {
        const d = current();
        if (!d || !isOpen(d) || st.busy) return;
        if (key === FREE) { st.choice = FREE; st.focusText = true; }
        else if (optOf(d, key)) st.choice = String(optOf(d, key).key);
        else return;
        st.notice = '';
        change();
      },
      // 숫자 키 — 1부터 선택지 순서
      chooseNth(n) {
        const d = current();
        const o = d && optionsOf(d)[n - 1];
        if (o) api.choose(String(o.key));
      },
      // 글자를 칠 때는 다시 그리지 않는다 (입력 중 포커스를 지키려고). 처음 칠 때만 고름을 FREE로 옮긴다.
      setText(t) {
        st.text = String(t || '').slice(0, MAX_TEXT);
        if (st.choice !== FREE) { st.choice = FREE; change(); }
      },
      async submit() {
        const d = current();
        if (!d || !isOpen(d) || st.busy) return { ok: false, reason: 'closed' };
        const v = value();
        if (!v) return { ok: false, reason: 'empty' };
        const ws = d.workspace || model().workspace; // 모든 레포 화면이면 그 줄의 레포에 쓴다
        if (!ws) { st.notice = MSG_FAILED; change(); return { ok: false, reason: 'no-workspace' }; }
        st.busy = true; st.notice = '';
        change();
        const url = `/w/${encodeURIComponent(ws)}/api/user`;
        const body = { sheet: d.ticket, id: d.id, user: { answer: v }, base: { answer: String((d.user || {}).answer || '') } };
        let res;
        try { res = await opts.post(url, body); } catch (e) { res = { status: 0, json: {} }; }
        st.busy = false;
        const j = (res && res.json) || {};
        if (res && res.status === 200 && j.ok) {
          applyUser(model(), d.ticket, d.id, j.user || { answer: v }, ws);
          st.open = null; st.notice = '';
          change();
          if (opts.onSaved) opts.onSaved();
          return { ok: true };
        }
        if (res && res.status === 409) {
          // 다른 곳에서 먼저 바뀌었다 — 서버 값을 받아 보여 주고, 사용자가 다시 고르게 한다
          if (j.user) applyUser(model(), d.ticket, d.id, j.user, ws);
          const fresh = current();
          if (fresh) seed(fresh);
          st.notice = `${MSG_CONFLICT}. 지금 값으로 다시 보여 드려요`;
          change();
          if (opts.onConflict) opts.onConflict();
          return { ok: false, conflict: true };
        }
        st.notice = MSG_FAILED;
        change();
        return { ok: false, status: res ? res.status : 0 };
      },
    };
    return api;
  }

  return {
    esc, FREE, MSG_CONFLICT, MSG_FAILED, answerOf, isOpen, isBlocking, hasRec, list, groups, blockingCount,
    applyUser, find, row, menu, modalParts, controller, keyOf, metaOf, sameTicket,
  };
});
