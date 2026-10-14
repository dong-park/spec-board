/* Flow — 시트(티켓) 하나의 노드 목록. 기본은 웨이브로 묶는다.
   묶음 머리 = 웨이브(번호·시각·노드 수·걸린 시간). 맨 위 "지금"은 진행 중인 노드다.
   줄 상태는 보고서 당시 값이 아니라 지금 상태 칸이다. 같은 노드가 두 웨이브에 돌았으면 각 웨이브에 한 줄씩 낸다.
   보기(opts): group 웨이브·상태·없음 / order 들어온 순서·최근 바뀐·ID / done 모두·오늘·숨김 / filters 칩 / view 저장된 보기.
   줄에 마우스를 올리면 앞·뒤 사슬 줄과 그 묶음 머리만 또렷하다(사슬 계산은 Waves.chain).
   html()·list()는 DOM을 만지지 않는다. 브라우저에서는 전역 BoardFlow, node에서는 require. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./waves.js'), require('./verdict.js'));
  else root.BoardFlow = factory(root.BoardWaves, root.BoardVerdict);
})(typeof self !== 'undefined' ? self : this, function (Waves, Verdict) {
  'use strict';

  const DEFAULTS = { group: 'wave', order: 'in', done: 'all', empty: false, fold: true, props: ['id', 'state', 'time'], filters: [], view: 'all' };
  const STATE_ORDER = ['확인 대기', '진행', '막힘', '시작 가능', '기다림', '보류', '끝남'];

  const hhmm = (at) => { const m = /(\d{2}:\d{2})$/.exec(String(at || '')); return m ? m[1] : ''; };
  const dayOf = (at) => String(at || '').slice(0, 10);
  const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

  /* 소요 서술의 "N분" 중 가장 큰 값. 병렬로 돈 노드를 더하면 실제보다 길어진다. 숫자가 없으면 ''. */
  function minutes(dur) {
    const all = [...String(dur || '').matchAll(/(\d+)\s*분/g)].map((m) => Number(m[1]));
    return all.length ? Math.max(...all) + 'm' : '';
  }

  /* 노드 key → {first, last} 웨이브. 웨이브는 오래된 순(w 오름차순)으로 온다. */
  function seen(t) {
    const out = {};
    for (const w of t.waves || []) {
      for (const r of w.nodes || []) {
        const s = out[r.key] || (out[r.key] = { first: w, last: w });
        s.last = w;
      }
    }
    return out;
  }

  const eff = (n) => (n.error ? { state: '모름' } : Verdict.effective(n));
  const stateKey = (n) => { const e = eff(n); return e.state === '아직 안 함' ? (n.column || '기다림') : e.state; };
  const human = (n) => { const s = eff(n).state; return s === '확인 대기' || s === '막힘' || (s !== '끝남' && (n.blocked_by_ids || []).length > 0); };

  /* 필터 칩·저장된 보기·끝남 표시를 지나는가. today는 'YYYY-MM-DD'. */
  function pass(n, s, opts, today, skipDone) {
    const e = eff(n);
    const last = s && s.last;
    if (!skipDone && e.state === '끝남') {
      if (opts.done === 'hide') return false;
      if (opts.done === 'today' && !(last && dayOf(last.at) === today)) return false;
    }
    if (opts.view === 'mine' && !human(n)) return false;
    if (opts.view === 'today' && !(last && dayOf(last.at) === today)) return false;
    for (const f of opts.filters || []) {
      if (f.k === 'state' && stateKey(n) !== f.v && e.state !== f.v) return false;
      if (f.k === 'since' && !(last && last.w >= Number(f.v))) return false;
      if (f.k === 'human' && !human(n)) return false;
      if (f.k === 'blocked' && !(e.state !== '끝남' && (n.blocked_by_ids || []).length)) return false;
    }
    return true;
  }

  function sortRows(rows, order, s) {
    const at = (n, k) => ((s[n.key] || {})[k] || {}).at || '';
    if (order === 'id') return rows.slice().sort((a, b) => natural(a.id || a.key, b.id || b.key));
    if (order === 'recent') return rows.slice().sort((a, b) => at(b, 'last').localeCompare(at(a, 'last')) || natural(a.key, b.key));
    return rows; // 들어온 순서 — 웨이브 안에서는 보고서 순서, 그 밖은 처음 돈 웨이브 순
  }

  /* 한 티켓 → {groups:[{id,label,at,dur,now,rows}], hidden} 위에서 아래 순서.
     hidden은 끝남 표시(done) 때문에만 빠진 줄 수 — "끝남 N개 숨김 · 보이기"에 쓴다. */
  function groups(t, opts, today) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    today = today || new Date().toISOString().slice(0, 10);
    const by = {};
    for (const n of t.nodes || []) by[n.key] = n;
    const s = seen(t);
    const nodes = t.nodes || [];
    const ok = (n) => pass(n, s[n.key], opts, today, false);
    const hiddenSet = new Set(nodes.filter((n) => !ok(n) && pass(n, s[n.key], opts, today, true)).map((n) => n.key));
    const out = [];
    if (opts.group === 'wave') {
      const live = nodes.filter((n) => !n.error && eff(n).state === '진행' && ok(n));
      if (live.length) out.push({ id: 'now', label: '지금', at: '', dur: '', now: true, rows: live });
      for (const w of (t.waves || []).slice().reverse()) {
        const rows = (w.nodes || []).map((r) => by[r.key] || { key: r.key, id: r.key, title: '', state: r.state, deps: [] }).filter(ok);
        if (!rows.length && !opts.empty) continue;
        out.push({ id: String(w.w), label: 'W' + w.w, at: hhmm(w.at) || dayOf(w.at).slice(5), dur: minutes(w.dur), now: false, rows: sortRows(rows, opts.order, s) });
      }
      const never = nodes.filter((n) => !s[n.key] && eff(n).state !== '진행' && ok(n));
      if (never.length) out.push({ id: 'next', label: '아직', at: '', dur: '', now: false, rows: sortRows(never, opts.order, s) });
    } else if (opts.group === 'state') {
      for (const k of STATE_ORDER) {
        const rows = nodes.filter((n) => stateKey(n) === k && ok(n));
        if (rows.length) out.push({ id: 's-' + k, label: k, at: '', dur: '', now: false, rows: sortRows(rows, opts.order, s) });
      }
    } else {
      let rows = nodes.filter(ok);
      if (opts.order === 'in') rows = rows.slice().sort((a, b) => (((s[a.key] || {}).first || {}).w || 1e9) - (((s[b.key] || {}).first || {}).w || 1e9) || natural(a.key, b.key));
      else rows = sortRows(rows, opts.order, s);
      if (rows.length) out.push({ id: 'all', label: '', at: '', dur: '', now: false, flat: true, rows });
    }
    return { groups: out, hidden: hiddenSet.size, seen: s };
  }

  const stateWord = (n) => { const e = eff(n); return e.state === '아직 안 함' ? (n.column || e.state) : e.state; };

  /* 시트 하나의 목록. ti는 같은 화면에 여러 시트가 있을 때 사슬 참조를 가른다.
     ui = {esc, icon, look, workspace, state(Map)}. "지금"과 가장 최근 묶음은 펴고, opts.fold면 옛 웨이브는 접는다. */
  function list(t, ti, ui, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    const { groups: gs, hidden, seen: s } = groups(t, opts, ui.today);
    const props = new Set(opts.props || []);
    let h = '';
    if (!gs.length) h += '<p class="none fnone">' + ((t.nodes || []).length ? '보일 노드가 없어요' : '노드가 없어요') + '</p>';
    const newest = (gs.find((g) => !g.now) || {}).id;
    for (const g of gs) {
      let open = true;
      if (!g.flat) {
        const key = Waves.choiceKey(ui.workspace, t.slug, 'flow' + g.id);
        const choice = (ui.state && ui.state.get(key)) || {};
        const early = g.now || g.id === newest || opts.group !== 'wave' || !opts.fold || g.rows.some(human); // 사람이 볼 노드가 든 웨이브는 접지 않는다
        open = early ? !choice.folded : !!choice.open;
        h += '<div class="fgh' + (g.now ? ' now' : '') + '" data-w="' + ti + ':' + ui.esc(g.id) + '">' +
          '<button type="button" class="fgb" data-wave-choice="' + ui.esc(key) + '" data-wave-action="' + (early ? 'folded' : 'open') + '" aria-expanded="' + open + '">' +
          '<span class="chev" aria-hidden="true">' + (open ? '▾' : '▸') + '</span><b class="fw">' + ui.esc(g.label) + '</b>' +
          (g.at ? '<span class="fm">' + ui.esc(g.at) + '</span>' : '') + '<span class="fm">· ' + g.rows.length + '</span>' +
          (g.dur ? '<span class="fr">' + ui.esc(g.dur) + '</span>' : '') + '</button></div>';
      }
      if (!open) continue;
      for (const n of g.rows) {
        const c = Waves.chain(t.nodes, n.key);
        const ref = (k) => ti + ':' + k;
        const k = n.error ? { cls: 'err', icon: 's-blk' } : ui.look(n);
        const last = (s[n.key] || {}).last;
        const side = [];
        if (opts.group !== 'wave' && props.has('wave') && last) side.push('<span class="fx">W' + last.w + '</span>');
        if (opts.group !== 'wave' && props.has('time') && last) side.push('<span class="fx">' + ui.esc(hhmm(last.at) || dayOf(last.at).slice(5)) + '</span>');
        if (props.has('state')) side.push('<span class="fs">' + ui.esc(n.error ? '읽기 실패' : stateWord(n)) + '</span>');
        const dec = (n.blocked_by_ids || [])[0];
        h += '<div class="fir" data-nm-open data-key="' + ui.esc(n.key) + '" data-id="' + ui.esc(n.id || n.key) + '" data-tkt="' + ui.esc(t.slug) + '" tabindex="0" ' +
          'data-n="' + ui.esc(ref(n.key)) + '" data-w="' + ti + ':' + ui.esc(g.id) + '" ' +
          'data-up="' + ui.esc([...c.up].map(ref).join(' ')) + '" data-down="' + ui.esc([...c.down].map(ref).join(' ')) + '">' +
          '<span class="id">' + (props.has('id') ? ui.esc(n.id || n.key) : '') + '</span>' + ui.icon(k.icon, 'st st-' + k.cls) +
          '<span class="t">' + ui.esc(n.title || n.key) + '<span class="ftag"></span></span>' +
          '<span class="fside">' + (dec && eff(n).state !== '끝남' ? '<span class="chip dec" data-dec="' + ui.esc(dec) + '" data-ticket="' + ui.esc(t.slug) + '">◆ ' + ui.esc(dec) + '</span>' : '') + side.join('') + '</span></div>';
      }
    }
    if (hidden) h += '<button type="button" class="fhid" data-sv="done-all">끝남 ' + hidden + '개 숨김 · 보이기</button>';
    return '<div class="flow" data-flow="' + ui.esc(t.slug) + '">' + h + '</div>';
  }

  /* 여러 시트를 한 화면에 — 프로젝트 뷰에서 쓴다. 시트마다 머리줄 하나. */
  function html(tickets, ui, opts) {
    const all = (tickets || []).filter((t) => (t.nodes || []).length || (t.waves || []).length);
    if (!all.length) return '<div class="empty">노드가 없어요</div>';
    return all.map((t, ti) => '<section class="fsec"><h2 class="gh" data-ticket="' + ui.esc(t.slug) + '">' + ui.tk(t.slug) +
      '<span class="gt">' + ui.esc(ui.short ? ui.short(t) : t.title) + '</span></h2>' + list(t, ti, ui, opts) + '</section>').join('');
  }

  /* 저장된 보기 탭의 숫자 — 끝남 표시·필터 칩과 상관없이 그 보기만 건 수. */
  function viewCount(t, view, today) {
    const s = seen(t);
    today = today || new Date().toISOString().slice(0, 10);
    return (t.nodes || []).filter((n) => pass(n, s[n.key], { view, filters: [], done: 'all' }, today, false)).length;
  }

  // ── DOM: 마우스 올림 ───────────────────────────────────────
  const refs = (x) => new Set(String(x || '').split(' ').filter(Boolean));

  function apply(flow, row) {
    const up = refs(row.dataset.up), down = refs(row.dataset.down);
    const heads = new Set();
    flow.classList.add('focus');
    for (const x of flow.querySelectorAll('.fir')) {
      const k = x.dataset.n, isUp = up.has(k), isDown = down.has(k), lit = x === row || isUp || isDown;
      x.classList.toggle('lit', lit);
      x.classList.toggle('hot', x === row);
      const tag = x.querySelector('.ftag');
      if (tag) tag.textContent = isUp ? '앞' : isDown ? '뒤' : '';
      if (lit) heads.add(x.dataset.w);
    }
    for (const g of flow.querySelectorAll('.fgh')) g.classList.toggle('lit', heads.has(g.dataset.w));
  }

  function clear(flow) {
    flow.classList.remove('focus');
    for (const x of flow.querySelectorAll('.fir')) { x.classList.remove('lit', 'hot'); const tg = x.querySelector('.ftag'); if (tg) tg.textContent = ''; }
    for (const g of flow.querySelectorAll('.fgh')) g.classList.remove('lit');
  }

  function bind(el) {
    const rowOf = (x) => (x && x.closest ? x.closest('.fir') : null);
    const on = (e) => { const r = rowOf(e.target); if (r) apply(r.closest('.flow'), r); };
    const off = (e) => { const r = rowOf(e.target); if (r && rowOf(e.relatedTarget) !== r) clear(r.closest('.flow')); };
    el.addEventListener('mouseover', on);
    el.addEventListener('mouseout', off);
    el.addEventListener('focusin', on);
    el.addEventListener('focusout', off);
  }

  return { DEFAULTS, STATE_ORDER, groups, minutes, list, html, viewCount, human, apply, clear, bind };
});
