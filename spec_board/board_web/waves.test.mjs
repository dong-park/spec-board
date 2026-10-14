// node --test skills/spec/scripts/board_web/waves.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const W = require('./waves.js');
const V = require('./view.js');
const here = dirname(fileURLToPath(import.meta.url));

const node = (key, deps = [], over = {}) => ({
  key, id: key.toUpperCase(), title: `노드 ${key}`, state: '아직 안 함', deps,
  waiting_on: deps, blocked_by_ids: [], warnings: [], error: '', ...over,
});
//   a ─ b ─ d ─ f        e (혼자)
//   a ─ c ─ d
const NODES = [node('a'), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c']), node('e'), node('f', ['d'])];
const ui = { card: V.card, esc: V.esc, icon: (id) => `<svg><use href="#${id}"/></svg>`, tk: () => '<span class="tk tk-1"></span>' };
const ticket = (slug, nodes, title) => ({ slug, title: title || slug, nodes });

// ── T13: 웨이브 = 의존 깊이
test('웨이브는 의존 그래프의 깊이다 — 앞 노드가 없으면 첫 웨이브', () => {
  assert.deepEqual(W.depths(NODES), { a: 0, b: 1, c: 1, d: 2, e: 0, f: 3 });
});

test('웨이브는 가장 깊은 앞 노드 다음이다', () => {
  const ns = [node('a'), node('b', ['a']), node('c', ['b']), node('x', ['a', 'c'])];
  assert.equal(W.depths(ns).x, 3);
});

test('순환·자기 의존·없는 노드 참조가 있어도 멈추고 웨이브가 나온다', () => {
  const ns = [node('a', ['b']), node('b', ['a']), node('s', ['s']), node('g', ['ghost'])];
  const d = W.depths(ns);
  for (const k of ['a', 'b', 's', 'g']) assert.ok(Number.isInteger(d[k]) && d[k] >= 0, k);
  assert.equal(d.g, 0, '없는 노드는 앞 노드로 세지 않는다');
  assert.equal(d.s, 0);
});

// ── T13: 사슬
test('사슬은 앞 노드 전부와 뒤 노드 전부이고 자기 자신과 곁가지는 뺀다', () => {
  const c = W.chain(NODES, 'd');
  assert.deepEqual([...c.up].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...c.down].sort(), ['f']);
  const a = W.chain(NODES, 'a');
  assert.deepEqual([...a.up], []);
  assert.deepEqual([...a.down].sort(), ['b', 'c', 'd', 'f']);
  const b = W.chain(NODES, 'b');
  assert.deepEqual([...b.up], ['a']);
  assert.deepEqual([...b.down].sort(), ['d', 'f']);
  assert.ok(!b.up.has('c') && !b.down.has('c'), '형제 가지(c)는 사슬이 아니다');
});

test('이어진 곳이 없는 노드의 사슬은 비어 있다', () => {
  const c = W.chain(NODES, 'e');
  assert.equal(c.up.size + c.down.size, 0);
});

test('순환이 있어도 사슬 계산이 끝난다', () => {
  const c = W.chain([node('a', ['b']), node('b', ['a'])], 'a');
  assert.deepEqual([...c.up], ['b']);
  assert.deepEqual([...c.down], ['b']);
});

// ── T13: 배치
test('웨이브 가로·티켓 세로로 놓이고 웨이브 수는 가장 깊은 티켓이 정한다', () => {
  const t1 = ticket('p/one', NODES);
  const t2 = ticket('p/two', [node('x'), node('y', ['x'])]);
  const { waves, rows } = W.layout([t1, t2, ticket('p/empty', [])]);
  assert.equal(waves, 4);
  assert.equal(rows.length, 2, '노드 없는 티켓은 줄이 없다');
  assert.deepEqual(rows[0].cells.map((c) => c.map((n) => n.key)), [['a', 'e'], ['b', 'c'], ['d'], ['f']]);
  assert.deepEqual(rows[1].cells.map((c) => c.map((n) => n.key)), [['x'], ['y'], [], []]);
  assert.deepEqual([rows[0].done, rows[0].total], [0, 6]);
});

test('같은 웨이브 안은 key의 자연 순서다', () => {
  const ns = [node('n10'), node('n2'), node('n1')];
  assert.deepEqual(W.layout([ticket('t', ns)]).rows[0].cells[0].map((n) => n.key), ['n1', 'n2', 'n10']);
});

