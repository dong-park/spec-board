// node --test skills/spec/scripts/board_web/node_modal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const M = req('./node_modal.js');
const Verdict = req('./verdict.js');
const View = req('./view.js');
const read = (f) => readFileSync(join(here, f), 'utf8');

const node = (over) => ({
  key: 'n1', id: 'IB-1', title: '틀과 카드', problem: '화면이 파일을 직접 읽는다.', state: '아직 안 함', column: '시작 가능',
  rows: ['T1'], deps: [], waiting_on: [], blocked_by_ids: [], warnings: [], error: '', verdict: '', fix: '', evidence: [], ...over,
});
const fixture = () => {
  const nodes = [
    node({ key: 'n1', id: 'IB-1', title: '선행 노드', state: '끝남', column: '끝남', rows: ['T1'] }),
    node({ key: 'n2', id: 'IB-2', title: '확인할 노드', state: '확인 대기', column: '확인 대기', rows: ['T2', 'T3'], deps: ['n1'], evidence: ['modal.png'] }),
    node({ key: 'n3', id: 'IB-3', title: '뒤 노드', state: '아직 안 함', column: '기다림', deps: ['n2'], waiting_on: ['n2'], rows: [] }),
  ];
  const rows = [
    { id: 'T1', display_id: 'IB-T1', kind: 'task', title: '첫 시나리오', passed: true },
    { id: 'T2', display_id: 'IB-T2', kind: 'task', title: '둘째 시나리오', passed: false },
    { id: 'T3', display_id: 'IB-T3', kind: 'task', title: '셋째 시나리오', passed: false },
  ];
  return { workspace: 'demo', local: true, sessions: true, projects: [{ key: 'p', title: 'p', state: '진행', tickets: [{ slug: 'p/t', title: 't', nodes, rows }] }] };
};
const nodeOf = (model, key) => model.projects[0].tickets[0].nodes.find((n) => n.key === key);

