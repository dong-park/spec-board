// 합성 데이터만 사용한다. 실제 spec과 서버 저장에는 넣지 않는다.
export function waveFixture(workspace = 'wave-fixture') {
  const node = (i, over = {}) => ({ key: `n${i}`, id: `WP-${i}`, title: `합성 작업 ${i}`, state: '아직 안 함', column: '시작 가능', deps: [], waiting_on: [], blocked_by_ids: [], warnings: [], error: '', ...over });
  const first = Array.from({ length: 29 }, (_, i) => node(i + 1, i < 7 ? {} : i === 7 ? { state: '확인 대기', verdict: '통과' } : { state: '끝남' }));
  first[0].blocked_by_ids = ['WP-D1'];
  for (let i = 30; i <= 37; i++) first.push(node(i, { deps: [i === 30 ? 'n4' : `n${i - 1}`] }));
  const tickets = [
    { slug: 'p/first', title: '첫 제목 — 긴 목록의 진행을 함께 비교한다', nodes: first },
    { slug: 'p/edges', title: '두 번째 제목 — 적은 카드와 완료만 있는 칸', nodes: [node(1), node(2, { state: '끝남', deps: ['n1'] }), ...[3, 4, 5].map(i => node(i, { deps: ['n2'] })), node(30, { deps: ['n3'] })] },
    { slug: 'p/classify', title: '세 번째 제목 — 오류와 두 확인 결과', nodes: [node(1, { state: '끝남', verdict: '통과', error: '합성 읽기 실패' }), node(2, { state: '확인 대기', verdict: '통과' }), node(3, { state: '확인 대기', verdict: '고쳐줘' }), node(4, { state: '끝남', verdict: '통과' }), node(5, { state: '진행', verdict: '고쳐줘' })] },
    { slug: 'p/long', title: '아주 긴 네 번째 제목으로 좁은 데스크톱에서 제목과 조작 버튼의 줄바꿈을 검증한다', nodes: [1, 2, 3, 4].map(i => node(i)) },
    { slug: 'p/nodeless', title: '노드 없는 제목', nodes: [] },
  ];
  tickets[0].rows = [{ id: 'D1', display_id: 'WP-D1', kind: 'decision', title: '합성 결정', status: '아직 안 함', options: [{ key: 'A', label: '선택 A' }], user: { answer: '', fix: '' }, reversible: true }];
  return { workspace, root: '/tmp/wave-fixture', v: '1', summary: {}, projects: [{ key: 'p', title: '합성 프로젝트', state: '진행', tickets }] };
}
