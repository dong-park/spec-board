/* 보내기 묶음 바 — 사람이 보드에서 남긴 입력이 언제 어느 스레드로 가는지 보여 주고 지금 보내기·붙잡기 (spec/board-wake n4).
   입력은 /api/outbox(outbox.py view). 순수 함수만 — fetch·타이머는 view.js가 한다. 남은 시간 글자는 [data-ob-left]에 마감 시각(ms)을 싣고
   view.js가 1초마다 글자만 바꾼다(다시 그리지 않는다).
   브라우저에서는 전역 BoardOutbox로, node에서는 require로 같은 파일을 쓴다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoardOutbox = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const SENT_SHOW = 90;   // 초 — 보낸 뒤 "보냄" 줄을 보여 주는 시간
  const tail = (s) => String(s || '').split('/').filter(Boolean).pop() || '';
  const short = (t) => String(t || '').slice(0, 13); // 앞 8자리가 같은 스레드가 있다(01a139c2-e0a4·01a139c2-177e)
  const hhmm = (sec) => { const d = new Date(sec * 1000); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const left = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  // 마감 시각(ms) — 받은 순간의 남은 초에서 계산한다. 붙잡았거나 보낸 묶음은 없다.
  function deadlines(view, nowMs) {
    const out = {};
    for (const b of (view && view.bundles) || []) if (b.state === 'waiting' && !b.held && b.left != null) out[b.thread] = nowMs + b.left * 1000;
    return out;
  }

  function sheetsOf(b) {
    const names = [...new Set((b.sheets || []).map((s) => tail(s.sheet)))];
    return names.slice(0, 3).join(', ') + (names.length > 3 ? ' 외 ' + (names.length - 3) + '개' : '');
  }

  /* 바 HTML. nowSec = 지금(초), dl = deadlines(). 보일 것이 없으면 ''. */
  function bar(view, nowSec, dl) {
    if (!view) return '';
    const rows = [];
    for (const b of view.bundles || []) {
      const who = '<span class="ob-t" title="' + esc(b.thread) + '">스레드 ' + esc(short(b.thread)) + '</span>';
      const sum = esc(b.summary || '') + ' · ' + esc(sheetsOf(b));
      const btn = (attr, label, pri) => '<button type="button" class="' + (pri ? 'btn-primary' : 'obb') + '" ' + attr + '="' + esc(b.thread) + '">' + label + '</button>';
      if (b.state === 'waiting' && b.error) {
        rows.push('<div class="ob is-err">' + who + '<span class="ob-m">보내지 못했어요 — ' + esc(b.error) + ' · ' + sum + '</span>' + btn('data-ob-flush', '다시 보내기', true) + '</div>');
      } else if (b.state === 'waiting' && b.held) {
        rows.push('<div class="ob">' + who + '<span class="ob-m">에이전트에게 보낼 ' + sum + ' · 붙잡음</span>' + btn('data-ob-release', '풀기') + btn('data-ob-flush', '지금 보내기', true) + '</div>');
      } else if (b.state === 'waiting' || b.state === 'sending') {
        const t = dl && dl[b.thread];
        const when = b.state === 'sending' ? '보내는 중…' : '<span data-ob-left="' + (t || '') + '">' + left(t ? (t / 1000 - nowSec) : b.left || 0) + '</span> 뒤 보냄';
        rows.push('<div class="ob">' + who + '<span class="ob-m">에이전트에게 보낼 ' + sum + ' · ' + when + '</span>' + btn('data-ob-hold', '붙잡기') + btn('data-ob-flush', '지금 보내기', true) + '</div>');
      } else if ((b.state === 'sent' || b.state === 'merged') && b.sent_at && nowSec - b.sent_at < SENT_SHOW) {
        rows.push('<div class="ob is-sent">' + who + '<span class="ob-m">' + (b.state === 'merged' ? '앞서 보낸 깨우기에 합침' : '보냄') + ' · ' + hhmm(b.sent_at) + ' · ' + sum + '</span></div>');
      }
    }
    for (const o of view.orphans || []) {
      rows.push('<div class="ob is-off"><span class="ob-m">' + esc(tail(o.sheet)) + ' 입력 ' + o.count + '건 — ' +
        (o.reason === 'off' ? '이 시트는 깨우기를 꺼 두어 보내지 않아요' : '담당 스레드가 없어 보내지 않아요. 메인 스레드가 spec-board pending을 부르면 생겨요') + '</span></div>');
    }
    return rows.length ? '<div class="obar" role="status">' + rows.join('') + '</div>' : '';
  }

  return { bar, deadlines, left, SENT_SHOW };
});
