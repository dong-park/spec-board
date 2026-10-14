// node --test skills/spec/scripts/board_web/view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const V = createRequire(import.meta.url)('./view.js');
const read = (f) => readFileSync(join(here, f), 'utf8');

const node = (over) => ({
  key: 'n1', id: 'IB-1', title: '틀과 카드', state: '아직 안 함', column: '시작 가능',
  deps: [], waiting_on: [], blocked_by_ids: [], warnings: [], error: '', ...over,
});
const STATES = [
  node({ key: 'a', state: '아직 안 함', column: '시작 가능' }),
  node({ key: 'b', state: '아직 안 함', column: '기다림', waiting_on: ['a'] }),
  node({ key: 'c', state: '진행', column: '진행', elapsed: '18m', worker: 'runner#3' }),
  node({ key: 'd', state: '확인 대기', column: '확인 대기', elapsed: '5m', worker: 'runner#2' }),
  node({ key: 'e', state: '막힘', column: '기다림', blocked_by_ids: ['IB-D11', 'IB-D12'], elapsed: '9m', worker: 'runner#1' }),
  node({ key: 'f', state: '보류', column: '기다림', elapsed: '2m', worker: 'runner#4' }),
  node({ key: 'g', state: '끝남', column: '끝남', elapsed: '1h', worker: 'runner#5' }),
];
const MODEL = {
  root: '/Users/me/demo',
  summary: { decisions_open: 2, decisions_blocking: 1, to_check: 1 },
  projects: [
    { key: 'old', title: '옛 프로젝트 — 문제 문장', state: '끝남', tickets: [{ slug: 'old/t', title: 't', counts: { 끝남: 4 }, nodes: [] }] },
    { key: 'glass-wall', title: '유리벽 — 마카로 쓰고 포스트잇을 붙이는 개인 사고판', state: '진행',
      tickets: [{ slug: 'glass-wall/first-wall', title: '첫 벽', counts: { '시작 가능': 1, 끝남: 1 }, nodes: STATES }] },
  ],
};

const classesOf = (html) => [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);

// ── T12: 카드 군더더기 금지
test('카드에는 허용된 조각만 있고 알약·막대·버튼·설명 문장이 0이다', () => {
  const ALLOWED = new Set(['card', 'a', 'tk', 'id', 'rt', 'tm', 'pulse', 'av', 'b', 'st', 't', 'r', 'chip', 'dec', 'dep', 'warn']);
  const withWarn = node({ key: 'w', state: '진행', column: '진행', warnings: [{ code: 'x', text: '경고' }], blocked_by_ids: ['IB-D1'], waiting_on: ['a'] });
  for (const n of [...STATES, withWarn, node({ key: 'x', error: '읽기 실패: KeyError' })]) {
    const html = V.card(n, { ticket: 't', ids: { a: 'IB-1' } });
    for (const c of classesOf(html)) {
      assert.ok(ALLOWED.has(c) || /^(is-|tk-|st-)/.test(c), `${n.key}: 허용 밖 클래스 ${c}`);
    }
    assert.doesNotMatch(html, /<(button|input|textarea|select|progress|p|img)[\s>]/i, `${n.key}: 금지 태그`);
    assert.doesNotMatch(html, /class="[^"]*\b(lb|pill|bar|pg|btn|badge)\b/, `${n.key}: 알약·막대·버튼 클래스`);
  }
});

test('막는 결정은 ◆ 칩 하나다', () => {
  const html = V.card(STATES[4]);
  assert.equal((html.match(/◆/g) || []).length, 1);
  assert.match(html, /◆ IB-D11 \+1/);
});

test('앞 노드 칩은 화면 ID로 나오고 끝난 카드에는 칩이 없다', () => {
  const html = V.card(STATES[1], { ids: { a: 'IB-1' } });
  assert.match(html, /<span class="chip dep"[^>]*>IB-1<\/span>/);
  assert.doesNotMatch(V.card(node({ state: '끝남', column: '끝남', waiting_on: ['a'], blocked_by_ids: ['IB-D1'] })), /chip/);
});

// ── T12: 경과 시간·아바타는 진행만
test('진행이 아닌 카드에는 아바타와 경과 시간이 0이다', () => {
  for (const n of STATES.filter((s) => s.state !== '진행')) {
    const html = V.card(n);
    assert.doesNotMatch(html, /class="av"/, `${n.state}: 아바타`);
    assert.doesNotMatch(html, /class="tm"|pulse/, `${n.state}: 경과 시간`);
  }
  const live = V.card(STATES[2]);
  assert.match(live, /class="av">r</);
  assert.match(live, /18m/);
});

