/* 확인 결과가 보드에 어떻게 보이는가 — 저장하지 않는 파생 상태다.
   상태 칸은 에이전트만 쓴다(칸 주인). 사람이 통과·고쳐줘를 남기면 `user.verdict`만 바뀌고,
   에이전트가 반영하기 전까지 카드는 이 파생 상태로 칸을 옮겨 보인다. 반영되면 저장값이 같아져 파생이 사라진다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoardVerdict = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* → { state, column, pending }
     확인 대기 + 통과   → 끝남 칸 (pending '통과')   — 확인 대기 칸에서 사라진다
     확인 대기 + 고쳐줘 → 진행 칸 (pending '고쳐줘') — 진행 칸으로 돌아간다
     그 밖에는 저장값 그대로이고 pending은 빈 문자열이다. verdict는 확인 대기일 때만 본다 —
     끝남 뒤에 남은 verdict는 기록일 뿐 칸을 옮기지 않는다. */
  function effective(node) {
    const n = node || {};
    if (n.state === '확인 대기' && !n.error) {
      if (n.verdict === '통과') return { state: '끝남', column: '끝남', pending: '통과' };
      if (n.verdict === '고쳐줘') return { state: '진행', column: '진행', pending: '고쳐줘' };
    }
    return { state: n.state, column: n.column, pending: '' };
  }

  return { effective };
});
