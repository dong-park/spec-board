// 보드 화면 진입 — index.html에 인라인으로 두지 않는다(CSP default-src 'self'가 인라인 스크립트를 막는다)
BoardView.mount(document.getElementById('app')).then(function (b) {
  if (!b) return;
  TicketModal.mount({
    getModel: b.getModel,
    w: function () { return b.getModel().workspace || new URLSearchParams(location.search).get('w') || ''; },
    go: function (hash) { location.hash = hash; },
    color: BoardView.ticketColor,
  });
  BoardNodeModal.mount({ getModel: b.getModel, redraw: b.redraw, color: BoardView.ticketColor });
});