test('읽기 실패 노드는 카드 대신 "읽기 실패" 카드로 나온다', () => {
  const html = V.card(node({ key: 'x', id: 'IB-X', title: '깨진 제목', error: '읽기 실패: KeyError' }));
  assert.match(html, /is-err/);
  assert.match(html, /읽기 실패<\/span>/);
  assert.doesNotMatch(html, /깨진 제목/);
});

test('제목과 ID는 이스케이프된다', () => {
  const html = V.card(node({ title: '<img src=x onerror=alert(1)>', id: '"><b>' }));
  assert.doesNotMatch(html, /<img|<b>/);
  assert.match(html, /&lt;img/);
});

test('같은 티켓은 같은 색 번호이고 1..6 안이다', () => {
  assert.equal(V.ticketColor('glass-wall/first-wall'), V.ticketColor('glass-wall/first-wall'));
  for (const s of ['a', 'b/c', '유리벽', '']) assert.ok([1, 2, 3, 4, 5, 6].includes(V.ticketColor(s)));
});

// ── T9: 사이드바
test('사이드바는 찾기 · Inbox · Decisions · 시트 묶음이고 에이전트·Graph·프로젝트 하위 메뉴가 없다', () => {
  const html = V.sidebar(MODEL, { view: 'inbox' });
  assert.doesNotMatch(html, /에이전트/);
  assert.doesNotMatch(html, /graph/i);
  assert.match(html, /data-sheet-q/);
  for (const label of ['Inbox', 'Decisions']) assert.ok(html.includes(`>${label}<`), label);
  for (const label of ['Projects', 'Tickets', 'Issues', 'Board', 'Waves', 'Preview']) assert.ok(!html.includes(`>${label}<`), label);
  assert.match(html, /진행 중<span class="n">1</);
  assert.match(html, /준비<span class="n">1</);
  assert.match(html, /href="#s\/glass-wall\/first-wall"/);
});

test('시트 줄은 지금 시트를 켜고, 다른 워크스페이스 시트는 그 보드 주소로 간다', () => {
  const sheets = [
    { workspace: 'a', repo: 'demo', slug: 'x', title: 'x — 엑스', group: '진행 중', done: 1, total: 2, blocking: 1, last: '' },
    { workspace: 'b', repo: 'zoo', slug: 'y', title: '와이', group: '준비', done: 0, total: 0, blocking: 0, last: '' },
  ];
  const html = V.sidebar({ workspace: 'a', summary: {} }, { view: 'sheet', sheet: 'x' }, { sheets });
  assert.match(html, /<a class="sr on" href="#s\/x" aria-current="page">/);
  assert.match(html, /href="\/w\/b\/board\/#s\/y"/);
  assert.match(html, />엑스</, '"slug — 이름" 제목은 이름만');
  assert.match(html, /class="badge-dec">◆1</);
  assert.deepEqual(V.parseHash('#s/spec-관제/결정-시트'), { view: 'sheet', project: null, sheet: 'spec-관제/결정-시트' });
});

test('Inbox 개수는 열린 결정 + 확인 대기, 결정 배지는 막는 결정 수다', () => {
  const html = V.sidebar(MODEL, {});
  assert.match(html, /Inbox<\/span><span class="c">3<\/span>/);
  assert.match(html, /Decisions<\/span><span class="badge-dec">1<\/span>/);
  assert.doesNotMatch(V.sidebar({ projects: [], summary: {} }, {}), /badge-dec/);
});