// fetch 대역 — 부른 요청을 기록하고 정해 둔 응답을 돌려준다
function fakeFetch(reply) {
  const calls = [];
  const f = async (path, init = {}) => {
    calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const r = typeof reply === 'function' ? reply(path, init) : reply;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  f.calls = calls;
  return f;
}
function ctl(model, reply) {
  const fetch = fakeFetch(reply || { status: 200, body: { ok: true, user: { verdict: '통과', fix: '' } } });
  const renders = [];
  let redraws = 0;
  const c = M.controller({ fetch, getModel: () => model, redraw: () => { redraws += 1; }, render: (h) => renders.push(h), color: () => 3 });
  return { c, fetch, renders, redraws: () => redraws, last: () => renders[renders.length - 1] };
}
const acts = (html) => [...html.matchAll(/data-nm="([a-z]+)"/g)].map((m) => m[1]).filter((a) => a !== 'close' && a !== 'zoom'); // zoom은 근거 썸네일

// ── T15: 상태별 버튼 집합
const SETS = [
  ['시작 가능', node({ state: '아직 안 함', column: '시작 가능' }), []],   // 시작은 채팅의 /go (D-R2)
  ['진행', node({ state: '진행', column: '진행' }), []],
  ['확인 대기', node({ state: '확인 대기', column: '확인 대기' }), ['fix', 'pass']],
  ['끝남', node({ state: '끝남', column: '끝남' }), ['commits']],
];

test('상태 넷의 버튼 집합은 표와 같고 다른 상태의 버튼은 안 보인다', () => {
  assert.equal(M.VERBS.run, undefined, 'runner 띄우기 버튼은 없다');
  assert.equal(M.VERBS.stop, undefined, '멈춤 버튼은 없다');
  for (const [name, n, want] of SETS) {
    assert.deepEqual(M.actions(n, { local: true, sessions: true }), want, name);
    assert.deepEqual(acts(M.dialog(n, { ticket: { nodes: [n], rows: [] }, local: true, sessions: true })), want, `${name} 모달`);
  }
});

test('막힘·보류·기다림·읽기 실패 노드에는 버튼이 없다', () => {
  for (const n of [node({ state: '막힘', column: '기다림' }), node({ state: '보류', column: '기다림' }),
    node({ state: '아직 안 함', column: '기다림', waiting_on: ['x'] }), node({ error: '읽기 실패' })]) {
    assert.deepEqual(M.actions(n, { local: true, sessions: true }), [], n.state);
    assert.deepEqual(acts(M.dialog(n, { ticket: {}, local: true, sessions: true })), []);
  }
});

test('시작 가능 노드의 모달에는 실행 버튼도 안내 칩도 없다', () => {
  const html = M.dialog(SETS[0][1], { ticket: {}, local: true, sessions: true });
  assert.doesNotMatch(html, /data-nm="(run|stop|open)"/);
  assert.doesNotMatch(html, /runner|\/go/);
  assert.deepEqual(acts(html), []);
});

test('모달은 왜 했나·정한 것·Given/When/Then·그림·완료 기준을 보이고 앞뒤 노드·번호는 보이지 않는다', () => {
  const m = fixture();
  const tk = m.projects[0].tickets[0];
  const n2 = nodeOf(m, 'n2');
  n2.why = ['인덱스가 없다', '상한이 없다'];
  n2.criteria = [{ text: '테스트가 통과한다', done: true }, { text: '메모를 남긴다', done: false }];
  tk.rows[1] = { ...tk.rows[1], given: '회원이 알림을 받았다', when: 'CS가 내역을 연다', then: '행이 보인다' };
  tk.rows.push({ id: 'D7', display_id: 'IB-D7', kind: 'decision', title: '인덱스를 추가할까', open: false, blocked_nodes: ['n2'],
    options: [{ key: 'A', label: '인덱스를 추가한다' }, { key: 'B', label: '두고 본다' }], recommend: 'A', user: { answer: '', fix: '' }, log: ['D7 → A (추천대로)'] });
  const html = M.dialog(n2, { ticket: tk, workspace: 'demo', ui: {} });
  assert.match(html, /왜 했나[\s\S]*인덱스가 없다[\s\S]*상한이 없다/);
  assert.match(html, /정한 것[\s\S]*인덱스를 추가할까[\s\S]*<p class="nm-a">인덱스를 추가한다<\/p>/);
  assert.doesNotMatch(html, /두고 본다/, '안 고른 선택지와 선택지 글자는 보이지 않는다');
  assert.doesNotMatch(html, /IB-D7|>A</);
  assert.match(html, /Given<\/dt><dd>회원이 알림을 받았다[\s\S]*When<\/dt><dd>CS가 내역을 연다[\s\S]*Then<\/dt><dd>행이 보인다/);
  assert.match(html, /<span>modal<\/span>/, '그림은 확장자 없는 이름으로');
  assert.match(html, /완료: <\/span>테스트가 통과한다[\s\S]*아직: <\/span>메모를 남긴다/);
  assert.doesNotMatch(html, /먼저 끝나야 함|담당 시나리오|IB-1|IB-3/, '앞뒤 노드와 시나리오 번호 줄은 없다');
});

test('결정의 고른 답 — 답 칸 > 로그의 "→ 글자" > 추천 순이고, 직접 쓴 답은 그대로 보인다', () => {
  const dec = (over) => ({ id: 'D', kind: 'decision', title: '질문', open: false, blocked_nodes: ['n2'],
    options: [{ key: 'A', label: '가' }, { key: 'B', label: '나' }], recommend: 'A', user: { answer: '', fix: '' }, log: [], ...over });
  const text = (d) => { const m = fixture(); const tk = m.projects[0].tickets[0]; tk.rows.push(d);
    return (M.dialog(nodeOf(m, 'n2'), { ticket: tk, ui: {} }).match(/<p class="nm-a">([^<]*)<\/p>/) || [])[1]; };
  assert.equal(text(dec({ user: { answer: 'B', fix: '' }, log: ['D → A'] })), '나');
  assert.equal(text(dec({ log: ['D → A (추천)', 'D → B (사용자)'] })), '나');
  assert.equal(text(dec({})), '가');
  assert.equal(text(dec({ user: { answer: '둘 다 안 한다', fix: '' } })), '둘 다 안 한다');
  assert.equal(text(dec({ open: true })), undefined, '아직 열린 결정은 정한 것이 아니다');
});

test('완료 기준 — 체크가 하나도 없는 끝남 노드는 빈 상자 대신 목록만 보인다', () => {
  const m = fixture();
  const n = { ...nodeOf(m, 'n1'), criteria: [{ text: '가', done: false }, { text: '나', done: false }] };
  const none = M.dialog(n, { ticket: m.projects[0].tickets[0], ui: {} });
  assert.match(none, /완료 기준[\s\S]*<ul class="nm-plain"><li class="nm-ln">(<button[^>]*>\+<\/button>)?가<\/li><li class="nm-ln">(<button[^>]*>\+<\/button>)?나<\/li>/);
  assert.doesNotMatch(none, /nm-bx/);
  const some = M.dialog({ ...n, criteria: [{ text: '가', done: true }, { text: '나', done: false }] }, { ticket: m.projects[0].tickets[0], ui: {} });
  assert.match(some, /nm-bx/);
  const open = M.dialog({ ...n, state: '진행' }, { ticket: m.projects[0].tickets[0], ui: {} });
  assert.match(open, /nm-bx/, '끝나지 않은 노드는 미체크가 곧 아직이다');
});

test('그림은 끝난 노드에도 보인다', () => {
  const m = fixture();
  const n = { ...nodeOf(m, 'n1'), evidence: ['a.png'] };
  assert.match(M.dialog(n, { ticket: m.projects[0].tickets[0], workspace: 'w', ui: {} }), /data-nm="zoom"/);
});


test('모달은 제목·고쳐줘 문장을 이스케이프하고 다른 모달의 속성을 쓰지 않는다', () => {
  const n = node({ state: '확인 대기', column: '확인 대기', title: '<img onerror=x>', verdict: '고쳐줘', fix: '<script>1</script>' });
  const html = M.dialog(n, { ticket: { nodes: [n], rows: [] }, local: true, sessions: true });
  assert.doesNotMatch(html, /<img|<script/);
  assert.doesNotMatch(html, /data-act=|data-ticket=|data-dec=/);
});

// ── T18: 고쳐줘와 취소
test('고쳐줘를 눌러 쓰다가 취소하면 요청이 0이고 아무것도 안 바뀐다', async () => {
  const m = fixture();
  const { c, fetch, last } = ctl(m);
  c.open('p/t', 'n2');
  await c.dispatch('fix');
  assert.deepEqual(acts(last()), ['send', 'cancel']);
  c.setDraft('여기 간격이 좁아요');
  await c.dispatch('cancel');
  assert.equal(fetch.calls.length, 0);
  const n = nodeOf(m, 'n2');
  assert.equal(n.verdict, '');
  assert.equal(n.fix, '');
  assert.deepEqual(acts(last()), ['fix', 'pass']);
  assert.equal(Verdict.effective(n).column, '확인 대기', '카드는 확인 대기에 그대로 있다');
});

test('고쳐줘를 보내면 user.verdict·fix를 쓰고 카드는 진행으로, 모달에 그 한 줄이 보인다', async () => {
  const m = fixture();
  const { c, fetch, last, redraws } = ctl(m, { status: 200, body: { ok: true, user: { verdict: '고쳐줘', fix: '간격을 넓혀 주세요' } } });
  c.open('p/t', 'n2');
  await c.dispatch('fix');
  c.setDraft('  간격을 넓혀 주세요 ');
  await c.dispatch('send');
  assert.equal(fetch.calls.length, 1);
  const call = fetch.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/w/demo/api/node');
  assert.deepEqual(call.body, { sheet: 'p/t', id: 'n2', user: { verdict: '고쳐줘', fix: '간격을 넓혀 주세요' }, base: { verdict: '', fix: '' } });
  const n = nodeOf(m, 'n2');
  assert.deepEqual([n.state, n.verdict, n.fix], ['확인 대기', '고쳐줘', '간격을 넓혀 주세요'], '상태 칸은 안 건드린다');
  assert.equal(Verdict.effective(n).column, '진행');
  assert.match(View.card(n, { ticket: 'p/t' }), /is-prog/);
  assert.match(last(), /data-nm-fix[^>]*>간격을 넓혀 주세요/);
  assert.equal(redraws(), 1);
});

test('한 줄이 비어 있으면 보내지 않는다', async () => {
  const m = fixture();
  const { c, fetch, last } = ctl(m);
  c.open('p/t', 'n2');
  await c.dispatch('fix');
  c.setDraft('   ');
  await c.dispatch('send');
  assert.equal(fetch.calls.length, 0);
  assert.match(last(), /role="alert"/);
});

// ── T17: 통과
test('통과는 verdict만 쓰고 카드는 확인 대기에서 사라져 반영 대기로 보인다', async () => {
  const m = fixture();
  const { c, fetch, last } = ctl(m);
  c.open('p/t', 'n2');
  await c.dispatch('pass');
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(fetch.calls[0].body.user, { verdict: '통과' });
  const n = nodeOf(m, 'n2');
  assert.equal(n.state, '확인 대기', '상태 칸은 에이전트가 쓴다');
  assert.deepEqual(Verdict.effective(n), { state: '끝남', column: '끝남', pending: '통과' });
  assert.match(View.card(n, { ticket: 'p/t' }), /반영 대기/);
  assert.match(last(), /role="status"/);
});

test('확인 대기가 아닌 노드에서는 통과·고쳐줘가 요청을 만들지 않는다', async () => {
  const m = fixture();
  const { c, fetch } = ctl(m);
  c.open('p/t', 'n1'); // 끝남
  await c.dispatch('pass');
  await c.dispatch('fix');
  c.open('p/t', 'n3'); // 기다림
  await c.dispatch('pass');
  assert.equal(fetch.calls.length, 0);
});

test('다른 곳에서 먼저 바꿨으면 409의 지금 값으로 다시 보여 준다', async () => {
  const m = fixture();
  const { c, last } = ctl(m, { status: 409, body: { error: 'conflict', user: { verdict: '고쳐줘', fix: '폰에서 먼저 적음' } } });
  c.open('p/t', 'n2');
  await c.dispatch('pass');
  const n = nodeOf(m, 'n2');
  assert.deepEqual([n.verdict, n.fix], ['고쳐줘', '폰에서 먼저 적음']);
  assert.match(last(), /다른 곳에서 먼저 바꿨어요/);
});

test('서버에 연결되지 않은 보드(workspace 없음)에서는 저장하지 않는다', async () => {
  const m = fixture();
  delete m.workspace;
  const { c, fetch, last } = ctl(m);
  c.open('p/t', 'n2');
  await c.dispatch('pass');
  assert.equal(fetch.calls.length, 0);
  assert.match(last(), /서버에 연결된 보드에서만/);
});

test('커밋 보기는 목록을 읽어 모달에 보인다', async () => {
  const m = fixture();
  const { c, fetch, last } = ctl(m, { status: 200, body: { commits: [{ hash: 'abc1234', subject: 'feat: 모달', verified: true }] } });
  c.open('p/t', 'n1');
  await c.dispatch('commits');
  assert.equal(fetch.calls[0].method, 'GET');
  assert.match(fetch.calls[0].path, /^\/w\/demo\/api\/commits\?sheet=p%2Ft&id=n1$/);
  assert.match(last(), /abc1234[\s\S]*feat: 모달/);
});

// ── 파생 상태와 스타일
test('verdict는 확인 대기일 때만 칸을 옮기고 그 밖에는 저장값 그대로다', () => {
  const eff = (state, column, verdict) => Verdict.effective({ state, column, verdict });
  assert.deepEqual(eff('확인 대기', '확인 대기', ''), { state: '확인 대기', column: '확인 대기', pending: '' });
  assert.equal(eff('끝남', '끝남', '고쳐줘').column, '끝남');
  assert.equal(eff('진행', '진행', '통과').column, '진행');
  assert.equal(eff('확인 대기', '확인 대기', '고쳐줘').state, '진행');
});

test('모달 CSS는 토큰만 쓰고 테두리가 없으며 accent는 내 댓글 표시(.by-user)에만 쓴다', () => {
  const css = read('node_modal.css').replace(/\/\*[\s\S]*?\*\//g, '');
  // 에이전트와 내 댓글을 한눈에 가르려고 내 아바타·이름·말풍선만 accent를 쓴다(2026-10-15 사람이 목업으로 고름)
  const accentRules = css.split('}').filter((r) => /var\(--accent\)/.test(r));
  assert.ok(accentRules.length > 0 && accentRules.every((r) => /^\s*\.by-user\b/.test(r)), 'accent는 .by-user 규칙에만');
  assert.doesNotMatch(css, /border:\s*1px/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  // 반지름·그림자는 떠 있는 면(.surface) 하나가 갖는다 — 모달이 그 클래스를 쓴다
  assert.match(M.dialog(node({}), { ticket: {}, local: true, sessions: true }), /class="nm surface"/);
  assert.match(read('tokens.css'), /\.surface\s*\{[^}]*border:\s*0/);
  assert.doesNotMatch(read('node_modal.js') + read('verdict.js'), /accent/);
});

// ── 확인할 것 · 근거 이미지 · 여러 줄 고쳐줘
const withChecks = () => {
  const m = fixture();
  Object.assign(nodeOf(m, 'n2'), {
    checks: { intro: '근거는 `evidence/n2/modal.png`예요. 아래를 봐 주세요.', items: ['간격이 좁다 `8px`', '색이 없다', '<b>태그</b>'] },
    evidence: ['modal.png', 'second.JPG', 'note.txt'],
  });
  return m;
};

test('확인할 것: 안내 문단과 체크박스 항목을 그리고, 글은 이스케이프한다', () => {
  const m = withChecks();
  const html = M.dialog(nodeOf(m, 'n2'), { ticket: m.projects[0].tickets[0], workspace: 'demo', ui: {} });
  assert.match(html, /<h3 class="nm-h">확인할 것<\/h3>/);
  assert.match(html, /data-nm-intro>근거는 <code>evidence\/n2\/modal\.png<\/code>예요/);
  assert.equal((html.match(/type="checkbox" data-nm-check="\d"/g) || []).length, 3);
  assert.match(html, /간격이 좁다 <code>8px<\/code>/);
  assert.match(html, /&lt;b&gt;태그&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>태그/);
  assert.match(M.dialog(nodeOf(m, 'n2'), { ticket: m.projects[0].tickets[0], workspace: 'demo', ui: { checked: [1] } }),
    /data-nm-check="1" checked/);
});

test('확인할 것이 없는 노드와 확인 대기가 아닌 노드에는 그 칸이 없다', () => {
  const m = withChecks();
  const t = m.projects[0].tickets[0];
  assert.doesNotMatch(M.dialog(nodeOf(m, 'n1'), { ticket: t, ui: {} }), /확인할 것/);
  assert.doesNotMatch(M.dialog({ ...nodeOf(m, 'n2'), state: '끝남' }, { ticket: t, ui: {} }), /확인할 것/);
});

test('근거 이미지는 썸네일이고 같은 출처 주소를 쓴다. 이미지가 아닌 파일은 이름만 보인다', () => {
  const m = withChecks();
  const html = M.dialog(nodeOf(m, 'n2'), { ticket: m.projects[0].tickets[0], workspace: 'demo', ui: {} });
  assert.match(html, /<img src="\/w\/demo\/api\/evidence\?sheet=p%2Ft&amp;id=n2&amp;name=modal\.png"/);
  assert.match(html, /name=second\.JPG/);
  assert.equal((html.match(/data-nm="zoom"/g) || []).length, 2);
  assert.match(html, /nm-mono">note\.txt</);
  assert.doesNotMatch(html, /<img[^>]*note\.txt/);
  assert.doesNotMatch(html, /src="https?:/, 'CSP default-src self — 바깥 주소 없음');
});

test('썸네일을 누르면 크게 보이고, 닫으면 돌아온다. 모달을 닫으면 확대도 풀린다', () => {
  const m = withChecks();
  const { c, last } = ctl(m);
  c.open('p/t', 'n2');
  c.dispatch('zoom', { name: 'modal.png' });
  assert.match(last(), /class="nm-lb" data-nm="unzoom"><img src="\/w\/demo\/api\/evidence\?[^"]*name=modal\.png"/);
  c.dispatch('zoom', { name: '../../x.png' });
  assert.doesNotMatch(last(), /nm-lb/, '근거 목록에 없는 이름은 크게 보이지 않는다');
  c.dispatch('zoom', { name: 'modal.png' });
  c.dispatch('unzoom');
  assert.doesNotMatch(last(), /nm-lb/);
  c.dispatch('zoom', { name: 'modal.png' });
  c.close();
  c.open('p/t', 'n2');
  assert.doesNotMatch(last(), /nm-lb/);
});

test('고쳐줘: 체크한 항목만 보내도 되고, 체크와 자유 입력은 여러 줄 fix 하나로 합친다', async () => {
  const m = withChecks();
  const { c, fetch, last } = ctl(m, { status: 200, body: { ok: true, user: { verdict: '고쳐줘', fix: 'x' } } });
  c.open('p/t', 'n2');
  await c.dispatch('fix');
  assert.match(last(), /<textarea class="nm-in"/);
  await c.dispatch('send'); // 아무것도 없다
  assert.equal(fetch.calls.length, 0);
  assert.match(last(), /체크하거나 내용을 적어/);

  c.toggleCheck('0', true);
  c.toggleCheck('2', true);
  c.toggleCheck('2', false);
  await c.dispatch('send');
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(fetch.calls[0].body.user, { verdict: '고쳐줘', fix: '- 간격이 좁다 `8px`' });

  const second = ctl(m, { status: 200, body: { ok: true, user: { verdict: '고쳐줘', fix: 'x' } } });
  second.c.open('p/t', 'n2');
  await second.c.dispatch('fix');
  second.c.toggleCheck('0', true);
  second.c.toggleCheck('1', true);
  second.c.setDraft('  버튼도 작아요\n두 번째 줄  ');
  await second.c.dispatch('send');
  assert.equal(second.fetch.calls[0].body.user.fix, '- 간격이 좁다 `8px`\n- 색이 없다\n버튼도 작아요\n두 번째 줄');
});

test('composeFix: 자유 입력만 있어도 되고 둘 다 비면 빈 글이다', () => {
  const node = { checks: { items: ['가', '나'] } };
  assert.equal(M.composeFix(node, [], '  손잡이  '), '손잡이');
  assert.equal(M.composeFix(node, [1], ''), '- 나');
  assert.equal(M.composeFix(node, [], '  \n '), '');
  assert.equal(M.composeFix({}, [0], ''), '');
});


test('rich: 코드와 굵게만 태그가 되고 나머지는 이스케이프된다', () => {
  assert.equal(M.rich('**회귀**: `a<b` <i>x</i>'), '<b>회귀</b>: <code>a&lt;b</code> &lt;i&gt;x&lt;/i&gt;');
});


// ── 댓글: PR 리뷰처럼 줄에 다는 스레드
test('스레드는 오른쪽 댓글 열에 본문 순서로, 줄에는 댓글 수만 보이고 줄이 사라진 스레드·전체 댓글은 그 뒤에 온다', () => {
  const n = node({ state: '끝남', column: '끝남', criteria: [{ text: '테스트 통과', done: true }], comments: [
    { id: 'c1', by: 'user', at: '2026-10-14 10:00', text: '어떤 테스트요?', anchor: { sec: 'crit', text: '테스트 통과' } },
    { id: 'c2', by: 'agent', at: '2026-10-14 10:05', text: 'jest 한 파일입니다', reply_to: 'c1' },
    { id: 'c3', by: 'user', at: '2026-10-14 10:06', text: '옛 줄', anchor: { sec: 'crit', text: '지운 기준' } },
    { id: 'c4', by: 'user', at: '2026-10-14 10:07', text: '전체 의견' },
  ] });
  const html = M.dialog(n, { ticket: { nodes: [n], rows: [] } });
  const crit = html.slice(html.indexOf('완료 기준'), html.indexOf('data-nm-comments'));
  assert.match(crit, /<li class="nm-ln has[^"]*">[\s\S]*data-nm="cm-focus" data-thread="c1"[^>]*>💬 2<\/button>/, '줄에는 댓글 수(글 2개)');
  assert.doesNotMatch(crit, /어떤 테스트요/, '스레드 글은 본문에 끼지 않는다');
  const rail = html.slice(html.indexOf('data-nm-comments'));
  assert.match(rail, /<b>완료 기준<\/b> · 테스트 통과[\s\S]*어떤 테스트요\?[\s\S]*jest 한 파일입니다[\s\S]*지운 기준[\s\S]*전체 의견/, '줄 스레드(인용)→줄 없는 스레드→전체 댓글 순');
  assert.match(rail, /class="nm-cm-e by-user"><span class="nm-av" aria-hidden="true">나<\/span>[\s\S]*class="nm-cm-e by-agent"><span class="nm-av" aria-hidden="true">AI/, '나와 에이전트를 아바타로 가른다');
  assert.match(rail, /class="nm-rc"><div class="nm-cm-new"><textarea[^>]*placeholder="노드 전체에 댓글/, '맨 아래에 전체 댓글 칸이 늘 있다');
  assert.match(html, /data-nm="cm-new" data-sec="crit" data-text="테스트 통과"/, '줄마다 + 버튼');
  assert.doesNotMatch(html, /data-cm-active/, '쓰기 시작 전에는 포커스를 가져갈 입력 칸이 없다');
});

test('줄 댓글 수를 누르면 그 줄과 스레드를 같이 강조하고, 맨 아래 칸에 바로 쓰면 전체 댓글이 된다', async () => {
  const model = fixture();
  const n2 = nodeOf(model, 'n2');
  n2.criteria = [{ text: '캡처 3장', done: false }];
  n2.comments = [{ id: 'c1', by: 'agent', at: 'x', text: '찍었어요', anchor: { sec: 'crit', text: '캡처 3장' } }];
  const { c, fetch, last } = ctl(model, { status: 200, body: { ok: true, comments: [] } });
  c.open('p/t', 'n2');
  c.dispatch('cm-focus', { thread: 'c1' });
  assert.match(last(), /<li class="nm-ln has hl">/);
  assert.match(last(), /<div class="nm-cm on" data-cm-thread="c1">/);
  c.dispatch('cm-focus', { thread: 'c1' });
  assert.doesNotMatch(last(), /nm-cm on/, '다시 누르면 푼다');
  c.setCmDraft('전체에 한마디');
  await c.cmSend();
  assert.deepEqual(fetch.calls[0].body.comment, { text: "전체에 한마디" });
});

test('스레드 상태: 사람 글이 마지막이면 답을 기다리고, 해결하면 접힌다', () => {
  const t = M.threadsOf([
    { id: 'c1', by: 'user', text: 'a' }, { id: 'c2', by: 'agent', text: 'b', reply_to: 'c1' },
    { id: 'c3', by: 'user', text: 'c' }, { id: 'c4', by: 'user', reply_to: 'c3', resolve: true },
  ]);
  assert.deepEqual(t.map((x) => [x.id, x.waiting, x.resolved]), [['c1', false, false], ['c3', false, true]]);
  const n = node({ state: '끝남', column: '끝남', comments: [{ id: 'c1', by: 'user', text: '닫힌 것' }, { id: 'c2', by: 'user', reply_to: 'c1', resolve: true }] });
  assert.match(M.dialog(n, { ticket: { nodes: [n], rows: [] } }), /<details class="nm-cm is-done"[^>]*><summary>해결됨 · 닫힌 것/);
});

test('줄 + → 입력 → 남기기는 anchor와 함께 comment API에 한 번 보낸다', async () => {
  const model = fixture();
  const n2 = nodeOf(model, 'n2');
  n2.criteria = [{ text: '캡처 3장', done: false }];
  const { c, fetch, last } = ctl(model, { status: 200, body: { ok: true, comments: [{ id: 'c1', by: 'user', at: 'x', text: '어디요?', anchor: { sec: 'crit', text: '캡처 3장' } }] } });
  c.open('p/t', 'n2');
  c.dispatch('cm-new', { sec: 'crit', text: '캡처 3장' });
  assert.match(last(), /class="nm-cm-in"/);
  await c.cmSend();
  assert.equal(fetch.calls.length, 0, '빈 글은 보내지 않는다');
  c.setCmDraft('어디요?');
  await c.cmSend();
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].path, '/w/demo/api/comment');
  assert.deepEqual(fetch.calls[0].body, { sheet: 'p/t', id: 'n2', comment: { text: '어디요?', anchor: { sec: 'crit', text: '캡처 3장' } } });
  assert.equal(c.state.cm, null);
  assert.match(last(), /어디요\?/);
  assert.equal(n2.verdict, '', '댓글은 통과·고쳐줘 칸을 건드리지 않는다');
});

test('답글과 해결은 reply_to로 보내고 댓글 글은 태그로 새지 않는다', async () => {
  const model = fixture();
  nodeOf(model, 'n2').comments = [{ id: 'c1', by: 'agent', text: '<img src=x onerror=alert(1)>' }];
  const { c, fetch, last } = ctl(model, { status: 200, body: { ok: true, comments: [] } });
  c.open('p/t', 'n2');
  assert.doesNotMatch(last(), /<img src=x/);
  c.dispatch('cm-reply', { thread: 'c1' });
  c.setCmDraft('네');
  await c.cmSend();
  await c.dispatch('cm-resolve', { thread: 'c1', on: '1' });
  assert.deepEqual(fetch.calls.map((x) => x.body.comment), [{ text: '네', reply_to: 'c1' }, { reply_to: 'c1', resolve: true }]);
});

test('댓글 스크린샷은 글 아래 썸네일로 보이고, 이미지만 있는 댓글도 한 줄로 보인다', () => {
  const n = node({ state: '확인 대기', column: '확인 대기', comments: [
    { id: 'c1', by: 'agent', at: '2026-10-15 14:00', text: '캡처 첨부', images: ['cm-20261015-1.png'] },
    { id: 'c2', by: 'user', at: '2026-10-15 14:01', images: ['cm-u20261015-ab.png'] },
  ] });
  const html = M.dialog(n, { workspace: 'demo', ticket: { slug: 'p/t', nodes: [n], rows: [] } });
  assert.match(html, /캡처 첨부[\s\S]*class="nm-cm-img" data-nm="zoom" data-name="cm-20261015-1\.png"/);
  assert.match(html, /api\/evidence\?sheet=p%2Ft&amp;id=n1&amp;name=cm-20261015-1\.png/);
  assert.match(html, /data-name="cm-u20261015-ab\.png"/, '이미지만 있는 댓글');
});

test('스크린샷을 올려 붙이면 이름만 댓글과 함께 가고, 이미지만으로도 남길 수 있다', async () => {
  const model = fixture();
  const n2 = nodeOf(model, 'n2');
  const calls = [];
  const c = M.controller({
    getModel: () => model, redraw() {}, render() {},
    fetch: async (path, init) => {
      calls.push({ path, init });
      if (path.includes('/api/comment-image')) return { ok: true, status: 200, json: async () => ({ ok: true, name: 'cm-u1-aa.png' }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, comments: [{ id: 'c1', by: 'user', at: 'x', images: ['cm-u1-aa.png'] }] }) };
    },
  });
  c.open('p/t', 'n2');
  c.dispatch('cm-new', {});
  await c.cmAttach({ type: 'text/plain', size: 3 });
  assert.equal(calls.length, 0, '이미지가 아니면 요청이 없다');
  await c.cmAttach({ type: 'image/png', size: 10 });
  assert.match(calls[0].path, /\/w\/demo\/api\/comment-image\?sheet=p%2Ft&id=n2$/);
  assert.equal(calls[0].init.headers['Content-Type'], 'image/png');
  assert.deepEqual(c.state.cmImages, ['cm-u1-aa.png']);
  await c.cmSend();   // 글 없이 이미지만
  assert.deepEqual(JSON.parse(calls[1].init.body).comment, { text: '', images: ['cm-u1-aa.png'] });
  assert.deepEqual(c.state.cmImages, []);
  assert.equal(n2.comments.length, 1);
});


test('여러 장을 한 번에 붙여도 댓글 하나에 6장을 넘지 않는다', async () => {
  const model = fixture();
  let n = 0;
  const c = M.controller({
    getModel: () => model, redraw() {}, render() {},
    fetch: async () => { const i = ++n; await new Promise((r) => setTimeout(r, 5)); return { ok: true, status: 200, json: async () => ({ ok: true, name: 'cm-' + i + '.png' }) }; },
  });
  c.open('p/t', 'n2');
  c.dispatch('cm-new', {});
  await Promise.all(Array.from({ length: 9 }, () => c.cmAttach({ type: 'image/png', size: 10 })));
  assert.equal(n, 6, '업로드도 6번만 나간다');
  assert.equal(c.state.cmImages.length, 6);
});


test('댓글 스크린샷과 쓰고 있는 댓글의 이미지도 눌러 크게 본다', () => {
  const m = fixture();
  const n = { ...nodeOf(m, 'n2'), evidence: [], comments: [{ id: 'c1', by: 'agent', at: 'x', text: '찍었어요', images: ['cm-1.png'] }] };
  const tk = m.projects[0].tickets[0];
  assert.match(M.dialog(n, { ticket: tk, workspace: 'demo', ui: { zoom: 'cm-1.png' } }), /<div class="nm-lb" data-nm="unzoom"><img src="[^"]*name=cm-1\.png"/);
  assert.match(M.dialog(n, { ticket: tk, workspace: 'demo', ui: { zoom: 'cm-u2.png', cmImages: ['cm-u2.png'] } }), /class="nm-lb"[\s\S]*name=cm-u2\.png/);
  assert.doesNotMatch(M.dialog(n, { ticket: tk, workspace: 'demo', ui: { zoom: '../x.png' } }), /nm-lb/, '목록에 없는 이름은 열지 않는다');
});

