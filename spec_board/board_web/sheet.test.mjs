// node --test spec_board/board_web/sheet.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Sheet = require('./sheet.js');
const Flow = require('./flow.js');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const ui = { esc, icon: () => '', look: () => ({ cls: 'x', icon: 'i' }), color: () => 1, workspace: 'a', state: new Map(), today: '2026-10-14' };
const ticket = {
  slug: 'crm', title: 'crm — CRM 발송 현황',
  nodes: [{ key: 'n1', id: 'CRM-1', title: '하나', state: '끝남', deps: [] }, { key: 'n2', id: 'CRM-2', title: '둘', state: '진행', deps: ['n1'] }],
  waves: [{ w: 1, at: '2026-10-13 13:30', nodes: [{ key: 'n1', state: '끝남' }], dur: '', review: 'fix' }],
  rows: [],
};
const model = { workspace: 'a', root: '/x/my-repo', branch: 'worktree/crm', projects: [{ key: '', tickets: [ticket] }] };

test('시트 이름 — "slug — 이름"은 이름, "이름 — 설명"은 이름', () => {
  assert.equal(Sheet.sheetName('crm-delivery-dashboard — CRM 발송 현황 대시보드', 'crm-delivery-dashboard'), 'CRM 발송 현황 대시보드');
  assert.equal(Sheet.sheetName('알림 자동화 캠페인 손보기 — 제외 줄이기', 'crm-campaign-tuneup'), '알림 자동화 캠페인 손보기');
  assert.equal(Sheet.sheetName('', 'spec-관제/결정-시트'), '결정-시트');
});

test('모델에서 만든 시트 목록은 서버 규칙과 같은 묶음이다', () => {
  const s = Sheet.fromModel(model);
  assert.equal(s[0].group, '진행 중');
  assert.deepEqual([s[0].done, s[0].total, s[0].repo], [1, 2, 'my-repo']);
  const done = Sheet.fromModel({ ...model, projects: [{ tickets: [{ ...ticket, nodes: [ticket.nodes[0]] }] }] });
  assert.equal(done[0].group, '끝남', '노드가 다 끝나면 상태 칸과 상관없이 끝남 묶음');
  assert.equal(Sheet.fromModel({ ...model, projects: [{ tickets: [{ slug: 'e', nodes: [], rows: [] }] }] })[0].group, '준비');
});

