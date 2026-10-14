// node --test skills/spec/scripts/board_web/board.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const B = require('./board.js');
const V = require('./view.js');

const node = (over) => ({
  key: 'n1', id: 'IB-1', title: '제목', state: '아직 안 함', deps: [], waiting_on: [], blocked_by_ids: [], warnings: [], error: '', ...over,
});
const ui = { card: V.card, esc: V.esc, icon: (id) => `<svg><use href="#${id}"/></svg>` };

// ── T11: 칸 다섯
test('칸은 시작 가능 · 진행 · 확인 대기 · 기다림 · 끝남 다섯뿐이다', () => {
  assert.deepEqual(B.COLUMNS, ['시작 가능', '진행', '확인 대기', '기다림', '끝남']);
  const html = B.html([{ slug: 't', title: 't', nodes: [node({ key: 'a' })] }], ui);
  assert.equal((html.match(/<section class="lane /g) || []).length, 5);
  const names = [...html.matchAll(/class="bch">.*?<\/svg>([^<]+)<span class="n">/g)].map((m) => m[1]);
  assert.deepEqual(names, B.COLUMNS);
  assert.doesNotMatch(html, /내 차례/);
  assert.doesNotMatch(html, /data-col="결정"/);
});

test('여섯 저장 상태가 칸으로 배정된다 — 막힘과 보류와 앞 노드를 기다리는 노드는 기다림이다', () => {
  const col = (n) => B.columnOf(n);
  assert.equal(col(node({ state: '아직 안 함' })), '시작 가능');
  assert.equal(col(node({ state: '아직 안 함', waiting_on: ['x'] })), '기다림');
  assert.equal(col(node({ state: '진행' })), '진행');
  assert.equal(col(node({ state: '확인 대기' })), '확인 대기');
  assert.equal(col(node({ state: '막힘' })), '기다림');
  assert.equal(col(node({ state: '보류' })), '기다림');
  assert.equal(col(node({ state: '끝남' })), '끝남');
  assert.equal(col(node({ state: '모름', error: '읽기 실패' })), '기다림');
});

test('시작 가능과 기다림은 저장값이 아니라 앞 노드로 읽을 때 정해진다', () => {
  // 모델이 준 column 값은 믿지 않는다 — state와 waiting_on만 본다.
  assert.equal(B.columnOf(node({ state: '아직 안 함', column: '기다림', waiting_on: [] })), '시작 가능');
  assert.equal(B.columnOf(node({ state: '아직 안 함', column: '시작 가능', waiting_on: ['a'] })), '기다림');
});

test('기다림 칸은 막힘이 맨 위, 그다음 보류, 앞 노드를 기다리는 노드 순이다', () => {
  const nodes = [
    node({ key: 'w1', state: '아직 안 함', waiting_on: ['x'] }),
    node({ key: 'h1', state: '보류' }),
    node({ key: 'w2', state: '아직 안 함', waiting_on: ['x'] }),
    node({ key: 'b1', state: '막힘' }),
    node({ key: 'h2', state: '보류' }),
    node({ key: 'b2', state: '막힘' }),
  ];
  const wait = B.assign(nodes)['기다림'].map((n) => n.key);
  assert.deepEqual(wait, ['b1', 'b2', 'h1', 'h2', 'w1', 'w2']);
});

test('기다림 말고 다른 칸은 입력 순서를 그대로 지킨다', () => {
  const cols = B.assign([node({ key: 'z', state: '끝남' }), node({ key: 'a', state: '끝남' }), node({ key: 'm', state: '진행' })]);
  assert.deepEqual(cols['끝남'].map((n) => n.key), ['z', 'a']);
  assert.deepEqual(cols['진행'].map((n) => n.key), ['m']);
});

test('화면에서도 막힘 카드가 기다림 칸 맨 위에 그려진다', () => {
  const nodes = [
    node({ key: 'w', id: 'IB-W', state: '아직 안 함', waiting_on: ['x'] }),
    node({ key: 'h', id: 'IB-H', state: '보류' }),
    node({ key: 'b', id: 'IB-B', state: '막힘', blocked_by_ids: ['IB-D1'] }),
  ];
  const html = B.html([{ slug: 't', title: 't', nodes }], ui);
  const lane = html.match(/<section class="lane l-wait"[\s\S]*?<\/section>/)[0];
  const order = [...lane.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['IB-B', 'IB-H', 'IB-W']);
  assert.match(lane, /<span class="n">3<\/span>/);
});

test('위쪽 요약은 아이콘과 숫자 칩 4개다', () => {
  const nodes = [
    node({ key: 'a', state: '아직 안 함' }),
    node({ key: 'b', state: '아직 안 함' }),
    node({ key: 'c', state: '진행' }),
    node({ key: 'd', state: '막힘', blocked_by_ids: ['IB-D1', 'IB-D2'] }),
    node({ key: 'e', state: '진행', blocked_by_ids: ['IB-D1'] }),
    node({ key: 'f', state: '끝남', blocked_by_ids: ['IB-D9'] }),
  ];
  assert.deepEqual(B.summary(nodes), { ready: 2, prog: 2, dec: 2, done: 1, total: 6 });
  const html = B.html([{ slug: 't', title: 't', nodes }], ui);
  const top = html.match(/<div class="wtop">([\s\S]*?)<\/div>/)[1];
  assert.equal((top.match(/class="kpi /g) || []).length, 4);
  assert.equal((top.match(/<svg>/g) || []).length, 4, '칩마다 아이콘 하나');
  assert.deepEqual([...top.matchAll(/<b>(\d+)/g)].map((m) => m[1]), ['2', '2', '2', '1']);
  assert.match(top, / \/ 6/);
  assert.doesNotMatch(top, />\s*(시작 가능|진행|결정|끝남)\s*</, '칩에 글자 이름표가 없다');
});

test('카드는 view.card가 그리고 칸에 맞춰 상태 아이콘이 정해진다', () => {
  const nodes = [node({ key: 'a', id: 'IB-A', state: '아직 안 함' }), node({ key: 'b', id: 'IB-B', state: '아직 안 함', waiting_on: ['a'] })];
  const html = B.html([{ slug: 't', title: 't', nodes }], { ...ui, icon: (id, c, s) => `<svg class="${c || ''}"><use href="#${id}"/></svg>` });
  assert.match(html, /is-todo" data-key="a"/);
  assert.match(html, /is-wait" data-key="b"/);
  assert.match(html, /<span class="chip dep"[^>]*>IB-A<\/span>/, '앞 노드 칩은 화면 ID');
});

test('티켓이 여럿이어도 한 칸에 모이고, 읽기 실패 노드도 보드를 멈추지 않는다', () => {
  const t1 = { slug: 'p/a', title: 'a', nodes: [node({ key: 'x', id: 'A-1', state: '진행' })] };
  const t2 = { slug: 'p/b', title: 'b', nodes: [node({ key: 'x', id: 'B-1', state: '진행' }), node({ key: 'bad', id: 'B-2', state: '모름', error: '읽기 실패: KeyError' })] };
  const html = B.html([t1, t2], ui);
  const prog = html.match(/<section class="lane l-prog"[\s\S]*?<\/section>/)[0];
  assert.deepEqual([...prog.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]), ['A-1', 'B-1']);
  assert.match(html.match(/<section class="lane l-wait"[\s\S]*?<\/section>/)[0], /읽기 실패/);
});

test('규모 — 티켓 15개·노드 100개도 칸 다섯으로 한 번에 그려진다', () => {
  const tickets = Array.from({ length: 15 }, (_, i) => ({
    slug: `p/t${i}`, title: `t${i}`,
    nodes: Array.from({ length: i < 10 ? 7 : 6 }, (_, j) => node({
      key: `n${j}`, id: `T${i}-${j}`,
      state: ['아직 안 함', '진행', '확인 대기', '막힘', '보류', '끝남', '끝남'][j % 7],
      waiting_on: j % 7 === 0 && j ? ['n0'] : [],
    })),
  }));
  const total = tickets.reduce((a, t) => a + t.nodes.length, 0);
  assert.equal(total, 100);
  const html = B.html(tickets, ui);
  assert.equal((html.match(/<article class="card /g) || []).length, 100, '잘라 내지 않고 전부 그린다');
  assert.equal((html.match(/<section class="lane /g) || []).length, 5);
});

test('view.stage(board)는 board 칸을, 다른 화면은 그대로다', () => {
  const model = { projects: [{ key: 'p', title: 'P', tickets: [{ slug: 'p/a', title: 'a', nodes: [node({ key: 'a', id: 'P-1', state: '진행' })] }] }] };
  const html = V.stage(model, { view: 'board', project: 'p' });
  assert.match(html, /<div class="board">/);
  assert.match(html, /<b>Board<\/b>/);
  assert.doesNotMatch(V.stage(model, { view: 'tickets', project: 'p' }), /class="board"/);
});

test('제목이 이스케이프된다', () => {
  const html = B.html([{ slug: 't', title: 't', nodes: [node({ key: 'a', title: '<img src=x onerror=alert(1)>' })] }], ui);
  assert.doesNotMatch(html, /<img/);
});

// ── T17·T18: 확인 결과가 에이전트 반영 전에도 칸에 보인다 (n15 실브라우저 확인에서 못 옮겨 가던 것)
test('확인 대기 노드에 통과를 남기면 확인 대기 칸에서 사라져 끝남 칸에 놓인다', () => {
  const n = node({ key: 'r1', state: '확인 대기', verdict: '통과' });
  assert.equal(B.columnOf(n), '끝남');
  const cols = B.assign([n, node({ key: 'r2', state: '확인 대기' })]);
  assert.deepEqual(cols['확인 대기'].map((x) => x.key), ['r2']);
  assert.deepEqual(cols['끝남'].map((x) => x.key), ['r1']);
});

test('확인 대기 노드에 고쳐줘를 남기면 진행 칸으로 돌아간다', () => {
  const n = node({ key: 'r1', state: '확인 대기', verdict: '고쳐줘', fix: '한 줄' });
  assert.equal(B.columnOf(n), '진행');
  assert.deepEqual(B.assign([n])['진행'].map((x) => x.key), ['r1']);
});

test('확인 결과는 확인 대기일 때만 칸을 옮긴다 — 끝남 뒤에 남은 verdict는 기록일 뿐이다', () => {
  assert.equal(B.columnOf(node({ state: '끝남', verdict: '고쳐줘' })), '끝남');
  assert.equal(B.columnOf(node({ state: '진행', verdict: '통과' })), '진행');
});

test('위쪽 요약의 끝남·진행 숫자도 파생 칸을 따른다', () => {
  const s = B.summary([
    node({ key: 'a', state: '확인 대기', verdict: '통과' }),
    node({ key: 'b', state: '확인 대기', verdict: '고쳐줘' }),
    node({ key: 'c', state: '확인 대기' }),
  ]);
  assert.equal(s.done, 1);
  assert.equal(s.prog, 1);
});