test('빈 모델도 틀은 그려진다', () => {
  assert.match(V.page({}, {}), /<aside class="side/);
  assert.match(V.stage({}, { view: 'inbox' }), /<main class="main/);
});

test('w 없이 받은 가벼운 목록은 보드가 아니라 isBare이고, 열 워크스페이스는 주소 → 티켓이 있는 첫 것 → 첫 것이다', () => {
  const list = [{ workspace: 'a', tickets: 0 }, { workspace: 'b', tickets: 3 }, { workspace: 'c', tickets: 9 }];
  assert.equal(V.isBare({ workspaces: list }), true);
  assert.equal(V.isBare({ workspaces: [{ workspace: 'a', projects: [] }] }), false, '보드가 든 정적 JSON은 아니다');
  assert.equal(V.isBare({ projects: [] }), false);
  assert.equal(V.isBare(null), false);
  assert.equal(V.chooseWorkspace(list, 'c'), 'c', '주소가 가리킨 것');
  assert.equal(V.chooseWorkspace(list, null), 'b', '티켓이 있는 첫 것');
  assert.equal(V.chooseWorkspace(list, 'zz'), 'b');
  assert.equal(V.chooseWorkspace([{ workspace: 'a', tickets: 0 }], null), 'a');
  assert.equal(V.chooseWorkspace([], null), null);
});

test('/api/board가 w 없이 준 {workspaces}에서 모델을 고른다', () => {
  const a = { workspace: 'a', projects: [] }, b = { workspace: 'b', projects: [{ key: 'p' }] };
  assert.equal(V.pick({ workspaces: [a, b] }, null), b, '프로젝트가 있는 첫 것');
  assert.equal(V.pick({ workspaces: [a, b] }, 'a'), a, 'w가 우선');
  assert.equal(V.pick(MODEL, null), MODEL, '단일 모델은 그대로');
  assert.deepEqual(V.pick({ workspaces: [] }, null), {});
});

test('해시는 오가며 같은 값이다', () => {
  assert.deepEqual(V.parseHash(V.hashOf('wave', 'glass-wall')), { view: 'wave', project: 'glass-wall' });
  assert.deepEqual(V.parseHash(V.hashOf('dec')), { view: 'dec', project: null });
  assert.deepEqual(V.parseHash(''), { view: 'inbox', project: null });
});

// ── 테마: 앱 토큰 + accent 두 자리
test('토큰은 앱 라이트·다크 값이고 반지름 18·간격 12다', () => {
  const css = read('tokens.css');
  const dark = css.slice(css.indexOf('prefers-color-scheme: dark'));
  for (const v of ['#ECE9E0', '#FBF9F4', '#3C6E96']) assert.ok(css.includes(v), v);
  for (const v of ['#414138', '#2a2a27', '#f0d48a']) assert.ok(dark.includes(v), v);
  assert.match(css, /--card-radius:\s*18px/);
  assert.match(css, /--card-gap:\s*12px/);
  assert.match(read('index.html'), /color-scheme" content="light dark"/);
});

// 앱의 tokens.css 경로를 BOARD_TOKENS_REF로 주면 값이 같은지 본다 (없으면 건너뜀)
test('앱 tokens.css와 값이 갈라지지 않았다', { skip: !process.env.BOARD_TOKENS_REF || !existsSync(process.env.BOARD_TOKENS_REF) }, () => {
  const ref = readFileSync(process.env.BOARD_TOKENS_REF, 'utf8');
  const mine = read('tokens.css');
  const val = (src, name, from = 0) => {
    const m = src.slice(from).match(new RegExp(`--${name}:\\s*([^;]+);`));
    return m && m[1].trim();
  };
  const refDark = ref.indexOf(':root[data-theme="dark"]');
  const myDark = mine.indexOf('prefers-color-scheme: dark');
  for (const n of ['bg', 'card', 'card-2', 'text-1', 'text-2', 'text-3', 'accent', 'shadow-card', 'card-radius', 'card-gap', 'st-running', 'st-err']) {
    assert.equal(val(mine, n), val(ref, n), `light --${n}`);
  }
  for (const n of ['bg', 'card', 'card-2', 'text-1', 'accent', 'st-running', 'st-err']) {
    assert.equal(val(mine, n, myDark), val(ref, n, refDark), `dark --${n}`);
  }
});

test('accent는 결정 배지와 주 버튼 규칙에서만 읽는다', () => {
  const css = read('board.css');
  const users = [...css.matchAll(/([^{}]+)\{([^{}]*var\(--accent\)[^{}]*)\}/g)].map((m) => m[1].trim());
  assert.deepEqual(users.sort(), ['.badge-dec', '.btn-primary']);
  assert.doesNotMatch(read('view.js'), /accent/);
});

test('카드 면에 테두리가 없다', () => {
  const css = read('board.css');
  assert.match(css, /\.card\s*\{[^}]*border:\s*0/);
  assert.doesNotMatch(css, /border:\s*1px/);
  assert.match(css, /\.card\s*\{[^}]*border-radius:\s*var\(--card-radius\)/);
});

// ── T16: 노드 없는 티켓도 티켓 목록에 머리줄이 있어야 눌러서 '노드로 나누기'에 닿는다
test('티켓 목록은 노드가 없는 티켓도 눌러 열 수 있게 머리줄을 낸다', () => {
  const model = { projects: [{ key: 'p', title: 'P', state: '진행', tickets: [
    { slug: 'p/with', title: '노드 있는 티켓', nodes: [{ key: 'n1', id: 'W-1', title: 'a', state: '아직 안 함' }] },
    { slug: 'p/bare', title: '노드 없는 티켓', nodes: [] },
  ] }] };
  const html = V.stage(model, { view: 'tickets', project: 'p' });
  assert.match(html, /data-ticket="p\/with"/);
  assert.match(html, /data-ticket="p\/bare"/);
  assert.match(html, /노드 없음/);
});

// ── 영문 표기: 사이드바·crumb에 한국어 라벨이 없다 (본문 데이터만 한국어)
const textOf = (html) => html.replace(/<[^>]*>/g, ' ');

test('끝난 시트는 접혀 있고 펴면 보이며, 찾기 글자로 거른다', () => {
  const s = (slug, group, title) => ({ workspace: 'a', repo: 'r', slug, title, group, done: 0, total: 0, blocking: 0, last: '' });
  const sheets = [s('z', '끝남', '옛 일'), s('x', '진행 중', '알림 캠페인'), s('w', '준비', '결정 시트')];
  const closed = V.sidebar({ workspace: 'a' }, {}, { sheets });
  assert.match(closed, /data-sheet-fold aria-expanded="false"/);
  assert.doesNotMatch(closed, /href="#s\/z"/);
  assert.match(V.sidebar({ workspace: 'a' }, {}, { sheets, doneOpen: true }), /href="#s\/z"/);
  const found = V.sidebar({ workspace: 'a' }, {}, { sheets, q: '알림' });
  assert.match(found, /href="#s\/x"/);
  assert.doesNotMatch(found, /href="#s\/w"/);
  assert.match(found, /value="알림"/);
});

test('crumb는 영문 화면 이름이고 프로젝트는 슬러그다', () => {
  const crumb = (nav) => V.stage(MODEL, nav).match(/<div class="crumb">(.*?)<\/div>/s)[1];
  assert.equal(crumb({ view: 'dec' }), '<b>Decisions</b>');
  assert.equal(crumb({ view: 'tickets', project: 'glass-wall' }), 'glass-wall › <b>Tickets</b>');
  assert.equal(crumb({ view: 'project', project: 'glass-wall' }), 'glass-wall › <b>Overview</b>');
});

test('슬러그가 한국어인 줄기는 폴더 이름 그대로 쓴다', () => {
  assert.equal(V.slugOf({ key: 'spec-관제', title: '스펙 관제' }), 'spec-관제');
  assert.equal(V.slugOf({ key: 'a/b' }), 'b');
  assert.equal(V.slugOf({ key: '' }), 'No project');
});

// ── 프로젝트 줄 → 종합 화면
test('프로젝트 해시는 그대로 읽힌다 — 사이드바에 줄은 없어도 주소로는 연다', () => {
  assert.deepEqual(V.parseHash('#glass-wall/project'), { view: 'project', project: 'glass-wall' });
  assert.equal(V.hashOf('project', 'glass-wall'), '#glass-wall/project');
});

test('한국어 슬러그 해시는 브라우저가 퍼센트 인코딩해도 같은 프로젝트로 읽힌다', () => {
  const enc = '#' + encodeURIComponent('spec-관제') + '/project';
  assert.deepEqual(V.parseHash(enc), { view: 'project', project: 'spec-관제' });
  assert.deepEqual(V.parseHash('#bad%E0%A4%A/project'), { view: 'project', project: 'bad%E0%A4%A' }, '깨진 인코딩은 그대로');
});

test('시트 화면은 머리줄·흐름 탭·끝남 숨김·필터·보기와 속성 패널을 갖고, 없는 시트는 안내만 낸다', () => {
  const model = { ...MODEL, workspace: 'a' };
  const html = V.stage(model, { view: 'sheet', sheet: 'glass-wall/first-wall' }, {});
  for (const k of ['data-sv="hide"', 'data-sv="filter"', 'data-sv="disp"', 'class="props"', 'data-ticket="glass-wall/first-wall"']) assert.ok(html.includes(k), k);
  assert.match(V.stage(model, { view: 'sheet', sheet: 'nope' }, {}), /이 시트를 못 찾았어요/);
});

const OVERVIEW_MODEL = {
  root: '/Users/me/demo',
  projects: [{
    key: 'glass-wall', title: '유리벽 — 마카로 쓰고 포스트잇을 붙이는 개인 사고판', state: '진행',
    problem: '손으로 쓰고 붙일 개인용 벽이 없다', outcome: '보드를 열면 그 자체가 유리벽이다',
    tickets: [
      { slug: 'glass-wall/later', title: '나중 티켓 — 문제', priority: 'P2', state: '진행', scenarios: { total: 4, passed: 0 }, counts: {},
        nodes: [node({ key: 'n1', id: 'LT-1', title: '시작할 노드' })] },
      { slug: 'glass-wall/first-wall', title: '첫 벽 — 문제', priority: 'P0', state: '진행', scenarios: { total: 6, passed: 3 }, counts: {},
        // 결정은 티켓 rows에만 있다 — 화면이 Dec.list(model)로 모은다 (서버는 복제본을 안 준다)
        rows: [
          { id: 'D1', kind: 'decision', display_id: 'FW-D1', title: '벽 배경을 정한다', open: true, reversible: false, user: { answer: '' }, options: [], blocked_node_ids: ['FW-2'] },
          { id: 'D2', kind: 'decision', display_id: 'FW-D2', title: '이미 끝난 결정', open: false, reversible: true, user: { answer: '' }, options: [] },
        ],
        nodes: [
          node({ key: 'n1', id: 'FW-1', title: '끝난 노드', state: '끝남', column: '끝남' }),
          node({ key: 'n2', id: 'FW-2', title: '막힌 노드', state: '막힘', column: '기다림', blocked_by_ids: ['FW-D1'] }),
          node({ key: 'n3', id: 'FW-3', title: '눈으로 볼 노드', state: '확인 대기', column: '확인 대기' }),
          node({ key: 'n4', id: 'FW-4', title: '이미 통과한 노드', state: '확인 대기', column: '확인 대기', verdict: '통과' }),
        ] },
      { slug: 'glass-wall/nodeless', title: '노드 없는 티켓', priority: '', state: '진행', scenarios: { total: 0, passed: 0 }, counts: {}, nodes: [] },
    ],
  }, {
    key: 'other', title: '다른 프로젝트 — 문제', state: '진행',
    tickets: [{ slug: 'other/t', title: '다른 티켓', priority: '', state: '진행', scenarios: { total: 0, passed: 0 }, counts: {}, nodes: [],
      rows: [{ id: 'D9', kind: 'decision', display_id: 'XX-D9', title: '다른 프로젝트의 결정', open: true, reversible: false, user: { answer: '' }, options: [] }] }],
  }],
};
const overview = () => V.stage(OVERVIEW_MODEL, { view: 'project', project: 'glass-wall' });

test('종합 화면 머리는 한국어 이름과 슬러그, 문제·끝난 모습 한 줄이다', () => {
  const html = overview();
  assert.match(html, /<h1>유리벽<span class="slug">glass-wall<\/span><\/h1>/);
  assert.match(html, /<span class="k">문제<\/span><span class="v">손으로 쓰고 붙일 개인용 벽이 없다<\/span>/);
  assert.match(html, /<span class="k">끝난 모습<\/span><span class="v">보드를 열면 그 자체가 유리벽이다<\/span>/);
  const bare = V.stage({ projects: [{ key: 'p', title: 'P', tickets: [] }] }, { view: 'project', project: 'p' });
  assert.doesNotMatch(bare, /끝난 모습|class="ovl"/, '값이 없으면 줄을 안 그린다');
});

test('종합 화면 진행은 노드 끝남/전체와 시나리오 통과/전체 합계다', () => {
  const html = overview();
  // 노드 6개 중 끝남은 FW-1과, 통과를 눌러 칸이 끝남으로 옮겨 보이는 FW-4 둘이다 (Board와 같은 정의)
  assert.match(html, /data-k="nodes">노드 <b>2 \/ 5<\/b>/);
  assert.match(html, /data-k="scn">시나리오 <b>3 \/ 10<\/b> 통과/);
  assert.match(html, /data-pct="40"/);
  assert.match(html, /<div class="bar"><i><\/i><\/div>/, '너비는 인라인 style이 아니라 data-pct를 읽어 paint가 칠한다');
});

// ── CSP: 인라인 스크립트·style 속성이 없다 (default-src 'self')
test('화면 어느 조각에도 인라인 style 속성이 없다', () => {
  for (const html of [
    V.stage(OVERVIEW_MODEL, { view: 'project', project: 'glass-wall' }),
    V.stage(OVERVIEW_MODEL, { view: 'board', project: 'glass-wall' }),
    V.stage(OVERVIEW_MODEL, { view: 'waves', project: 'glass-wall' }),
    V.sprite(),
  ]) assert.doesNotMatch(html, /\sstyle\s*=/i);
});

test('index.html은 인라인 스크립트를 두지 않고 boot.js를 부른다', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, '인라인 <script> 없음');
  assert.doesNotMatch(html, /\sstyle\s*=|\son[a-z]+\s*=/i, '인라인 style·이벤트 속성 없음');
  assert.match(html, /<script src="boot\.js"><\/script>/);
  assert.match(read('boot.js'), /BoardView\.mount/);
});

test('paint는 data-pct·data-waves를 CSSOM으로 칠한다', () => {
  const made = (attr, own = {}) => ({ style: { props: {}, setProperty(k, v) { this.props[k] = v; } }, getAttribute: (k) => attr[k], ...own });
  const grid = made({ 'data-waves': '4' });
  const host = made({ 'data-pct': '40' });
  const bar = { style: {}, closest: () => host };
  const root = { querySelectorAll: (sel) => (sel === '.wgrid[data-waves]' ? [grid] : sel === '.ovp[data-pct] .bar i' ? [bar] : []) };
  V.paint(root);
  assert.equal(grid.style.props['--waves'], '4');
  assert.equal(bar.style.width, '40%');
});

test('?src=는 같은 주소의 경로만 받는다', () => {
  const fb = '/api/board?w=x';
  assert.equal(V.safeSrc('/api/board?w=demo', fb), '/api/board?w=demo');
  assert.equal(V.safeSrc('/w/demo/api/board', fb), '/w/demo/api/board');
  for (const bad of ['https://evil.example/x.json', 'http://127.0.0.1/x', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)',
    'data:text/json,{}', 'x.json', '', '/a b', null, undefined]) assert.equal(V.safeSrc(bad, fb), fb, String(bad));
});

