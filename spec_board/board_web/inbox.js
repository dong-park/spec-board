/* Inbox — 사람이 지금 해야 할 일 목록. 어느 화면에서나 같은 목록·같은 줄이고, 좁은 화면 배치는 board.css가 맡는다.
   결정 줄에는 선택지 버튼, 확인 대기 줄에는 통과·고쳐줘 버튼이 있다.
   답하기는 결정 모달의 컨트롤러(decisions.js)를, 통과·고쳐줘는 노드 모달의 컨트롤러(node_modal.js)를 그대로 쓴다 —
   쓰는 칸은 거기와 같다(결정 `user.answer`, 노드 `user.verdict`·`user.fix`). 상태·담당 칸은 안 건드린다.
   순수 함수(items·html)와 DOM 없는 controller, 위임 listener만 거는 bind로 나눴다.
   속성 이름: 제목(결정 모달을 여는 곳)만 기존 규약대로 data-dec·data-ticket이고, 그 밖의 줄·버튼은 data-in-*이다.
   data-ticket을 달면 document 위임의 티켓 모달이 같이 열린다(ticket_modal.js) — 버튼에 달지 않는다.
   확인 카드는 본문(제목·메타·첫 근거 썸네일)을 누르면 노드 모달이 열린다 — 열기는 node_modal.js의 mount가 data-nm-open으로 한다.
   브라우저에서는 전역 BoardInbox로, node에서는 require로 같은 파일을 쓴다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./decisions.js'), require('./node_modal.js'), require('./verdict.js'));
  } else root.BoardInbox = factory(root.BoardDecisions, root.BoardNodeModal, root.BoardVerdict);
})(typeof self !== 'undefined' ? self : this, function (Dec, NodeModal, Verdict) {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const icon = (id, cls, size) =>
    `<svg class="${cls || ''}" width="${size || 14}" height="${size || 14}" aria-hidden="true"><use href="#${id}"/></svg>`;
  const tail = (s) => String(s || '').split('/').filter(Boolean).pop() || '';

  /* 목록 — 열린 결정(막는 결정이 위, 아직 답 없는 것이 먼저)과 확인 대기 노드(아직 안 누른 것이 먼저).
     사이드바 Inbox 숫자(decisions_open + to_check)와 같은 집합이다. */
  function items(model) {
    const m = model || {};
    const g = Dec.groups(Dec.list(m));
    const decisions = [
      ...g[0].items.map((d) => ({ d, blocking: true })),
      ...g[1].items.map((d) => ({ d, blocking: false })),
    ];
    const checks = [];
    for (const p of m.projects || []) {
      for (const t of p.tickets || []) {
        if (t.archived) continue; // 보관한 시트는 Inbox에 올리지 않는다
        for (const n of t.nodes || []) {
          if (n.state === '확인 대기' && !n.error) checks.push({ n, ticket: t, done: n.verdict === '통과' || n.verdict === '고쳐줘' });
        }
      }
    }
    checks.sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0)); // 안정 정렬 — 같은 쪽 안에서는 원래 순서
    return { decisions, checks };
  }

  const count = (model) => { const it = items(model); return it.decisions.length + it.checks.length; };

  /* ── 줄 ─────────────────────────────────────────── */

  const noteOf = (st, key) => (st && st.note && st.note.key === key
    ? `<p class="inote${st.note.err ? ' is-err' : ''}" role="${st.note.err ? 'alert' : 'status'}">${esc(st.note.text)}</p>` : '');

  function decisionRow(it, st) {
    const d = it.d;
    const key = `d|${d.ticket}|${d.display_id}`;
    const answer = Dec.answerOf(d);
    const armed = st && st.armed && st.armed.ticket === d.ticket && st.armed.display === d.display_id ? st.armed.key : '';
    const busy = !!(st && st.busy === key);
    const opts = (Array.isArray(d.options) ? d.options : []).filter((o) => o && o.key != null);
    const buttons = opts.map((o) => {
      const k = String(o.key);
      const on = answer !== '' ? answer === k : armed === k;
      const rec = k === String(d.recommend);
      return `<button type="button" class="ibtn${rec ? ' rec' : ''}" data-in-pick data-in-ticket="${esc(d.ticket)}" data-in-dec="${esc(d.display_id)}" data-in-key="${esc(k)}"` +
        ` aria-pressed="${on}"${busy ? ' disabled' : ''}>${on ? '✓ ' : ''}${esc(k)} ${esc(o.label || '')}${rec ? '<span class="tag">추천</span>' : ''}</button>`;
    });
    let foot = buttons.join('');
    if (!opts.length) { // 선택지가 없으면 직접 써야 한다 — 결정 모달로 보낸다
      foot = `<button type="button" class="ibtn" data-dec="${esc(d.display_id)}" data-ticket="${esc(d.ticket)}">직접 쓰기…</button>`;
    }
    if (armed) { // 되돌리기 어려운 결정은 한 번 눌러 고르고, 한 번 더 눌러 답한다 (n10: 한 번에 확정되지 않게)
      foot += `<span class="iconf"><button type="button" class="btn btn-primary" data-in-send${busy ? ' disabled' : ''}>${busy ? '저장 중…' : '답하기'}</button>` +
        `<button type="button" class="btn" data-in-unarm${busy ? ' disabled' : ''}>취소</button></span>`;
    }
    const cls = it.blocking ? 'blk' : answer ? 'done' : 'todo';
    return `<div class="irow is-${cls}" data-in="dec" data-in-ticket="${esc(d.ticket)}" data-in-dec="${esc(d.display_id)}">` +
      `<div class="ih">${icon(it.blocking ? 's-dec' : 's-todo', 'st st-' + (it.blocking ? 'blk' : 'todo'))}` +
      `<span class="id">${esc(d.display_id)}</span>` +
      `<b class="it" role="button" tabindex="0" data-dec="${esc(d.display_id)}" data-ticket="${esc(d.ticket)}">${esc(d.title)}</b></div>` +
      `<div class="im">${esc(Dec.metaOf(d))}</div>${noteOf(st, key)}` +
      `<div class="ib">${foot}</div></div>`;
  }

  function checkRow(it, st) {
    const n = it.n;
    const key = `c|${it.ticket.slug}|${n.key}`;
    const eff = Verdict.effective(n);
    const fixing = !!(st && st.fixing && st.fixing.ticket === it.ticket.slug && st.fixing.key === n.key);
    const busy = !!(st && st.busy === key);
    const bits = [tail(it.ticket.slug), '확인 대기'];
    const nChecks = NodeModal.checkItems(n).length;
    if (nChecks) bits.push(`확인할 것 ${nChecks}개`);
    if ((n.evidence || []).length) bits.push(`근거 ${n.evidence.length}개`);
    const img = (n.evidence || []).find(NodeModal.isImage);
    const thumb = img && st && st.workspace
      ? `<img class="in-th" src="${esc(NodeModal.evidenceUrl(st.workspace, it.ticket.slug, n.key, img))}" alt="${esc(img)}" loading="lazy">` : '';
    if (eff.pending === '통과') bits.push('통과 남김 · 반영 대기');
    else if (eff.pending === '고쳐줘') bits.push(`고쳐줘 남김${n.fix ? `: ${n.fix}` : ''} · 반영 대기`);

    let foot;
    if (fixing) {
      foot = `<textarea class="in-fix" rows="3" maxlength="2000" data-in-draft placeholder="무엇을 고칠까요? (Ctrl/⌘+Enter로 보내기)" aria-label="고칠 내용"${busy ? ' disabled' : ''}>${esc(st.draft)}</textarea>` +
        `<button type="button" class="btn btn-primary" data-in-fix-send${busy ? ' disabled' : ''}>${busy ? '저장 중…' : '보내기'}</button>` +
        `<button type="button" class="btn" data-in-fix-cancel${busy ? ' disabled' : ''}>취소</button>`;
    } else {
      const lock = busy ? ' disabled' : '';
      foot = `<button type="button" class="btn" data-in-fix data-in-ticket="${esc(it.ticket.slug)}" data-in-key="${esc(n.key)}" aria-pressed="${n.verdict === '고쳐줘'}"${lock}>${n.verdict === '고쳐줘' ? '✓ ' : ''}고쳐줘</button>` +
        `<button type="button" class="btn btn-primary" data-in-pass data-in-ticket="${esc(it.ticket.slug)}" data-in-key="${esc(n.key)}" aria-pressed="${n.verdict === '통과'}"${lock}>${n.verdict === '통과' ? '✓ ' : ''}통과</button>`;
    }
    return `<div class="irow is-rev" data-in="chk" data-in-ticket="${esc(it.ticket.slug)}" data-in-key="${esc(n.key)}">` +
      `<div class="iopen" data-nm-open data-tkt="${esc(it.ticket.slug)}" data-key="${esc(n.key)}" role="button" tabindex="0">` +
      `<div class="itxt"><div class="ih">${icon('s-rev', 'st st-rev')}<span class="id">${esc(n.id || n.key)}</span>` +
      `<b class="it">${esc(n.title)}</b></div>` +
      `<div class="im">${esc(bits.join(' · '))}</div></div>${thumb}</div>` +
      `${noteOf(st, key)}<div class="ib">${foot}</div></div>`;
  }

  /* Inbox 본문. opts = { state(controller.view()) }. */
  function html(model, opts) {
    const o = opts || {};
    const it = items(model);
    const total = it.decisions.length + it.checks.length;
    let h = '<div class="inbox" data-inbox>';
    if (!total) return h + '<div class="empty" data-empty>지금 해야 할 일이 없어요</div></div>';
    if (it.decisions.length) {
      h += `<h2 class="dgh" data-group="decisions">${icon('s-dec', 'st st-blk')}결정 <span class="n">${it.decisions.length}</span></h2>`;
      h += it.decisions.map((x) => decisionRow(x, o.state)).join('');
    }
    if (it.checks.length) {
      h += `<h2 class="dgh" data-group="checks">${icon('s-rev', 'st st-rev')}확인 <span class="n">${it.checks.length}</span></h2>`;
      const cst = { ...(o.state || {}), workspace: (model || {}).workspace || '' };
      h += it.checks.map((x) => checkRow(x, cst)).join('');
    }
    return h + '</div>';
  }

  /* ── 컨트롤러 — 줄에서 일어나는 일. DOM을 모른다 ──────
     o.getModel()       지금 모델
     o.fetch(url, init) fetch와 같은 모양 (테스트에서 바꿔 끼운다)
     o.redraw()         화면을 다시 그리라는 신호
     o.onSaved()        결정 답이 저장됐다 — 모델을 다시 읽는다 (없으면 redraw)
     o.onConflict()     409로 서버 값을 받았다 */
  function controller(o) {
    const st = { armed: null, fixing: null, draft: '', busy: '', note: null, focusDraft: false };
    const redraw = () => { if (o.redraw) o.redraw(); };
    const model = () => o.getModel() || {};
    const post = (url, body) => o.fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.json().catch(() => ({})).then((json) => ({ status: r.status, json })));

    // 결정 답하기는 모달 컨트롤러를 그대로 쓴다. 모달 층은 이 컨트롤러가 그리지 않는다.
    const dc = Dec.controller({
      getModel: model, post, onChange: redraw,
      onSaved: () => { if (o.onSaved) o.onSaved(); else redraw(); },
      onConflict: () => { if (o.onConflict) o.onConflict(); else redraw(); },
    });
    // 통과·고쳐줘도 노드 모달 컨트롤러를 그대로 쓴다. render는 비운다 (모달을 그리지 않는다).
    const nc = NodeModal.controller({ fetch: (p, i) => o.fetch(p, i), getModel: model, redraw, render: () => {} });

    const setNote = (key, text, err) => { st.note = text ? { key, text, err: !!err } : null; };
    const clear = () => { st.note = null; };

    async function answer(d, key) {
      const rowKey = `d|${d.ticket}|${d.display_id}`;
      st.busy = rowKey; st.armed = null; clear();
      redraw();
      dc.open(d.ticket, d.display_id);
      dc.choose(key);
      let r;
      try { r = await dc.submit(); } finally { st.busy = ''; }
      if (!r.ok) setNote(rowKey, dc.state.notice || '저장하지 못했어요', true);
      dc.close();
      redraw();
      return r;
    }

    const api = {
      state: st,
      view: () => ({ ...st }),
      count: () => count(model()),

      // 선택지 버튼. 되돌리기 어려운 결정은 첫 누름이 고르기이고 "답하기"가 확정이다.
      async pick(ticket, display, key) {
        if (st.busy) return { ok: false, reason: 'busy' };
        const d = Dec.find(model(), ticket, display);
        if (!d || !Dec.isOpen(d)) return { ok: false, reason: 'closed' };
        if (Dec.answerOf(d) === String(key)) { clear(); st.armed = null; redraw(); return { ok: true, same: true }; }
        if (d.reversible === false) {
          st.armed = { ticket: d.ticket, display: d.display_id, key: String(key) };
          clear(); redraw();
          return { ok: true, armed: true };
        }
        return answer(d, String(key));
      },
      async sendArmed() {
        const a = st.armed;
        if (!a || st.busy) return { ok: false, reason: 'idle' };
        const d = Dec.find(model(), a.ticket, a.display);
        if (!d || !Dec.isOpen(d)) { st.armed = null; redraw(); return { ok: false, reason: 'closed' }; }
        return answer(d, a.key);
      },
      unarm() { st.armed = null; redraw(); }, // 아무것도 쓰지 않는다

      async pass(ticket, key) {
        if (st.busy) return;
        const rowKey = `c|${ticket}|${key}`;
        st.busy = rowKey; st.fixing = null; clear();
        redraw();
        nc.open(ticket, key);
        try { await nc.pass(); } finally { st.busy = ''; }
        if (nc.state.err) setNote(rowKey, nc.state.err, true);
        nc.close();
        redraw();
      },
      startFix(ticket, key) {
        if (st.busy) return;
        st.fixing = { ticket, key }; st.draft = ''; st.armed = null; st.focusDraft = true; clear();
        redraw();
      },
      setDraft(t) { st.draft = String(t || ''); }, // 글자를 칠 때는 다시 그리지 않는다 (입력 중 포커스를 지키려고)
      cancelFix() { st.fixing = null; st.draft = ''; clear(); redraw(); }, // 아무것도 쓰지 않는다
      async sendFix() {
        const f = st.fixing;
        if (!f || st.busy) return;
        const rowKey = `c|${f.ticket}|${f.key}`;
        const text = st.draft.trim();
        if (!text) { setNote(rowKey, '고칠 내용을 적어 주세요', true); st.focusDraft = true; redraw(); return; }
        st.busy = rowKey; clear();
        redraw();
        nc.open(f.ticket, f.key);
        nc.startFix();
        nc.setDraft(text);
        try { await nc.sendFix(); } finally { st.busy = ''; }
        if (nc.state.err) setNote(rowKey, nc.state.err, true); // 입력은 열어 둔다 — 다시 보낼 수 있게
        else { st.fixing = null; st.draft = ''; }
        nc.close();
        redraw();
      },
    };
    return api;
  }

  // 그린 뒤 — 고쳐줘 입력을 열었으면 거기에 커서를 둔다
  function after(el, ctl) {
    if (!ctl || !ctl.state.focusDraft) return;
    const i = el.querySelector('[data-in-draft]');
    ctl.state.focusDraft = false;
    if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }

  // 위임 listener — 다시 그려도 한 번이면 된다. 결정 제목(data-dec)은 view.js가 모달로 연다.
  function bind(el, ctl) {
    const on = (e, sel) => (e.target && e.target.closest ? e.target.closest(sel) : null);
    el.addEventListener('click', (e) => {
      let b;
      if ((b = on(e, '[data-in-pick]'))) { e.preventDefault(); void ctl.pick(b.dataset.inTicket, b.dataset.inDec, b.dataset.inKey); }
      else if (on(e, '[data-in-send]')) { e.preventDefault(); void ctl.sendArmed(); }
      else if (on(e, '[data-in-unarm]')) { e.preventDefault(); ctl.unarm(); }
      else if ((b = on(e, '[data-in-pass]'))) { e.preventDefault(); void ctl.pass(b.dataset.inTicket, b.dataset.inKey); }
      else if ((b = on(e, '[data-in-fix]'))) { e.preventDefault(); ctl.startFix(b.dataset.inTicket, b.dataset.inKey); }
      else if (on(e, '[data-in-fix-send]')) { e.preventDefault(); void ctl.sendFix(); }
      else if (on(e, '[data-in-fix-cancel]')) { e.preventDefault(); ctl.cancelFix(); }
    });
    el.addEventListener('input', (e) => { if (on(e, '[data-in-draft]')) ctl.setDraft(e.target.value); });
    el.addEventListener('keydown', (e) => {
      if (!on(e, '[data-in-draft]')) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void ctl.sendFix(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ctl.cancelFix(); }
    });
  }

  return { items, count, html, controller, bind, after, esc };
});
