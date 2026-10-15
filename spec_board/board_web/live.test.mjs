// node --test spec_board/board_web/live.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./live.js');

const dec = (id, over) => ({ id, display_id: 'CB-' + id, kind: 'decision', title: '결정 ' + id, status: '아직 안 함', reversible: true,
  options: [{ key: 'A', label: '에이' }], recommend: 'A', user: { answer: '' }, ...over });
const node = (key, over) => ({ key, id: 'CB-' + key, title: '노드 ' + key, state: '확인 대기', verdict: '', error: '', ...over });
const G = (rows, nodes, extra) => ({ global: true, workspace: '', projects: [{ key: 'g', tickets: [
  { slug: 'cb', title: 'cb — 쿠폰 자동화 빌더', workspace: 'z-6a45', repo: 'z', rows, nodes }, ...(extra || []),
] }] });

test('할 일: 답 없는 열린 결정(막는 것 blk, 나머지 ask)과 아직 안 누른 확인 대기만', () => {
  const m = G([dec('D1'), dec('D2', { reversible: false }), dec('D3', { user: { answer: 'A' } }), dec('D4', { status: '끝남', open: false })],
    [node('n1'), node('n2', { verdict: '통과' }), node('n3', { state: '진행' })],
    [{ slug: 'old', title: 'old', workspace: 'z-6a45', archived: true, rows: [dec('D9')], nodes: [] }]);
  const t = L.todo(m);
  assert.deepEqual([...t.keys()], ['d|z-6a45|cb|CB-D1', 'd|z-6a45|cb|CB-D2', 'c|z-6a45|cb|n1']);
  assert.equal(t.get('d|z-6a45|cb|CB-D2').kind, 'blk');
  assert.equal(t.get('d|z-6a45|cb|CB-D1').kind, 'ask');
  assert.equal(t.get('c|z-6a45|cb|n1').sheet, '쿠폰 자동화 빌더');
});

test('새 항목: 처음 받은 것은 기준만, 그다음부터 새로 생긴 것만 막는 결정 → 확인 → 답할 결정 순으로', () => {
  const first = L.todo(G([dec('D1')], []));
  assert.deepEqual(L.added(null, first), [], '처음 연 탭은 알리지 않는다');
  const next = L.todo(G([dec('D1'), dec('D5'), dec('D6', { reversible: false })], [node('n7')]));
  assert.deepEqual(L.added(first, next).map((x) => x.kind + ':' + x.id), ['blk:CB-D6', 'chk:CB-n7', 'ask:CB-D5']);
  assert.deepEqual(L.added(next, next), [], '그대로면 없다');
});

test('알림 문구: 하나면 그 항목, 여럿이면 묶음 한 장 — tag가 같아 탭이 여럿이어도 겹치지 않는다', () => {
  const items = L.added(new Map(), L.todo(G([dec('D6', { reversible: false })], [node('n7'), node('n8')])));
  const one = L.notice(items.slice(0, 1));
  assert.deepEqual([one.title, one.body, one.tag], ['막는 결정 · 쿠폰 자동화 빌더', 'CB-D6 결정 D6 — z-6a45', 'd|z-6a45|cb|CB-D6']);
  const many = L.notice(items);
  assert.equal(many.title, '새로 3개 — 막는 결정 1 · 확인 대기 2');
  assert.equal(many.item, null, '묶음은 Inbox만 연다');
  assert.equal(L.notice([...items].reverse()).tag, many.tag);
});

test('설정: 기본은 꺼짐·막는 결정·확인 대기만, 망가진 값은 기본으로', () => {
  assert.deepEqual(L.load(null), { on: false, blk: true, chk: true, ask: false });
  assert.deepEqual(L.load('{"on":true,"ask":true,"blk":"yes","x":1}'), { on: true, blk: true, chk: true, ask: true });
  assert.deepEqual(L.load('{깨짐'), L.load(null));
  const items = L.added(new Map(), L.todo(G([dec('D1'), dec('D2', { reversible: false })], [])));
  assert.deepEqual(L.wanted(items, L.load(null)).map((x) => x.id), ['CB-D2'], '답할 결정은 기본으로 안 알린다');
});

test('탭 제목·종 버튼·화면 안 알림', () => {
  assert.equal(L.title(0), 'Working Board');
  assert.equal(L.title(3), '(3) Working Board');
  assert.doesNotMatch(L.bell(L.load(null), false, "yes"), /class="nt-pop"/);
  assert.match(L.bell(L.load(null), true, 'yes'), /data-nt-on/);
  assert.match(L.bell(L.load(null), true, 'no'), /데스크톱 알림을 못 띄워요/);
  assert.doesNotMatch(L.bell(L.load(null), true, 'no'), /data-nt-on/, '못 띄우는 브라우저에는 켜기가 없다');
  assert.match(L.toast(L.added(new Map(), L.todo(G([], [node('n<1>')])))), /확인 대기 · CB-n&lt;1&gt;/, '글자는 이스케이프');
});