test('요약 칩 넷은 Board와 같은 숫자다', () => {
  const html = overview();
  const board = V.stage(OVERVIEW_MODEL, { view: 'board', project: 'glass-wall' });
  const chips = (h) => h.match(/<div class="wtop">.*?<\/div>/s)[0];
  assert.equal(chips(html), chips(board));
  assert.equal((chips(html).match(/class="kpi /g) || []).length, 4);
});

test('막는 결정은 이 프로젝트의 노드를 막는 결정만 나오고 누르면 결정 모달 속성을 가진다', () => {
  const html = overview();
  const sec = html.match(/<section class="ovs" data-sec="blocking">.*?<\/section>/s)[0];
  assert.match(sec, /data-dec="FW-D1" data-ticket="glass-wall\/first-wall"/);
  assert.match(sec, /벽 배경을 정한다/);
  assert.doesNotMatch(sec, /FW-D2|XX-D9/, '끝난 결정·다른 프로젝트 결정은 없다');
  assert.match(sec, /class="n">1</);
});

test('확인 대기 노드는 카드로 나오고 통과를 눌러 칸이 옮겨진 노드는 빠진다', () => {
  const html = overview();
  const sec = html.match(/<section class="ovs" data-sec="check">.*?<\/section>/s)[0];
  assert.match(sec, /data-key="n3"[^>]*data-id="FW-3"[^>]*data-tkt="glass-wall\/first-wall"/);
  assert.doesNotMatch(sec, /FW-4/);
  assert.doesNotMatch(sec, /data-key="n2"/);
});

test('티켓 줄은 우선순위 순이고 이름·노드 x/y·막는 결정 수를 갖고 누르면 티켓 모달 속성을 가진다', () => {
  const html = overview();
  const sec = html.match(/<section class="ovs" data-sec="tickets">.*<\/section>/s)[0];
  const order = [...sec.matchAll(/class="trow[^"]*" data-ticket="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['glass-wall/first-wall', 'glass-wall/later', 'glass-wall/nodeless'], 'P0 → P2 → 우선순위 없음');
  const first = sec.match(/<button[^>]*data-ticket="glass-wall\/first-wall".*?<\/button>/s)[0];
  assert.match(first, /<span class="tp">P0<\/span>/);
  assert.match(first, /<span class="tn">첫 벽<\/span>/);
  assert.match(first, /<span class="tc"[^>]*>2 \/ 4<\/span>/);
  assert.match(first, /◆ 1/);
  assert.doesNotMatch(sec.match(/<button[^>]*data-ticket="glass-wall\/later".*?<\/button>/s)[0], /◆/, '막는 결정이 없으면 칩이 없다');
  assert.match(sec, /data-ticket="glass-wall\/nodeless"/, '노드 없는 티켓도 줄이 있다');
});

test('종합 화면에는 군더더기가 없다 — 비어 있는 섹션과 안내 문구가 없다', () => {
  const html = V.stage({ decisions: [], projects: [{ key: 'p', title: 'P — 문제', problem: '', tickets: [
    { slug: 'p/t', title: 'T', nodes: [node({ key: 'n1', id: 'T-1', state: '끝남', column: '끝남' })], scenarios: { total: 0, passed: 0 } },
  ] }] }, { view: 'project', project: 'p' });
  assert.doesNotMatch(html, /data-sec="blocking"|data-sec="check"/);
  assert.match(html, /data-sec="tickets"/);
  assert.doesNotMatch(html, /<(img|textarea|input|select)[\s>]/i);
});

test('프로젝트를 못 찾은 종합 해시는 티켓 목록으로 떨어진다', () => {
  const html = V.stage(OVERVIEW_MODEL, { view: 'project', project: 'nope' });
  assert.match(html, /<b>Tickets<\/b>/);
  assert.doesNotMatch(html, /class="ov"/);
});

test('종합 화면 줄 문구는 이스케이프된다', () => {
  const m = { decisions: [], projects: [{ key: 'p', title: '<b>x</b> — y', problem: '<script>1</script>', outcome: '', tickets: [] }] };
  const html = V.stage(m, { view: 'project', project: 'p' });
  assert.doesNotMatch(html, /<script|<b>x/);
});

test('Waves 화면은 동일 세션 선택을 전달하고 workspace별로 분리한다', () => {
  const ns = Array.from({ length: 5 }, (_, i) => node({ key: `n${i}`, id: `T-${i}` }));
  const model = { workspace: 'a', projects: [{ key: 'p', tickets: [{ slug: 'p/t', title: 'T', nodes: ns }] }] };
  const state = new Map([[JSON.stringify(['a', 'p/t', 0]), { more: true }]]);
  const nav = { view: 'wave' };
  assert.match(V.stage(model, nav, { waves: state }), /data-key="n4"/);
  assert.doesNotMatch(V.stage({ ...model, workspace: 'b' }, nav, { waves: state }), /data-key="n4"/);
  state.set(JSON.stringify(['a', 'p/t', null]), { folded: true });
  assert.doesNotMatch(V.stage(model, nav, { waves: state }), /<article/);
  assert.match(V.stage(model, nav, { waves: state }), /미완료 5/);
});

// mount의 실제 갱신 경로를 최소 DOM과 fetch 경계로 실행한다.
const { runInNewContext } = await import('node:vm');
const { waveFixture } = await import('./waves.fixture.mjs');
async function mountedWaves() {
  const events = {}, offline = new Set();
  let response = waveFixture(), failure = '';
  let html = '', view = { scrollTop: 0, scrollLeft: 0 }, side = { scrollTop: 0 }, buttons = [];
  const el = {
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value; view = { scrollTop: 0, scrollLeft: 0 }; side = { scrollTop: 0 };
      context.document.activeElement = null;
      buttons = [...value.matchAll(/data-wave-choice="([^"]+)" data-wave-action="([^"]+)"/g)].map(([, key, action]) => ({
        dataset: { waveChoice: key.replaceAll('&quot;', '"').replaceAll('&amp;', '&'), waveAction: action },
        focus() { context.document.activeElement = this; },
      }));
    },
    querySelector: s => s === '.view' ? view : s === '.side' ? side : null,
    querySelectorAll: s => s === '[data-wave-choice]' ? buttons : [],
    contains: a => buttons.includes(a),
    addEventListener: (name, fn) => (events[name] ||= []).push(fn),
  };
  const context = {
    BoardCols: createRequire(import.meta.url)('./board.js'), BoardWaves: createRequire(import.meta.url)('./waves.js'),
    BoardVerdict: createRequire(import.meta.url)('./verdict.js'), URLSearchParams,
    BoardFlow: createRequire(import.meta.url)('./flow.js'), BoardSheet: createRequire(import.meta.url)('./sheet.js'),
    location: { search: '', pathname: '/w/wave-fixture/board/', hash: '#wave' },
    window: { addEventListener() {} },
    document: { activeElement: null, visibilityState: 'visible', addEventListener() {}, createElement: () => ({ addEventListener() {} }), body: { appendChild() {}, classList: { toggle: (c, on) => on ? offline.add(c) : offline.delete(c) } } },
    setInterval: fn => { context.tick = fn; },
    fetch: async url => {
      const version = url.includes('/api/version');
      if (failure === (version ? 'version' : 'board')) throw new Error('synthetic offline');
      return { ok: true, json: async () => version ? { v: response.v } : response };
    },
  };
  context.self = context;
  runInNewContext(read('view.js'), context);
  const board = await context.BoardView.mount(el);
  return { el, board, offline, set: (model, fail = '') => { response = model; failure = fail; },
    tick: async () => { context.tick(); await new Promise(setImmediate); },
    active: () => context.document.activeElement,
    focus: (slug, wave, action) => buttons.find(b => b.dataset.waveChoice === JSON.stringify(['wave-fixture', slug, wave]) && b.dataset.waveAction === action).focus(),
    choose: (slug, wave, action) => {
      const dataset = { waveChoice: JSON.stringify(['wave-fixture', slug, wave]), waveAction: action };
      for (const fn of events.click) fn({ target: { closest: s => s === '[data-wave-choice]' ? { dataset } : null } });
    } };
}

test('T13: mount 자동 갱신은 변경 건수·행별 선택·두 축 스크롤을 보존한다', async () => {
  const m = await mountedWaves();
  m.choose('p/first', 0, 'more');
  m.choose('p/long', null, 'folded');
  m.el.querySelector('.view').scrollTop = 120;
  m.el.querySelector('.view').scrollLeft = 360;
  const next = waveFixture(); next.v = '2'; next.projects[0].tickets.reverse();
  next.projects[0].tickets.find(t => t.slug === 'p/first').nodes[6].state = '끝남';
  m.set(next); await m.tick();
  assert.equal(m.board.getModel(), next);
  assert.match(m.el.innerHTML, /미완료 6 · 반영 대기 1 · 완료 22/);
  assert.match(m.el.innerHTML, /data-key="n6"/);
  assert.match(m.el.innerHTML, /data-wave-action="folded" aria-expanded="false"/);
  assert.equal(m.el.querySelector('.view').scrollTop, 120);
  assert.equal(m.el.querySelector('.view').scrollLeft, 360);
});

test('자동 갱신으로 제목 순서가 바뀌어도 읽던 웨이브 버튼의 키보드 포커스를 복원한다', async () => {
  const m = await mountedWaves();
  m.choose('p/first', 0, 'more');
  m.focus('p/first', 0, 'more');
  const before = m.active();
  const next = waveFixture(); next.v = '2'; next.projects[0].tickets.reverse();
  m.set(next); await m.tick();
  assert.ok(m.active(), '다시 그린 뒤에도 버튼에 포커스가 있다');
  assert.notEqual(m.active(), before, '새 DOM의 버튼으로 복원한다');
  assert.deepEqual(m.active().dataset, before.dataset, '제목·깊이·조작 종류로 같은 버튼을 찾는다');
});

test('T14: mount는 버전·보드 읽기 실패 후 마지막 데이터와 선택을 보존하고 회복한다', async () => {
  const m = await mountedWaves();
  m.choose('p/first', 0, 'more');
  const oldModel = m.board.getModel(), oldHtml = m.el.innerHTML;
  for (const failure of ['version', 'board']) {
    const next = waveFixture(); next.v = '2';
    m.set(next, failure); await m.tick();
    assert.equal(m.board.getModel(), oldModel);
    assert.equal(m.el.innerHTML, oldHtml);
    assert.ok(m.offline.has('is-offline'));
  }
  const recovered = waveFixture(); recovered.v = '3';
  m.set(recovered); await m.tick();
  assert.equal(m.board.getModel(), recovered);
  assert.match(m.el.innerHTML, /data-key="n7"/);
  assert.ok(!m.offline.has('is-offline'));
});