// ── T13: 선 없음 · 꼬리표 없음
test('의존선도 글자 꼬리표도 "N장 대기" 문구도 만들지 않는다 — svg path 0개', () => {
  const html = W.html([ticket('p/one', NODES.map((n, i) => (i === 3 ? { ...n, state: '막힘', blocked_by_ids: ['IB-D1'] } : n)))], ui);
  assert.equal((html.match(/<path\b/g) || []).length, 0);
  assert.doesNotMatch(html, /<(line|polyline|polygon|canvas)\b/i);
  assert.doesNotMatch(html, /\d+\s*장/);
  assert.doesNotMatch(html, /대기 중|기다리는 중|N장/);
  assert.doesNotMatch(html, /class="wsvg"/);
});

test('웨이브 머리글과 티켓 줄과 카드가 그려진다', () => {
  const html = W.html([ticket('p/one', NODES)], ui);
  assert.deepEqual([...html.matchAll(/<div class="wh">([^<]+)<\/div>/g)].map((m) => m[1]), ['티켓', '웨이브 1', '웨이브 2', '웨이브 3', '웨이브 4']);
  assert.match(html, /<div class="wgrid" data-waves="4">/);   // 열 수는 data-waves로 싣고 view.paint가 --waves를 칠한다
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.equal((html.match(/<div class="lanehd"/g) || []).length, 1);
  assert.match(html, /<span class="c">0 \/ 6<\/span>/);
  const long = W.html([ticket('p/one', NODES, '첫 벽 — 처음 온 사람 앞에 빈 유리벽만 놓인다')], { ...ui, short: (t) => V.shortName({ title: t.title, key: t.slug }) });
  assert.match(long, /<b>첫 벽<\/b>/, '줄 머리는 제목의 앞 토막');
  assert.match(long, /class="lanehd" title="첫 벽 — 처음/, '전체 제목은 title에');
  assert.equal((html.match(/<article class="card /g) || []).length, 6);
  assert.equal((html.match(/<div class="wc"/g) || []).length, 6);
});

test('각 카드 껍데기가 앞뒤 사슬 참조를 갖고 같은 key도 티켓별로 섞이지 않는다', () => {
  const html = W.html([ticket('p/one', NODES), ticket('p/two', [node('a'), node('b', ['a'])])], ui);
  const d1 = html.match(/<div class="wc" data-n="0:d" data-up="([^"]*)" data-down="([^"]*)">/);
  assert.deepEqual(d1[1].split(' ').sort(), ['0:a', '0:b', '0:c']);
  assert.deepEqual(d1[2].split(' '), ['0:f']);
  const b2 = html.match(/<div class="wc" data-n="1:b" data-up="([^"]*)" data-down="([^"]*)">/);
  assert.deepEqual(b2[1].split(' '), ['1:a']);
  assert.equal(b2[2], '');
});

test('노드가 하나도 없으면 빈 안내만 나온다', () => {
  assert.match(W.html([ticket('t', [])], ui), /class="empty"/);
  assert.match(W.html([], ui), /class="empty"/);
});

test('view.stage(wave)가 Waves를 그린다', () => {
  const model = { projects: [{ key: 'p', title: 'P', tickets: [ticket('p/one', NODES)] }] };
  const html = V.stage(model, { view: 'wave', project: 'p' });
  assert.match(html, /<div class="wgrid"/);
  assert.match(html, /<b>Waves<\/b>/);
});

// ── T13: 마우스 올림 / 뗌
const fakeEl = (n, up = '', down = '') => {
  const cls = new Set();
  return {
    dataset: { n, up, down },
    classList: {
      toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); },
      remove: (...cs) => cs.forEach((c) => cls.delete(c)),
      add: (c) => cls.add(c),
      contains: (c) => cls.has(c),
    },
    has: (c) => cls.has(c),
  };
};
const fakeGrid = (els) => {
  const cls = new Set();
  return {
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    querySelectorAll: () => els,
  };
};

test('올리면 앞뒤 사슬만 또렷하고 앞 노드만 테두리, 떼면 원래대로', () => {
  const html = W.html([ticket('p/one', NODES)], ui);
  const els = [...html.matchAll(/<div class="wc" data-n="([^"]+)" data-up="([^"]*)" data-down="([^"]*)">/g)]
    .map((m) => fakeEl(m[1], m[2], m[3]));
  const grid = fakeGrid(els);
  const by = Object.fromEntries(els.map((e) => [e.dataset.n, e]));

  W.apply(grid, by['0:d']);
  assert.ok(grid.classList.contains('focus'));
  const lit = els.filter((e) => e.has('lit')).map((e) => e.dataset.n).sort();
  assert.deepEqual(lit, ['0:a', '0:b', '0:c', '0:d', '0:f'], '사슬 + 자기 자신만 또렷하다(e는 흐림)');
  const up = els.filter((e) => e.has('up')).map((e) => e.dataset.n).sort();
  assert.deepEqual(up, ['0:a', '0:b', '0:c'], '앞 노드만 테두리');
  assert.ok(!by['0:d'].has('up') && !by['0:f'].has('up'));

  W.apply(grid, by['0:e']); // 다른 카드로 옮기면 이전 표시가 남지 않는다
  assert.deepEqual(els.filter((e) => e.has('lit')).map((e) => e.dataset.n), ['0:e']);
  assert.equal(els.filter((e) => e.has('up')).length, 0);

  W.clear(grid);
  assert.ok(!grid.classList.contains('focus'));
  assert.equal(els.filter((e) => e.has('lit') || e.has('up')).length, 0);
});

test('CSS는 사슬 밖을 흐리게, 앞 노드를 테두리로 그리고 선·꼬리표 규칙이 없다', () => {
  const css = readFileSync(join(here, 'board.css'), 'utf8');
  assert.match(css, /\.wgrid\.focus \.wc:not\(\.lit\)\s*\{[^}]*opacity/);
  assert.match(css, /\.wc\.up > \.card\s*\{[^}]*box-shadow/);
  assert.doesNotMatch(css, /wsvg|stroke-dasharray/);
  assert.doesNotMatch(css, /border:\s*1px/);
});

test('view.mount가 Waves.bind를 부른다 — 마우스 올림이 실제 화면에서 이어진다', () => {
  // 같은 파일을 여러 노드가 고친다. mount를 다시 쓰다 이 줄이 빠지면 화면에서만 조용히 죽는다.
  const src = readFileSync(join(here, 'view.js'), 'utf8');
  assert.match(src, /Waves\.bind\(el, waves, draw\)/);
  const html = readFileSync(join(here, 'index.html'), 'utf8');
  assert.ok(html.indexOf('waves.js') > -1 && html.indexOf('waves.js') < html.indexOf('view.js'), 'waves.js는 view.js보다 먼저 읽힌다');
  assert.ok(html.indexOf('board.js') > -1 && html.indexOf('board.js') < html.indexOf('view.js'));
});

// waves-row-preview T1~T7
const { waveFixture } = await import('./waves.fixture.mjs');
const fixture = waveFixture();
const fixtureTickets = fixture.projects[0].tickets;
const cardKeys = (html) => [...html.matchAll(/data-n="([^"]+)"/g)].map(m => m[1]);
const fixtureHtml = (state = new Map()) => W.html(fixtureTickets, { ...ui, workspace: fixture.workspace, state });

test('T1/T2: 네 제목과 칸별 미완료 3개·반영 대기·완료 건수를 표시한다', () => {
  const html = fixtureHtml();
  assert.equal((html.match(/class="wrow"/g) || []).length, 4);
  assert.equal(W.layout(fixtureTickets).rows[0].cells[0].length, 29);
  assert.deepEqual(cardKeys(html).filter(k => /^0:n[1-9]$/.test(k)), ['0:n1', '0:n2', '0:n3', '0:n8']);
  assert.match(html, /미완료 7 · 반영 대기 1 · 완료 21/);
  assert.match(html, /남은 4개 더 보기/);
  assert.match(html, /완료 21개 펼치기/);
  assert.ok(!cardKeys(html).includes('0:n9'));
});

test('T3/T4/T5: 해당 칸의 전체 보기와 완료 펼침은 독립이며 다시 접어도 원본과 건수가 같다', () => {
  const before = JSON.stringify(fixture);
  const key = W.choiceKey(fixture.workspace, 'p/first', 0);
  const state = new Map([[key, { more: true }]]);
  assert.ok(cardKeys(fixtureHtml(state)).includes('0:n7'));
  assert.ok(!cardKeys(fixtureHtml(state)).includes('3:n4'), '다른 칸은 여전히 미리보기');
  assert.match(fixtureHtml(state), /다시 접기/);
  state.set(key, { more: true, done: true });
  assert.equal(cardKeys(fixtureHtml(state)).filter(k => /^0:n([1-9]|1[0-9]|2[0-9])$/.test(k)).length, 29);
  assert.match(fixtureHtml(state), /완료 21개 접기/);
  state.set(key, { more: false, done: false });
  assert.equal(fixtureHtml(state), fixtureHtml());
  assert.equal(JSON.stringify(fixture), before);
});

test('T6/T7: 오류 우선·유효 반영 대기만 분류하며 누락과 중복이 없다', () => {
  const nodes = fixtureTickets[2].nodes;
  const groups = W.classify(nodes);
  assert.deepEqual(groups.unfinished.map(n => n.key), ['n1', 'n5']);
  assert.deepEqual(groups.pending.map(n => n.key), ['n2', 'n3']);
  assert.deepEqual(groups.done.map(n => n.key), ['n4']);
  const all = Object.values(groups).flat();
  assert.equal(all.length, nodes.length);
  assert.equal(new Set(all).size, nodes.length);
  assert.equal(W.layout([fixtureTickets[2]]).rows[0].done, 1);
  assert.match(fixtureHtml(), /읽기 실패/);
  assert.match(fixtureHtml(), /미완료 2 · 반영 대기 2 · 완료 1/);
  assert.equal((fixtureHtml().match(/>반영 대기<\/span>/g) || []).length, 3);
});

test('T8/T12: 행 접기는 카드와 내부 버튼을 DOM에서 빼고 건수와 내부 선택을 보존한다', () => {
  const state = new Map();
  const rowKey = W.choiceKey(fixture.workspace, 'p/first', null);
  const cellKey = W.choiceKey(fixture.workspace, 'p/first', 0);
  state.set(cellKey, { more: true, done: true });
  const expanded = fixtureHtml(state);
  state.set(rowKey, { folded: true });
  const folded = fixtureHtml(state);
  assert.ok(!cardKeys(folded).some(k => k.startsWith('0:')));
  assert.ok(cardKeys(folded).some(k => k.startsWith('1:')), '다른 행은 그대로');
  assert.match(folded, /미완료 7 · 반영 대기 1 · 완료 21/);
  assert.match(folded, /data-wave-action="folded" aria-expanded="false"/);
  assert.equal((folded.match(/data-wave-action="done"/g) || []).length, 2, '접힌 행 내부의 완료 버튼은 없다');
  state.set(rowKey, { folded: false });
  assert.equal(fixtureHtml(state), expanded);
});

test('T13: workspace·slug·깊이로 선택을 구분하고 추가·순서 변경에 유지한다', () => {
  const key = W.choiceKey(fixture.workspace, 'p/first', 0);
  const state = new Map([[key, { more: true, done: true }]]);
  const reordered = W.html([fixtureTickets[3], fixtureTickets[0]], { ...ui, workspace: fixture.workspace, state });
  assert.ok(cardKeys(reordered).includes('1:n29'));
  assert.ok(!cardKeys(reordered).includes('0:n4'));
  const otherWorkspace = W.html(fixtureTickets, { ...ui, workspace: 'other', state });
  assert.ok(!cardKeys(otherWorkspace).includes('0:n29'));
  assert.ok(!cardKeys(fixtureHtml(new Map())).includes('0:n29'), '새 페이지 세션은 기본');
  assert.notEqual(W.choiceKey('a', 'x', 1), W.choiceKey('b', 'x', 1));
  assert.notEqual(W.choiceKey('a', 'x', 1), W.choiceKey('a', 'x', 2));
});

test('T10/T11: 미리보기·전체·완료·반영 대기는 기존 카드 속성과 숨긴 사슬을 유지한다', () => {
  const state = new Map([[W.choiceKey(fixture.workspace, 'p/first', 0), { more: true, done: true }]]);
  const html = fixtureHtml(state);
  for (const key of ['n1', 'n4', 'n9', 'n8']) assert.match(html, new RegExp(`data-key="${key}" data-id="WP-${key.slice(1)}" data-tkt="p/first" tabindex="0"`));
  assert.match(html, /data-dec="WP-D1" data-ticket="p\/first"/);
  const preview = fixtureHtml();
  assert.match(preview, /data-n="0:n30" data-up="0:n4"/);
  assert.ok(!cardKeys(preview).includes('0:n4'));
  assert.match(preview, /data-n="1:n30" data-up="1:n3 1:n2 1:n1"/);
});

test('T15: 0~3개 미완료와 완료만 있는 칸 및 빈 칸에는 더 보기가 없다', () => {
  for (let count = 0; count <= 3; count++) {
    const nodes = Array.from({ length: count }, (_, i) => node(`n${i}`));
    const html = W.html([ticket('p/t', nodes), ticket('p/done', [node('done', [], { state: '끝남' })])], ui);
    assert.doesNotMatch(html, /data-wave-action="more"/);
    assert.match(html, /완료 1개 펼치기/);
    assert.equal(cardKeys(html).length, count);
  }
  assert.match(fixtureHtml(), /class="none">빈 칸/);
  assert.doesNotMatch(fixtureHtml(), /data-row="p\/nodeless"/);
});
