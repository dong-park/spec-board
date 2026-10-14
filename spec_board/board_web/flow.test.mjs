// node --test spec_board/board_web/flow.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Flow = require('./flow.js');

const n = (key, state, over) => ({ key, id: 'T-' + key, title: key.toUpperCase(), state, column: state === '아직 안 함' ? '시작 가능' : state, deps: [], blocked_by_ids: [], ...over });
const ticket = {
  slug: 't', title: 'T',
  nodes: [n('a', '끝남'), n('b', '진행', { deps: ['a'] }), n('c', '확인 대기', { deps: ['a'] }), n('d', '아직 안 함', { blocked_by_ids: ['T-D1'] })],
  waves: [
    { w: 1, at: '2026-10-13 13:30', nodes: [{ key: 'a', state: '끝남' }, { key: 'c', state: '확인 대기' }], dur: 'a 약 5분, c 약 25분', review: 'ok' },
    { w: 2, at: '2026-10-14 09:00', nodes: [{ key: 'a', state: '끝남' }, { key: 'b', state: '진행' }], dur: '', review: 'no' },
  ],
};
const TODAY = '2026-10-14';
const ui = { esc: String, icon: () => '', look: () => ({ cls: 'x', icon: 'i' }), tk: () => '', workspace: 'w', state: new Map(), today: TODAY };
const labels = (o) => Flow.groups(ticket, o, TODAY).groups.map((g) => g.label);
const keys = (o) => Flow.groups(ticket, o, TODAY).groups.map((g) => g.rows.map((r) => r.key));

test('웨이브 묶음: 지금 → 최근 웨이브 → 옛 웨이브 → 아직 안 돈 노드, 같은 노드는 웨이브마다 한 줄', () => {
  assert.deepEqual(labels(), ['지금', 'W2', 'W1', '아직']);
  assert.deepEqual(keys(), [['b'], ['a', 'b'], ['a', 'c'], ['d']]);
  const g = Flow.groups(ticket, {}, TODAY).groups;
  assert.equal(g[2].at, '13:30');
  assert.equal(g[2].dur, '25m', '병렬 노드 시간은 더하지 않고 가장 긴 것');
});

test('상태 묶음과 묶지 않음(들어온 순서 = 처음 돈 웨이브 순)', () => {
  assert.deepEqual(labels({ group: 'state' }), ['확인 대기', '진행', '시작 가능', '끝남']);
  assert.deepEqual(keys({ group: 'none' }), [['a', 'c', 'b', 'd']]);
  assert.deepEqual(keys({ group: 'none', order: 'id' }), [['a', 'b', 'c', 'd']]);
  assert.deepEqual(keys({ group: 'none', order: 'recent' })[0].slice(0, 2), ['a', 'b'], '마지막 웨이브가 최근인 노드가 앞');
});

test('끝남 숨김·오늘은 끝난 줄만 빼고 몇 개 뺐는지 센다', () => {
  const hide = Flow.groups(ticket, { done: 'hide' }, TODAY);
  assert.ok(!hide.groups.some((g) => g.rows.some((r) => r.key === 'a')));
  assert.equal(hide.hidden, 1);
  const today = Flow.groups(ticket, { done: 'today' }, TODAY);
  assert.ok(today.groups.some((g) => g.rows.some((r) => r.key === 'a')), 'a는 오늘(W2) 돌았다');
  assert.equal(Flow.groups(ticket, { done: 'today' }, '2026-10-20').hidden, 1);
});

test('필터 칩과 저장된 보기', () => {
  assert.deepEqual(keys({ group: 'none', filters: [{ k: 'state', v: '확인 대기' }] }), [['c']]);
  assert.deepEqual(keys({ group: 'none', filters: [{ k: 'since', v: '2' }] }), [['a', 'b']]);
  assert.deepEqual(keys({ group: 'none', filters: [{ k: 'blocked' }] }), [['d']]);
  assert.deepEqual(keys({ group: 'none', view: 'mine' }), [['c', 'd']], '사람 필요 = 확인 대기·막힘·결정에 막힘');
  assert.equal(Flow.viewCount(ticket, 'all', TODAY), 4);
  assert.equal(Flow.viewCount(ticket, 'mine', TODAY), 2);
  assert.equal(Flow.viewCount(ticket, 'today', TODAY), 2);
});

test('list: 옛 웨이브는 접지만 사람이 볼 노드가 든 웨이브는 편다, 줄에 앞·뒤 사슬이 실린다', () => {
  const t = { ...ticket, waves: [...ticket.waves, { w: 3, at: '2026-10-14 10:00', nodes: [{ key: 'b', state: '진행' }], dur: '' }] };
  const h = Flow.list(t, 0, ui, {});
  assert.match(h, /<b class="fw">W1<\/b>/);
  assert.match(h, /data-n="0:c"/, 'W1은 옛 웨이브지만 확인 대기(c)가 있어 펴져 있다');
  assert.doesNotMatch(h, /data-w="0:2" data-up/, 'W2는 접혀 줄이 없다');
  assert.match(h, /data-n="0:a"[^>]*data-up="" data-down="0:b 0:c"/);
});

test('list: 끝남을 숨기면 "끝남 N개 숨김 · 보이기" 버튼이 남는다', () => {
  assert.match(Flow.list(ticket, 0, ui, { done: 'hide' }), /data-sv="done-all">끝남 1개 숨김 · 보이기/);
  assert.match(Flow.list({ slug: 'e', nodes: [], waves: [] }, 0, ui, {}), /노드가 없어요/);
});
