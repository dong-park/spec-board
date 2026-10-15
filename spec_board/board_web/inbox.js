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

  /* 목록 — 사람이 아직 안 한 일만. 답 없는 열린 결정(막는 결정이 위)과 아직 통과·고쳐줘를 안 누른 확인 대기 노드.
     답했거나 눌렀으면 에이전트 차례라 빠진다(보낸 것은 아래 묶음 바, 답 바꾸기는 Decisions·시트 결정 탭).
     사이드바 Inbox 숫자와 같은 집합이다. */
  // 답했어도 아직 보여야 하는 줄 — 안내(409·실패)가 떠 있거나, 고쳐줘를 쓰는 중이거나, 저장 중인 줄. 사라지면 안내도 같이 사라진다
  function keepKeys(st) {
    const k = new Set();
    if (!st) return k;
    if (st.note && st.note.key) k.add(st.note.key);
    if (st.busy) k.add(st.busy);
    if (st.fixing) k.add(`c|${st.fixing.ws || ''}|${st.fixing.ticket}|${st.fixing.key}`);
    if (st.noting) k.add(`s|${st.noting.ws || ''}|${st.noting.ticket}|${st.noting.key}`);
    return k;
  }

  /* 막힘 노드의 댓글 읽기 — 사람 글에 아직 답이 없는 스레드가 있으면 에이전트 차례(waiting).
     사유는 에이전트가 마지막으로 남긴 글(첫 줄), 답글은 그 스레드로 단다. 해결로 닫힌 스레드는 안 본다. */
  function stuckTalk(n) {
    const all = Array.isArray(n.comments) ? n.comments : [];
    const roots = all.filter((c) => c && !c.reply_to);
    let waiting = false, reason = null;
    for (const r of roots) {
      const th = [r, ...all.filter((c) => c && c.reply_to === r.id)];
      let resolved = false;
      for (const c of th) if ('resolve' in c) resolved = !!c.resolve;
      if (resolved) continue;
      const texts = th.filter((c) => c.text || (Array.isArray(c.images) && c.images.length));
      if (texts.length && texts[texts.length - 1].by === 'user') waiting = true;
      for (const c of texts) if (c.text && c.by === 'agent' && (!reason || String(c.at || '') >= String(reason.at || ''))) reason = { text: c.text, at: c.at, thread: r.id };
    }
    return { waiting, reason };
  }

  function items(model, keep) {
    const m = model || {};
    const kept = keep || new Set();
    const g = Dec.groups(Dec.list(m));
    const decisions = [
      ...g[0].items.map((d) => ({ d, blocking: true })),
      ...g[1].items.map((d) => ({ d, blocking: false })),
    ].filter((x) => !Dec.answerOf(x.d) || kept.has(`d|${x.d.workspace || ''}|${x.d.ticket}|${x.d.display_id}`));
    const checks = [];
    const stuck = []; // 막힘인데 막는 열린 결정이 없다 — 보드에 질문이 없어 사람이 모르고 지나치기 쉽다
    for (const p of m.projects || []) {
      for (const t of p.tickets || []) {
        if (t.archived) continue; // 보관한 시트는 Inbox에 올리지 않는다
        for (const n of t.nodes || []) {
          if (n.state === '확인 대기' && !n.error) {
            const done = n.verdict === '통과' || n.verdict === '고쳐줘';
            const ws = t.workspace || m.workspace || '';
            if (!done || kept.has(`c|${ws}|${t.slug}|${n.key}`)) checks.push({ n, ticket: t, ws, done });
          }
          else if (n.state === '막힘' && !n.error && !(n.blocked_by || []).length) {
            const ws = t.workspace || m.workspace || '';
            const talk = stuckTalk(n);
            // 사람이 마지막으로 답했으면 에이전트 차례라 뺀다(답한 결정과 같은 규칙)
            if (!talk.waiting || kept.has(`s|${ws}|${t.slug}|${n.key}`)) stuck.push({ n, ticket: t, ws, talk });
          }
        }
      }
    }
    checks.sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0)); // 안정 정렬 — 같은 쪽 안에서는 원래 순서
    return { decisions, checks, stuck };
  }

  const count = (model) => { const it = items(model); return it.decisions.length + it.checks.length + it.stuck.length; };

  // 추천대로 한 번에 답해도 되는 결정 — 열려 있고, 아직 답이 없고, 되돌리기 쉽고, 추천이 선택지에 있다.
  // 되돌리기 어려운 결정은 지금처럼 줄에서 두 번 눌러 답한다.
  const bulkable = (d) => Dec.isOpen(d) && !Dec.answerOf(d) && d.reversible !== false && Dec.hasRec(d);
  const tkey = (ws, ticket) => `${ws || ''}|${ticket}`;

  /* 출처 칩 — 모든 레포 화면에서만. 글자는 워크스페이스(시트 이름은 아래 메타 줄에 이미 있다),
     누르면 그 레포 보드의 시트로 간다(view.js의 a[data-ws] 이동). 결정 줄은 시트의 결정 탭(#sd/)으로. */
  const where = (ws, slug, tab) => (ws
    ? `<a class="where" href="/w/${esc(encodeURIComponent(ws))}/board/#${tab || 's'}/${esc(slug)}" data-ws="${esc(ws)}" data-hash="#${tab || 's'}/${esc(slug)}" title="${esc(ws)} › ${esc(slug)} 시트 열기">${esc(ws)}</a>`
    : '');

  /* ── 줄 ─────────────────────────────────────────── */

  const noteOf = (st, key) => (st && st.note && st.note.key === key
    ? `<p class="inote${st.note.err ? ' is-err' : ''}" role="${st.note.err ? 'alert' : 'status'}">${esc(st.note.text)}</p>` : '');

  const newTag = '<span class="tagnew">새</span>';

  function decisionRow(it, st, global, fresh) {
    const d = it.d;
    const ws = d.workspace || '';
    const key = `d|${ws}|${d.ticket}|${d.display_id}`;
    const answer = Dec.answerOf(d);
    const armed = st && st.armed && st.armed.ticket === d.ticket && st.armed.display === d.display_id && (st.armed.ws || '') === ws ? st.armed.key : '';
    const busy = !!(st && st.busy === key);
    const opts = (Array.isArray(d.options) ? d.options : []).filter((o) => o && o.key != null);
    const buttons = opts.map((o) => {
      const k = String(o.key);
      const on = answer !== '' ? answer === k : armed === k;
      const rec = k === String(d.recommend);
      return `<button type="button" class="ibtn${rec ? ' rec' : ''}" data-in-pick data-in-ws="${esc(ws)}" data-in-ticket="${esc(d.ticket)}" data-in-dec="${esc(d.display_id)}" data-in-key="${esc(k)}"` +
        ` aria-pressed="${on}"${busy ? ' disabled' : ''}>${on ? '✓ ' : ''}${esc(k)} ${esc(o.label || '')}${rec ? '<span class="tag">추천</span>' : ''}</button>`;
    });
    let foot = buttons.join('');
    if (!opts.length) { // 선택지가 없으면 직접 써야 한다 — 결정 모달로 보낸다
      foot = `<button type="button" class="ibtn" data-dec="${esc(d.display_id)}" data-ticket="${esc(d.ticket)}" data-dec-ws="${esc(ws)}">직접 쓰기…</button>`;
    }
    if (armed) { // 되돌리기 어려운 결정은 한 번 눌러 고르고, 한 번 더 눌러 답한다 (n10: 한 번에 확정되지 않게)
      foot += `<span class="iconf"><button type="button" class="btn btn-primary" data-in-send${busy ? ' disabled' : ''}>${busy ? '저장 중…' : '답하기'}</button>` +
        `<button type="button" class="btn" data-in-unarm${busy ? ' disabled' : ''}>취소</button></span>`;
    }
    const cls = it.blocking ? 'blk' : answer ? 'done' : 'todo';
    const isNew = !!(fresh && fresh.has(key));
    return `<div class="irow is-${cls}${isNew ? ' is-new' : ''}" data-in="dec" data-in-ws="${esc(ws)}" data-in-ticket="${esc(d.ticket)}" data-in-dec="${esc(d.display_id)}">` +
      `<div class="ih">${icon(it.blocking ? 's-dec' : 's-todo', 'st st-' + (it.blocking ? 'blk' : 'todo'))}` +
      `<span class="id">${esc(d.display_id)}</span>` +
      `<b class="it" role="button" tabindex="0" data-dec="${esc(d.display_id)}" data-ticket="${esc(d.ticket)}" data-dec-ws="${esc(ws)}">${esc(d.title)}</b>` +
      `${isNew ? newTag : ''}${global ? where(ws, d.ticket, 'sd') : ''}</div>` +
      `<div class="im">${esc(Dec.metaOf(d))}</div>${noteOf(st, key)}` +
      `<div class="ib">${foot}</div></div>`;
  }

  function checkRow(it, st, global, fresh) {
    const n = it.n;
    const ws = it.ws || '';
    const key = `c|${ws}|${it.ticket.slug}|${n.key}`;
    const eff = Verdict.effective(n);
    const fixing = !!(st && st.fixing && st.fixing.ticket === it.ticket.slug && st.fixing.key === n.key && (st.fixing.ws || '') === ws);
    const busy = !!(st && st.busy === key);
    const bits = [tail(it.ticket.slug), '확인 대기'];
    const nChecks = NodeModal.checkItems(n).length;
    if (nChecks) bits.push(`확인할 것 ${nChecks}개`);
    if ((n.evidence || []).length) bits.push(`근거 ${n.evidence.length}개`);
    const img = (n.evidence || []).find(NodeModal.isImage);
    const thumb = img && ws
      ? `<img class="in-th" src="${esc(NodeModal.evidenceUrl(ws, it.ticket.slug, n.key, img))}" alt="${esc(img)}" loading="lazy">` : '';
    if (eff.pending === '통과') bits.push('통과 남김 · 반영 대기');
    else if (eff.pending === '고쳐줘') bits.push(`고쳐줘 남김${n.fix ? `: ${n.fix}` : ''} · 반영 대기`);

    let foot;
    if (fixing) {
      foot = `<textarea class="in-fix" rows="3" maxlength="2000" data-in-draft placeholder="무엇을 고칠까요? (Ctrl/⌘+Enter로 보내기)" aria-label="고칠 내용"${busy ? ' disabled' : ''}>${esc(st.draft)}</textarea>` +
        `<button type="button" class="btn btn-primary" data-in-fix-send${busy ? ' disabled' : ''}>${busy ? '저장 중…' : '보내기'}</button>` +
        `<button type="button" class="btn" data-in-fix-cancel${busy ? ' disabled' : ''}>취소</button>`;
    } else {
      const lock = busy ? ' disabled' : '';
      foot = `<button type="button" class="btn" data-in-fix data-in-ws="${esc(ws)}" data-in-ticket="${esc(it.ticket.slug)}" data-in-key="${esc(n.key)}" aria-pressed="${n.verdict === '고쳐줘'}"${lock}>${n.verdict === '고쳐줘' ? '✓ ' : ''}고쳐줘</button>` +
        `<button type="button" class="btn btn-primary" data-in-pass data-in-ws="${esc(ws)}" data-in-ticket="${esc(it.ticket.slug)}" data-in-key="${esc(n.key)}" aria-pressed="${n.verdict === '통과'}"${lock}>${n.verdict === '통과' ? '✓ ' : ''}통과</button>`;
    }
    const isNew = !!(fresh && fresh.has(key));
    return `<div class="irow is-rev${isNew ? ' is-new' : ''}" data-in="chk" data-in-ws="${esc(ws)}" data-in-ticket="${esc(it.ticket.slug)}" data-in-key="${esc(n.key)}">` +
      `<div class="iopen" data-nm-open data-tkt="${esc(it.ticket.slug)}" data-key="${esc(n.key)}" data-ws="${esc(ws)}" role="button" tabindex="0">` +
      `<div class="itxt"><div class="ih">${icon('s-rev', 'st st-rev')}<span class="id">${esc(n.id || n.key)}</span>` +
      `<b class="it">${esc(n.title)}</b>${isNew ? newTag : ''}${global ? where(ws, it.ticket.slug) : ''}</div>` +
      `<div class="im">${esc(bits.join(' · '))}</div></div>${thumb}</div>` +
      `${noteOf(st, key)}<div class="ib">${foot}</div></div>`;
  }

  /* 한 시트에 추천대로 답할 수 있는 결정이 둘 이상이면 그 시트의 첫 줄 앞에 한 번에 답하는 줄을 둔다. */
  function bulkRow(ws, slug, n, st, global) {
    const key = `b|${tkey(ws, slug)}`;
    const busy = !!(st && st.busy);
    return `<div class="ibulk" data-in="bulk">` +
      `<span class="im">${global && ws ? esc(ws) + ' › ' : ''}${esc(tail(slug))} · 되돌리기 쉬운 결정 ${n}개</span>` +
      `<button type="button" class="btn" data-in-bulk data-in-ws="${esc(ws)}" data-in-ticket="${esc(slug)}"${busy ? ' disabled' : ''}>` +
      `${st && st.busy === key ? '저장 중…' : `추천대로 ${n}개 답하기`}</button>${noteOf(st, key)}</div>`;
  }

  /* Inbox 본문. opts = { state(controller.view()), fresh(새로 온 줄 키 Set — live.js) }. model.global이면 줄마다 출처 칩이 붙는다. */
  function html(model, opts) {
    const o = opts || {};
    const it = items(model, keepKeys(o.state));
    const global = !!(model && model.global);
    const total = it.decisions.length + it.checks.length + it.stuck.length;
    let h = '<div class="inbox" data-inbox>';
    if (!total) return h + '<div class="empty" data-empty>지금 해야 할 일이 없어요</div></div>';
    if (it.decisions.length) {
      h += `<h2 class="dgh" data-group="decisions">${icon('s-dec', 'st st-blk')}결정 <span class="n">${it.decisions.length}</span></h2>`;
      const nBulk = new Map();
      for (const x of it.decisions) if (bulkable(x.d)) { const k = tkey(x.d.workspace, x.d.ticket); nBulk.set(k, (nBulk.get(k) || 0) + 1); }
      const shown = new Set();
      for (const x of it.decisions) {
        const k = tkey(x.d.workspace, x.d.ticket);
        if (bulkable(x.d) && nBulk.get(k) > 1 && !shown.has(k)) {
          shown.add(k);
          h += bulkRow(x.d.workspace, x.d.ticket, nBulk.get(k), o.state, global);
        }
        h += decisionRow(x, o.state, global, o.fresh);
      }
    }
    if (it.checks.length) {
      h += `<h2 class="dgh" data-group="checks">${icon('s-rev', 'st st-rev')}확인 <span class="n">${it.checks.length}</span></h2>`;
      h += it.checks.map((x) => checkRow(x, o.state, global, o.fresh)).join('');
    }
    if (it.stuck.length) {
      h += `<h2 class="dgh" data-group="stuck">${icon('s-blk', 'st st-blk')}막힘 · 방향이 필요해요 <span class="n">${it.stuck.length}</span></h2>`;
      h += it.stuck.map((x) => stuckRow(x, o.state, global)).join('');
    }
    return h + '</div>';
  }

  const ASK_TEXT = '왜 막혔는지와 풀려면 무엇이 필요한지 알려 주세요. 사람이 정할 선택이면 spec-board node block으로 결정을 올려 주시고, 앞 작업을 기다리는 거면 보류로 바꿔 주세요.';

  /* 결정 없이 막힌 노드 — 사유(에이전트의 마지막 글)를 보이고, 방향 답하기(그 스레드에 답글) 또는 사유가 없으면 이유 물어보기.
     보낸 글은 댓글이라 담당 스레드가 깨어난다. 본문을 누르면 노드 모달. */
  function stuckRow(it, st, global) {
    const n = it.n;
    const ws = it.ws || '';
    const key = `s|${ws}|${it.ticket.slug}|${n.key}`;
    const reason = it.talk && it.talk.reason;
    const busy = !!(st && st.busy === key);
    const noting = !!(st && st.noting && st.noting.key === n.key && st.noting.ticket === it.ticket.slug && (st.noting.ws || '') === ws);
    const attrs = ` data-in-ws="${esc(ws)}" data-in-ticket="${esc(it.ticket.slug)}" data-in-key="${esc(n.key)}"`;
    const why = reason
      ? `<div class="ireason"><b>사유</b> ${esc(String(reason.text).split('\n')[0].slice(0, 220))}</div>`
      : '<div class="ireason is-none">사유가 남아 있지 않아요</div>';
    let foot;
    if (noting) {
      foot = `<textarea class="in-fix" rows="3" maxlength="2000" data-in-note-draft placeholder="어떻게 풀지 적어 주세요 (Ctrl/⌘+Enter로 보내기)" aria-label="방향"${busy ? ' disabled' : ''}>${esc(st.noteDraft || '')}</textarea>` +
        `<button type="button" class="btn btn-primary" data-in-note-send${busy ? ' disabled' : ''}>${busy ? '보내는 중…' : '보내기'}</button>` +
        `<button type="button" class="btn" data-in-note-cancel${busy ? ' disabled' : ''}>취소</button>`;
    } else if (reason) {
      foot = `<button type="button" class="btn btn-primary" data-in-note${attrs} data-in-reply="${esc(reason.thread)}"${busy ? ' disabled' : ''}>방향 답하기</button>`;
    } else {
      foot = `<button type="button" class="btn" data-in-ask${attrs}${busy ? ' disabled' : ''}>${busy ? '보내는 중…' : '이유 물어보기'}</button>` +
        `<button type="button" class="btn" data-in-note${attrs}${busy ? ' disabled' : ''}>직접 적기</button>`;
    }
    return `<div class="irow is-stuck" data-in="stuck"${attrs}>` +
      `<div class="iopen" data-nm-open data-tkt="${esc(it.ticket.slug)}" data-key="${esc(n.key)}" data-ws="${esc(ws)}" role="button" tabindex="0">` +
      `<div class="itxt"><div class="ih">${icon('s-blk', 'st st-blk')}<span class="id">${esc(n.id || n.key)}</span>` +
      `<b class="it">${esc(n.title)}</b>${global ? where(ws, it.ticket.slug) : ''}</div>` +
      `<div class="im">${esc(tail(it.ticket.slug))} · 막힘</div>${why}</div></div>` +
      `${noteOf(st, key)}<div class="ib">${foot}</div></div>`;
  }

  /* ── 컨트롤러 — 줄에서 일어나는 일. DOM을 모른다 ──────
     o.getModel()       지금 모델
     o.fetch(url, init) fetch와 같은 모양 (테스트에서 바꿔 끼운다)
     o.redraw()         화면을 다시 그리라는 신호
     o.onSaved()        결정 답이 저장됐다 — 모델을 다시 읽는다 (없으면 redraw)
     o.onConflict()     409로 서버 값을 받았다 */
  function controller(o) {
    const st = { armed: null, fixing: null, draft: '', busy: '', note: null, focusDraft: false, noting: null, noteDraft: '' };
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
    // 줄의 워크스페이스 — 모든 레포 화면이면 버튼에 실린 값, 한 워크스페이스 화면이면 그 모델의 것
    const wsOr = (ws) => ws || model().workspace || '';

    /* 막힘 노드에 사람 댓글 하나 — 서버가 담당 스레드 묶음에 넣어 깨운다. 성공하면 화면 모델에도 덧붙여 줄이 바로 빠진다. */
    async function comment(ticket, key, ws, text, reply) {
      ws = wsOr(ws);
      const rowKey = `s|${ws}|${ticket}|${key}`;
      st.busy = rowKey; clear();
      redraw();
      let res;
      try {
        res = await post(`/w/${encodeURIComponent(ws)}/api/comment`, { sheet: ticket, id: key, comment: reply ? { text, reply_to: reply } : { text } });
      } catch (e) { res = { status: 0, json: {} }; }
      st.busy = '';
      if (res.status === 200 && res.json && Array.isArray(res.json.comments)) {
        for (const p of model().projects || []) {
          for (const t of p.tickets || []) {
            if (t.slug !== ticket || (t.workspace && t.workspace !== ws)) continue;
            const n = (t.nodes || []).find((x) => x.key === key);
            if (n) n.comments = res.json.comments;
          }
        }
        st.noting = null; st.noteDraft = '';
        redraw();
        if (o.onSaved) o.onSaved();
        return { ok: true };
      }
      setNote(rowKey, (res.json && res.json.error) || '보내지 못했어요', true);
      redraw();
      return { ok: false };
    }

    async function answer(d, key) {
      const rowKey = `d|${d.workspace || ''}|${d.ticket}|${d.display_id}`;
      st.busy = rowKey; st.armed = null; clear();
      redraw();
      dc.open(d.ticket, d.display_id, d.workspace);
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
      async pick(ticket, display, key, ws) {
        if (st.busy) return { ok: false, reason: 'busy' };
        const d = Dec.find(model(), ticket, display, ws);
        if (!d || !Dec.isOpen(d)) return { ok: false, reason: 'closed' };
        if (Dec.answerOf(d) === String(key)) { clear(); st.armed = null; redraw(); return { ok: true, same: true }; }
        if (d.reversible === false) {
          st.armed = { ticket: d.ticket, display: d.display_id, key: String(key), ws: d.workspace || '' };
          clear(); redraw();
          return { ok: true, armed: true };
        }
        return answer(d, String(key));
      },
      async sendArmed() {
        const a = st.armed;
        if (!a || st.busy) return { ok: false, reason: 'idle' };
        const d = Dec.find(model(), a.ticket, a.display, a.ws);
        if (!d || !Dec.isOpen(d)) { st.armed = null; redraw(); return { ok: false, reason: 'closed' }; }
        return answer(d, a.key);
      },
      unarm() { st.armed = null; redraw(); }, // 아무것도 쓰지 않는다

      /* 한 시트의 되돌리기 쉬운 결정을 추천대로 차례로 답한다. 하나라도 못 쓰면 거기서 멈추고 줄에 알린다.
         답 하나하나는 줄의 선택지 버튼과 같은 길(결정 모달 컨트롤러)로 간다. */
      async bulk(ticket, ws) {
        if (st.busy) return { ok: false, reason: 'busy' };
        ws = wsOr(ws);
        const todo = Dec.list(model()).filter((d) => d.ticket === ticket && (d.workspace || '') === (ws || '') && bulkable(d))
          .map((d) => ({ display: d.display_id, key: String(d.recommend) }));
        const rowKey = `b|${tkey(ws, ticket)}`;
        let done = 0;
        for (const x of todo) {
          const d = Dec.find(model(), ticket, x.display, ws);
          if (!d || !bulkable(d)) continue; // 그사이 다른 곳에서 답했다
          const r = await answer(d, x.key);
          if (!r.ok) {
            setNote(rowKey, `${d.display_id}에서 멈췄어요 — ${dc.state.notice || '저장하지 못했어요'}`, true);
            redraw();
            return { ok: false, done };
          }
          done++;
        }
        return { ok: true, done };
      },

      async pass(ticket, key, ws) {
        if (st.busy) return;
        ws = wsOr(ws);
        const rowKey = `c|${ws || ''}|${ticket}|${key}`;
        st.busy = rowKey; st.fixing = null; clear();
        redraw();
        nc.open(ticket, key, ws);
        try { await nc.pass(); } finally { st.busy = ''; }
        if (nc.state.err) setNote(rowKey, nc.state.err, true);
        nc.close();
        redraw();
      },
      startFix(ticket, key, ws) {
        if (st.busy) return;
        st.fixing = { ticket, key, ws: wsOr(ws) }; st.draft = ''; st.armed = null; st.focusDraft = true; clear();
        redraw();
      },
      setDraft(t) { st.draft = String(t || ''); }, // 글자를 칠 때는 다시 그리지 않는다 (입력 중 포커스를 지키려고)
      cancelFix() { st.fixing = null; st.draft = ''; clear(); redraw(); }, // 아무것도 쓰지 않는다

      // 막힘 — 방향 답하기(사유 스레드에 답글)·직접 적기·이유 물어보기
      startNote(ticket, key, ws, reply) {
        if (st.busy) return;
        st.noting = { ticket, key, ws: wsOr(ws), reply: reply || '' }; st.noteDraft = ''; st.fixing = null; st.focusDraft = true; clear();
        redraw();
      },
      setNoteDraft(t) { st.noteDraft = String(t || ''); },
      cancelNote() { st.noting = null; st.noteDraft = ''; clear(); redraw(); },
      async sendNote() {
        const n = st.noting;
        if (!n || st.busy) return { ok: false };
        const text = st.noteDraft.trim();
        if (!text) { setNote(`s|${n.ws}|${n.ticket}|${n.key}`, '방향을 적어 주세요', true); st.focusDraft = true; redraw(); return { ok: false }; }
        return comment(n.ticket, n.key, n.ws, text, n.reply);
      },
      async ask(ticket, key, ws) {
        if (st.busy) return { ok: false };
        return comment(ticket, key, ws, ASK_TEXT, '');
      },
      async sendFix() {
        const f = st.fixing;
        if (!f || st.busy) return;
        const rowKey = `c|${f.ws || ''}|${f.ticket}|${f.key}`;
        const text = st.draft.trim();
        if (!text) { setNote(rowKey, '고칠 내용을 적어 주세요', true); st.focusDraft = true; redraw(); return; }
        st.busy = rowKey; clear();
        redraw();
        nc.open(f.ticket, f.key, f.ws);
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
    const i = el.querySelector('[data-in-draft], [data-in-note-draft]');
    ctl.state.focusDraft = false;
    if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }

  // 위임 listener — 다시 그려도 한 번이면 된다. 결정 제목(data-dec)은 view.js가 모달로 연다.
  function bind(el, ctl) {
    const on = (e, sel) => (e.target && e.target.closest ? e.target.closest(sel) : null);
    el.addEventListener('click', (e) => {
      let b;
      if ((b = on(e, '[data-in-pick]'))) { e.preventDefault(); void ctl.pick(b.dataset.inTicket, b.dataset.inDec, b.dataset.inKey, b.dataset.inWs); }
      else if ((b = on(e, '[data-in-bulk]'))) { e.preventDefault(); void ctl.bulk(b.dataset.inTicket, b.dataset.inWs); }
      else if (on(e, '[data-in-send]')) { e.preventDefault(); void ctl.sendArmed(); }
      else if (on(e, '[data-in-unarm]')) { e.preventDefault(); ctl.unarm(); }
      else if ((b = on(e, '[data-in-pass]'))) { e.preventDefault(); void ctl.pass(b.dataset.inTicket, b.dataset.inKey, b.dataset.inWs); }
      else if ((b = on(e, '[data-in-fix]'))) { e.preventDefault(); ctl.startFix(b.dataset.inTicket, b.dataset.inKey, b.dataset.inWs); }
      else if (on(e, '[data-in-fix-send]')) { e.preventDefault(); void ctl.sendFix(); }
      else if (on(e, '[data-in-fix-cancel]')) { e.preventDefault(); ctl.cancelFix(); }
      else if ((b = on(e, '[data-in-note]'))) { e.preventDefault(); ctl.startNote(b.dataset.inTicket, b.dataset.inKey, b.dataset.inWs, b.dataset.inReply); }
      else if ((b = on(e, '[data-in-ask]'))) { e.preventDefault(); void ctl.ask(b.dataset.inTicket, b.dataset.inKey, b.dataset.inWs); }
      else if (on(e, '[data-in-note-send]')) { e.preventDefault(); void ctl.sendNote(); }
      else if (on(e, '[data-in-note-cancel]')) { e.preventDefault(); ctl.cancelNote(); }
    });
    el.addEventListener('input', (e) => {
      if (on(e, '[data-in-draft]')) ctl.setDraft(e.target.value);
      else if (on(e, '[data-in-note-draft]')) ctl.setNoteDraft(e.target.value);
    });
    el.addEventListener('keydown', (e) => {
      if (on(e, '[data-in-note-draft]')) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void ctl.sendNote(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ctl.cancelNote(); }
        return;
      }
      if (!on(e, '[data-in-draft]')) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void ctl.sendFix(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ctl.cancelFix(); }
    });
  }

  return { items, count, html, controller, bind, after, esc };
});