test('시트 화면: 머리줄·속성 패널, 팝오버와 필터 칩', () => {
  const h = Sheet.page(ticket, model, {}, null, ui);
  assert.match(h, /my-repo › <b>CRM 발송 현황<\/b>/);
  assert.match(h, /data-ticket="crm">spec\.md/);
  assert.match(h, /data-sv-set="view:mine">내 차례<span class="n">0</);
  assert.match(h, /class="rv rv-fix">수정 1/);
  assert.match(h, /worktree\/crm/);
  assert.doesNotMatch(h, /data-pop/, '닫혀 있으면 팝오버 없음');
  assert.match(Sheet.page(ticket, model, {}, 'disp', ui), /class="pop dpop"[\s\S]*data-sv-set="group:none"/);
  assert.match(Sheet.page(ticket, model, {}, 'filter:since', ui), /data-sv-add="since:1">W1/);
  const f = Sheet.page(ticket, model, { filters: [{ k: 'state', v: '진행' }] }, null, ui);
  assert.match(f, /class="fbar"[\s\S]*<span class="v">진행<\/span>[\s\S]*data-sv-del="0"/);
  assert.doesNotMatch(h, /style="/, 'CSP — 인라인 style 없음');
});

test('보기 설정 — 동작 하나씩 반영하고, 저장값에서 모르는 값은 기본으로', () => {
  let p = Sheet.load(null);
  assert.deepEqual(p, { ...Flow.DEFAULTS, props: Flow.DEFAULTS.props, filters: [] });
  p = Sheet.reduce(p, { sv: 'hide' });
  assert.equal(p.done, 'hide');
  assert.equal(Sheet.reduce(p, { sv: 'hide' }).done, 'all', 'H는 끝남 숨김을 켜고 끈다');
  p = Sheet.reduce(p, { set: 'group:state' });
  p = Sheet.reduce(p, { add: 'state:확인 대기' });
  p = Sheet.reduce(p, { add: 'state:확인 대기' });
  assert.deepEqual(p.filters, [{ k: 'state', v: '확인 대기' }], '같은 칩은 한 번만');
  p = Sheet.reduce(p, { prop: 'id' });
  assert.ok(!p.props.includes('id'));
  assert.deepEqual(Sheet.reduce(p, { del: '0' }).filters, []);
  assert.equal(Sheet.reduce(p, { sv: 'done-all' }).done, 'all');
  const back = Sheet.load(JSON.stringify({ group: 'nope', done: 'today', filters: [{ k: 'evil' }, { k: 'human' }], props: ['id', 'x'] }));
  assert.equal(back.group, 'wave');
  assert.equal(back.done, 'today');
  assert.deepEqual(back.filters, [{ k: 'human' }]);
  assert.deepEqual(back.props, ['id']);
  assert.deepEqual(Sheet.load('{깨진').group, 'wave');
});

test('보관한 시트는 사이드바 목록에서 빠지고 보관 개수와 하단 링크가 남는다', () => {
  const sheets = [
    { workspace: 'a', slug: 'x', title: 'x — 열린 시트', group: '진행 중', repo: 'r', done: 1, total: 2, last: '2026-10-13 10:00' },
    { workspace: 'a', slug: 'y', title: 'y — 보관된 시트', group: '진행 중', repo: 'r', done: 0, total: 1, last: '', archived: true },
  ];
  const nav = (l, ic, href, on, tail) => '<a href="' + href + '">' + l + (tail || '') + '</a>';
  const h = Sheet.side(sheets, { workspace: 'a', slug: 'x' }, {}, { esc, icon: () => '', nav, color: () => 1, view: 'sheet' });
  assert.ok(h.includes('열린 시트') && !h.includes('보관된 시트'));
  assert.ok(h.includes('href="#archive"') && h.includes('href="#repos"') && h.includes('<span class="c">1</span>'));
  const a = Sheet.archiveHtml(sheets, { workspace: 'a' }, { esc, color: () => 1 });
  assert.ok(a.includes('보관된 시트') && a.includes('data-arch="a|y|0"') && !a.includes('열린 시트'));
  assert.ok(Sheet.archiveHtml([], {}, { esc, color: () => 1 }).includes('보관한 시트가 없어요'));
  assert.ok(Sheet.page(ticket, model, null, null, ui).includes('data-arch="a|crm|1"'), '시트 화면 머리에 보관 버튼');
});

test('Repos & 서비스 — 서비스 포트·버전과 워크스페이스 줄', () => {
  const h = Sheet.reposHtml({ service: { port: 8790, version: '0.1.0' }, workspaces: [{ workspace: 'a', root: '/x/a', sheets: 3, archived: 1 }] }, { esc, color: () => 1 });
  assert.ok(h.includes('127.0.0.1:8790') && h.includes('v0.1.0') && h.includes('/x/a') && h.includes('href="/w/a/board/"'));
  assert.ok(Sheet.reposHtml(null, { esc, color: () => 1 }).includes('불러오는 중'));
});

test('다른 워크스페이스의 시트 링크는 data-ws를 달아 화면이 페이지를 다시 불러오지 않고 바꾼다', () => {
  const sheets = [
    { workspace: 'a', slug: 'x', title: 'x — 여기', group: '진행 중', repo: 'r', done: 0, total: 1 },
    { workspace: 'b', slug: 'y', title: 'y — 저기', group: '진행 중', repo: 'r2', done: 0, total: 1 },
  ];
  const nav = () => '';
  const h = Sheet.side(sheets, { workspace: 'a', slug: 'x' }, {}, { esc, icon: () => '', nav, color: () => 1, view: 'sheet' });
  assert.ok(h.includes('data-ws="b" data-hash="#s/y"'));
  assert.equal((h.match(/data-ws=/g) || []).length, 1, '같은 워크스페이스 시트는 해시 이동만');
  assert.ok(Sheet.reposHtml({ service: { port: 1 }, workspaces: [{ workspace: 'a', root: '/a', sheets: 1 }] }, { esc, color: () => 1 }).includes('data-ws="a"'));
});
