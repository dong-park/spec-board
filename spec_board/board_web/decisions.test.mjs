// node --test skills/spec/scripts/board_web/decisions.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const D = req('./decisions.js');
const V = req('./view.js');

// ── 고정 데이터 — T10의 Given: 막는 결정 1, 되돌리기 쉬운 결정 2, 끝난 결정 여럿
const dec = (over) => ({
  id: 'D1', display_id: 'WM-D1', kind: 'decision', title: '지우개로 지우는 단위', given: '', when: '', then: '',
  options: [{ key: 'A', label: '지나간 자리만', why: '획을 조각으로 나눠 저장' }, { key: 'B', label: '통째로', why: '획 단위' }],
  recommend: 'A', confidence: 'high', reversible: true, status: '아직 안 함', open: true, blocking: false,
  blocks: [], user: { answer: '', fix: '' }, blocked_nodes: [], blocked_node_ids: [], ticket: 'wm/t', project: 'wm', ...over,
});
const DECISIONS = () => [
  dec({ id: 'D9', display_id: 'WM-D9', title: '재질 전환 길이', reversible: true }),
  dec({ id: 'D1', display_id: 'WM-D1', title: '지우개 단위', reversible: false, blocking: true, blocked_nodes: ['n2', 'n3'], blocked_node_ids: ['WM-2', 'WM-3'] }),
  dec({ id: 'D10', display_id: 'WM-D10', title: '검색 결과 개수', reversible: true }),
  dec({ id: 'D2', display_id: 'WM-D2', title: '빈 포스트잇', reversible: false, open: false, status: '끝남', user: { answer: 'B', fix: '' } }),
  dec({ id: 'D3', display_id: 'WM-D3', title: '메모판 핀', open: false, status: '끝남' }),
  dec({ id: 'D4', display_id: 'WM-D4', title: '글자 크기', open: false, status: '끝남', user: { answer: '조금 크게', fix: '' } }),
];
const nodeOf = (over) => ({ key: 'n1', id: 'WM-1', title: '틀', state: '아직 안 함', column: '시작 가능', deps: [], waiting_on: [],
  blocked_by: [], blocked_by_ids: [], warnings: [], error: '', ...over });
const MODEL = () => {
  const decisions = DECISIONS();
  return {
    root: '/x/demo', workspace: 'demo',
    summary: { decisions_open: 3, decisions_blocking: 1, to_check: 0 },
    projects: [{ key: 'wm', title: '유리벽 — 문제', state: '진행', tickets: [{
      slug: 'wm/t', title: '마카', counts: { 시작가능: 1 },
      rows: decisions, // 결정은 티켓 rows에만 있다 — 화면이 D.list(model)로 모은다
      nodes: [
        nodeOf({ key: 'n2', id: 'WM-2', title: '마카 들기', state: '막힘', column: '기다림', blocked_by: ['D1'], blocked_by_ids: ['WM-D1'] }),
        nodeOf({ key: 'n3', id: 'WM-3', title: '지우개 모양', state: '막힘', column: '기다림', blocked_by: ['D1', 'D9'], blocked_by_ids: ['WM-D1', 'WM-D9'] }),
      ],
    }] }],
  };
};

// 가짜 서버 — 호출을 모으고 준비한 응답을 차례로 준다
const fakePost = (...replies) => {
  const calls = [];
  const post = async (url, body) => {
    calls.push({ url, body });
    const r = replies.shift() || { status: 200, json: { ok: true, user: { answer: body.user.answer, fix: '' } } };
    if (r instanceof Error) throw r;
    return r;
  };
  return { post, calls };
};
const make = (model, post) => {
  let changes = 0, saved = 0, conflicts = 0;
  const ctl = D.controller({
    getModel: () => model, post, onChange: () => { changes++; }, onSaved: () => { saved++; }, onConflict: () => { conflicts++; },
  });
  return { ctl, n: () => ({ changes, saved, conflicts }) };
};

// ── T10: 세 묶음
test('결정은 막는 결정 · 답할 결정 · 끝남 순서의 세 묶음이다', () => {
  const g = D.groups(DECISIONS());
  assert.deepEqual(g.map((x) => x.key), ['blocking', 'ask', 'done']);
  assert.deepEqual(g.map((x) => x.label), ['막는 결정', '답할 결정', '끝남']);
  assert.deepEqual(g[0].items.map((d) => d.id), ['D1']);
  assert.deepEqual(g[1].items.map((d) => d.id), ['D9', 'D10']);
  assert.deepEqual(g[2].items.map((d) => d.id), ['D2', 'D3', 'D4']);
});

test('결정 메뉴는 막는 결정이 맨 위이고 줄마다 누르면 모달이 열릴 속성이 있다', () => {
  const html = D.menu(MODEL());
  const at = (s) => html.indexOf(s);
  assert.ok(at('막는 결정') < at('답할 결정') && at('답할 결정') < at('끝남'));
  assert.ok(at('WM-D1') < at('WM-D9'), '막는 줄이 답할 줄보다 위');
  assert.equal((html.match(/class="drow /g) || []).length, 6);
  assert.match(html, /data-dec="WM-D1" data-ticket="wm\/t"/);
});

test("'답 없으면 추천대로'는 되돌리기 쉬운 열린 결정 줄에만 보인다", () => {
  const html = D.menu(MODEL());
  assert.equal((html.match(/답 없으면 추천대로/g) || []).length, 2);
  const row = (id) => html.slice(html.indexOf(`data-dec="${id}"`)).split('<div class="drow')[0];
  assert.match(row('WM-D9'), /답 없으면 추천대로/);
  assert.match(row('WM-D10'), /답 없으면 추천대로/);
  assert.doesNotMatch(row('WM-D1'), /답 없으면 추천대로/, '막는 결정은 추천대로 안 간다');
  assert.match(row('WM-D1'), /되돌리기 어려움/);
  assert.doesNotMatch(row('WM-D2'), /답 없으면 추천대로/, '끝난 줄');
});

test('추천 선택지는 굵게, 고른 답은 ✓로 표시되고 끝난 줄은 사용자 답이 보인다', () => {
  const html = D.menu(MODEL());
  assert.match(html, /<span class="op rec" title="추천">A 지나간 자리만<\/span>/);
  assert.match(html, /<span class="op ans">✓ B 통째로<\/span>/, 'D2는 B로 끝남');
  assert.match(html, /<span class="op ans">✓ 조금 크게<\/span>/, '직접 쓴 답');
  assert.match(html, /사용자 답/);
});

test('사이드바 결정 옆 숫자는 막는 결정 수다', () => {
  const m = MODEL();
  assert.match(V.sidebar(m, {}), /Decisions<\/span><span class="badge-dec">1<\/span>/);
  assert.equal(D.blockingCount(D.list(m)), 1);
});

test('결정 면은 view.js의 stage가 메뉴로 채운다', () => {
  const html = V.stage(MODEL(), { view: 'dec' });
  assert.match(html, /class="dlist"/);
  assert.doesNotMatch(html, /data-slot="dec"/);
});

// ── T14: 카드의 ◆ 칩에서 결정 모달로
test('막힌 카드의 ◆ 칩은 어느 결정인지 속성으로 갖는다', () => {
  const m = MODEL();
  const n = m.projects[0].tickets[0].nodes[1];
  const html = V.card(n, { ticket: 'wm/t' });
  assert.match(html, /<span class="chip dec"[^>]*data-dec="WM-D1" data-ticket="wm\/t">◆ WM-D1 \+1<\/span>/);
  assert.equal((html.match(/◆/g) || []).length, 1);
  assert.ok(D.find(m, 'wm/t', 'WM-D1'), '칩 속성으로 결정을 찾는다');
});

test('모달에는 선택지·추천 표시·답하면 풀림 목록이 보인다', () => {
  const m = MODEL();
  const { ctl } = make(m, fakePost().post);
  assert.ok(ctl.open('wm/t', 'WM-D1'));
  const p = D.modalParts(ctl.current(), ctl.view(), m);
  assert.match(p.main, /A 지나간 자리만/);
  assert.match(p.main, /B 통째로/);
  assert.equal((p.main.match(/class="tag">추천</g) || []).length, 1);
  assert.match(p.main, /직접 쓰기/);
  assert.match(p.side, /답하면 풀림/);
  assert.match(p.side, /WM-2<\/span><span class="rt-t">마카 들기/);
  assert.match(p.side, /WM-3<\/span><span class="rt-t">지우개 모양/);
  assert.match(p.side, /결정 \+1/, 'WM-3은 다른 결정도 기다린다');
  assert.match(p.foot, /data-dec-submit disabled/, '고르기 전에는 답하기가 꺼져 있다');
  const shell = V.modalShell(p);
  assert.match(shell, /role="dialog"/);
  assert.match(shell, /WM-D1<\/b>/);
});

test('고르면 답하기가 켜지고, 추천을 미리 고르지 않는다', () => {
  const { ctl } = make(MODEL(), fakePost().post);
  ctl.open('wm/t', 'WM-D1');
  assert.equal(ctl.state.choice, '');
  assert.equal(ctl.canSubmit(), false);
  ctl.chooseNth(2);
  assert.equal(ctl.state.choice, 'B');
  assert.equal(ctl.canSubmit(), true);
  assert.match(D.modalParts(ctl.current(), ctl.view(), MODEL()).main, /class="mo on"[^>]*data-opt="B"/);
});

test('추천이 아닌 B로 답하면 모달이 닫히고 막는 묶음에서 빠지며 숫자가 줄어든다', async () => {
  const m = MODEL();
  const f = fakePost();
  const { ctl, n } = make(m, f.post);
  ctl.open('wm/t', 'WM-D1');
  ctl.choose('B');
  const r = await ctl.submit();
  assert.equal(r.ok, true);
  assert.equal(ctl.state.open, null, '모달이 닫힌다');
  assert.equal(n().saved, 1);
  const g = D.groups(D.list(m));
  assert.deepEqual(g[0].items.map((d) => d.id), [], '막는 묶음에서 빠진다');
  assert.ok(g[1].items.some((d) => d.id === 'D1'), '답했지만 에이전트가 아직 안 읽었으므로 답할 묶음에 남는다');
  assert.deepEqual(g[1].items.map((d) => d.id), ['D9', 'D10', 'D1'], '답 없는 줄이 먼저, 답한 줄이 뒤');
  assert.equal(m.summary.decisions_blocking, 0);
  assert.doesNotMatch(V.sidebar(m, {}), /badge-dec/, '배지가 사라진다');
  assert.match(D.menu(m), /답함 · 반영 대기/);
  // 티켓 rows의 복사본도 같이 고쳐졌다 (n13이 rows를 읽는다)
  assert.equal(m.projects[0].tickets[0].rows.find((r) => r.id === 'D1').user.answer, 'B');
  // 막힌 카드의 ◆ 칩은 에이전트가 반영하기 전까지 남는다 — 이 화면은 노드 칸을 쓰지 않는다
  assert.match(V.card(m.projects[0].tickets[0].nodes[0], { ticket: 'wm/t' }), /◆ WM-D1/);
});

test('답은 user.answer 하나로만 가고 base에 지금 값을 싣는다', async () => {
  const m = MODEL();
  D.list(m)[0].user = { answer: 'A', fix: '' };
  const f = fakePost();
  const { ctl } = make(m, f.post);
  ctl.open('wm/t', 'WM-D9');
  ctl.choose('B');
  await ctl.submit();
  assert.equal(f.calls.length, 1);
  const { url, body } = f.calls[0];
  assert.equal(url, '/w/demo/api/user');
  assert.deepEqual(body, { sheet: 'wm/t', id: 'D9', user: { answer: 'B' }, base: { answer: 'A' } });
});

test('워크스페이스 이름은 URL에 이스케이프되어 들어간다', async () => {
  const m = MODEL();
  m.workspace = 'my repo/x';
  const f = fakePost();
  const { ctl } = make(m, f.post);
  ctl.open('wm/t', 'WM-D9'); ctl.choose('A');
  await ctl.submit();
  assert.equal(f.calls[0].url, '/w/my%20repo%2Fx/api/user');
});

// ── 409
test("409면 '다른 곳에서 먼저 바꿨어요'를 보이고 모달을 닫지 않고 서버 값을 받는다", async () => {
  const m = MODEL();
  const f = fakePost({ status: 409, json: { error: 'conflict', user: { answer: 'A', fix: '' } } });
  const { ctl, n } = make(m, f.post);
  ctl.open('wm/t', 'WM-D1');
  ctl.choose('B');
  const r = await ctl.submit();
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.ok(ctl.state.open, '모달은 열려 있다');
  assert.equal(n().saved, 0, '저장된 것이 아니다');
  assert.equal(n().conflicts, 1, '뒤 화면은 서버 값에 맞추라는 신호가 간다');
  assert.equal(m.summary.decisions_blocking, 0, '서버 값이 답이라 막는 결정이 아니다');
  assert.match(ctl.state.notice, /다른 곳에서 먼저 바꿨어요/);
  assert.equal(ctl.state.choice, 'A', '서버 값으로 다시 보여 준다');
  assert.equal(D.list(m)[1].user.answer, 'A');
  const p = D.modalParts(ctl.current(), ctl.view(), m);
  assert.match(p.main, /다른 곳에서 먼저 바꿨어요/);
  assert.match(p.main, /role="status"/);
});

test('답이 비어 있으면 서버로 보내지 않는다', async () => {
  const f = fakePost();
  const { ctl } = make(MODEL(), f.post);
  ctl.open('wm/t', 'WM-D1');
  assert.equal((await ctl.submit()).reason, 'empty');
  ctl.choose(D.FREE);
  ctl.setText('   ');
  assert.equal(ctl.canSubmit(), false);
  assert.equal((await ctl.submit()).ok, false);
  assert.equal(f.calls.length, 0);
});

test('직접 쓴 답은 다듬어서 그대로 answer가 된다', async () => {
  const m = MODEL();
  const f = fakePost();
  const { ctl } = make(m, f.post);
  ctl.open('wm/t', 'WM-D1');
  ctl.setText('  획이 아니라 레이어째로  ');
  assert.equal(ctl.state.choice, D.FREE, '글자를 치면 직접 쓰기로 옮겨 간다');
  await ctl.submit();
  assert.equal(f.calls[0].body.user.answer, '획이 아니라 레이어째로');
  assert.equal(D.list(m)[1].user.answer, '획이 아니라 레이어째로');
});

test('이미 같은 답이면 답하기가 꺼져 있다', () => {
  const m = MODEL();
  D.list(m)[0].user = { answer: 'A', fix: '' };
  const { ctl } = make(m, fakePost().post);
  ctl.open('wm/t', 'WM-D9');
  assert.equal(ctl.state.choice, 'A', '지금 답이 골라져 열린다');
  assert.equal(ctl.canSubmit(), false);
  ctl.choose('B');
  assert.equal(ctl.canSubmit(), true);
});

test('서버가 실패하거나 끊기면 안내하고 모달을 지키며, 두 번 눌러도 한 번만 간다', async () => {
  for (const reply of [{ status: 500, json: { error: 'x' } }, new Error('network')]) {
    const f = fakePost(reply);
    const { ctl } = make(MODEL(), f.post);
    ctl.open('wm/t', 'WM-D1'); ctl.choose('B');
    const r = await ctl.submit();
    assert.equal(r.ok, false);
    assert.equal(ctl.state.notice, D.MSG_FAILED);
    assert.ok(ctl.state.open);
    assert.equal(ctl.state.busy, false);
  }
  let release;
  const slow = { post: (_url, body) => new Promise((res) => { release = () => res({ status: 200, json: { ok: true, user: { answer: body.user.answer } } }); }) };
  const { ctl } = make(MODEL(), slow.post);
  ctl.open('wm/t', 'WM-D1'); ctl.choose('B');
  const first = ctl.submit();
  assert.equal((await ctl.submit()).ok, false, '저장 중에는 다시 못 보낸다');
  release();
  assert.equal((await first).ok, true);
});

test('끝난 결정은 열어 볼 수만 있고 답하기가 없다', () => {
  const m = MODEL();
  const { ctl } = make(m, fakePost().post);
  assert.ok(ctl.open('wm/t', 'WM-D2'));
  assert.equal(ctl.state.choice, 'B');
  const p = D.modalParts(ctl.current(), ctl.view(), m);
  assert.doesNotMatch(p.foot, /data-dec-submit/);
  assert.doesNotMatch(p.main, /data-dec-text/);
  assert.doesNotMatch(p.main, /data-opt=/);
  ctl.choose('A');
  assert.equal(ctl.state.choice, 'B', '고름이 바뀌지 않는다');
});

test('없는 결정은 열리지 않고, 제목·ID·선택지는 이스케이프된다', () => {
  const m = MODEL();
  m.projects[0].tickets[0].rows.push(dec({ id: 'X', display_id: '"><b>', title: '<img src=x onerror=alert(1)>',
    options: [{ key: 'A', label: '<script>', why: '<i>' }] }));
  const { ctl } = make(m, fakePost().post);
  assert.equal(ctl.open('wm/t', 'NOPE'), false);
  assert.ok(ctl.open('wm/t', '"><b>'));
  const menu = D.menu(m);
  const modal = V.modalShell(D.modalParts(ctl.current(), ctl.view(), m));
  for (const html of [menu, modal]) {
    assert.doesNotMatch(html, /<img src|<script|<i>/, '태그로 살아나지 않는다');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /&quot;&gt;&lt;b&gt;/);
  }
});

// ── 실경로: 진짜 sheet.py와 임시 레포로 답하기 → 막는 묶음에서 빠짐 → 에이전트 반영 → 칩 사라짐
const hasPython = spawnSync('python3', ['--version']).status === 0;
const free = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const tmp = mkdtempSync(join(tmpdir(), 'dectest-'));
let server;
after(() => { if (server) server.kill(); rmSync(tmp, { recursive: true, force: true }); });

function seedRepo() {
  const t = join(tmp, 'spec', 'g', 't');
  mkdirSync(join(t, 'rows'), { recursive: true });
  writeFileSync(join(tmp, 'spec', 'g', 'README.md'), '# 줄기\n\n| 항목 | 값 |\n|---|---|\n| 종류 | 줄기 |\n| 문제 | 줄기 문제 |\n| 상태 | 진행 |\n');
  writeFileSync(join(t, 'spec.md'),
    '# 데모 티켓\n\n| 항목 | 값 |\n|---|---|\n| 문제 | 데모 |\n| 상태 | 진행 |\n| ID 머리 | DM |\n\n## 노드 인덱스\n\n' +
    '| ID | 브리프 | deps | 상태 |\n|---|---|---|---|\n| n1 | [n1-demo.md](n1-demo.md) | — | 막힘 |\n');
  writeFileSync(join(t, 'n1-demo.md'),
    '# n1-demo — 데모\n\n**agent**: runner\n**id**: DM-1\n**상위**: spec/g/t/spec.md\n**deps**: 없음\n**상태**: 막힘\n**담당 행**: T1\n\n## 문제\n\n데모.\n');
  const base = { kind: 'decision', given: 'g', when: 'w', then: 't', options: [{ key: 'A', label: '하나', why: '' }, { key: 'B', label: '둘', why: '' }],
    recommend: 'A', confidence: 'high', status: '아직 안 함', user: { answer: '', fix: '' }, log: [] };
  writeFileSync(join(t, 'rows', 'D1.json'), JSON.stringify({ ...base, id: 'D1', title: '막는 결정', reversible: false, blocks: ['n1'] }));
  writeFileSync(join(t, 'rows', 'D2.json'), JSON.stringify({ ...base, id: 'D2', title: '쉬운 결정', reversible: true, blocks: [] }));
  return t;
}

test('실경로: 실제 서버에서 B로 답하면 파일에 user.answer만 쓰이고 막는 묶음에서 빠진다', { skip: !hasPython }, async () => {
  const ticket = seedRepo();
  const port = await free();
  server = spawn('python3', [join(here, '..', 'sheet.py'), '--port', String(port), tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('서버가 안 떴다')), 8000);
    server.stdout.on('data', (b) => { if (String(b).includes(`http://127.0.0.1:${port}/`)) { clearTimeout(t); res(); } });
    let err = '';
    server.stderr.on('data', (b) => { err += b; });
    server.on('exit', (c) => rej(new Error(`서버 종료 ${c}: ${err.slice(-300)}`)));
  });
  const origin = `http://127.0.0.1:${port}`;
  const ws = tmp.split('/').pop();
  const getModel = async () => (await (await fetch(`${origin}/api/board?w=${encodeURIComponent(ws)}`)).json());
  const post = async (url, body) => {
    const r = await fetch(origin + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };

  let model = await getModel();
  assert.equal(model.workspace, ws);
  assert.deepEqual(D.groups(D.list(model))[0].items.map((d) => d.id), ['D1']);
  assert.equal(model.summary.decisions_blocking, 1);
  const node = () => model.projects[0].tickets[0].nodes[0];
  assert.match(V.card(node(), { ticket: 'g/t' }), /◆ DM-D1/);

  // 두 번째 화면(폰이라고 치자)이 같은 값을 들고 있다
  const stale = JSON.parse(JSON.stringify(model));

  const { ctl } = make(model, post);
  assert.ok(ctl.open('g/t', 'DM-D1'));
  ctl.choose('B');
  const r = await ctl.submit();
  assert.equal(r.ok, true);
  const onDisk = JSON.parse(readFileSync(join(ticket, 'rows', 'D1.json'), 'utf8'));
  assert.equal(onDisk.user.answer, 'B');
  assert.equal(onDisk.status, '아직 안 함', '상태 칸은 화면이 쓰지 않는다');
  assert.deepEqual(onDisk.blocks, ['n1']);
  assert.equal(onDisk.id, 'D1');

  model = await getModel();
  assert.deepEqual(D.groups(D.list(model))[0].items.map((d) => d.id), [], '다시 읽어도 막는 묶음에서 빠져 있다');
  assert.equal(model.summary.decisions_blocking, 0);
  assert.match(V.card(node(), { ticket: 'g/t' }), /◆ DM-D1/, '에이전트가 반영하기 전까지 칩은 남는다');

  // 오래된 화면이 같은 결정에 답하면 서버가 409로 막는다 — 답은 안 날아간다
  const late = make(stale, post);
  late.ctl.open('g/t', 'DM-D1');
  late.ctl.choose('A');
  const c = await late.ctl.submit();
  assert.equal(c.conflict, true);
  assert.match(late.ctl.state.notice, /다른 곳에서 먼저 바꿨어요/);
  assert.equal(JSON.parse(readFileSync(join(ticket, 'rows', 'D1.json'), 'utf8')).user.answer, 'B', '먼저 한 답이 그대로다');
  assert.equal(late.ctl.state.choice, 'B', '오래된 화면이 새 값을 받았다');

  // 에이전트가 반영했다: 결정 행 끝남, 노드 막힘 해제 → ◆ 칩이 사라진다
  writeFileSync(join(ticket, 'rows', 'D1.json'), JSON.stringify({ ...onDisk, status: '끝남' }));
  writeFileSync(join(ticket, 'n1-demo.md'), readFileSync(join(ticket, 'n1-demo.md'), 'utf8').replace('**상태**: 막힘', '**상태**: 진행'));
  writeFileSync(join(ticket, 'spec.md'), readFileSync(join(ticket, 'spec.md'), 'utf8').replace('| 막힘 |', '| 진행 |'));
  model = await getModel();
  assert.doesNotMatch(V.card(node(), { ticket: 'g/t' }), /◆/);
  assert.deepEqual(D.groups(D.list(model))[2].items.map((d) => d.id), ['D1'], '끝남 묶음으로 간다');
});

test('list는 티켓 rows의 결정 행만 같은 객체로 모으고 ticket·project를 붙인다 — 복제본이 없다', () => {
  const m = MODEL();
  m.projects[0].tickets[0].rows.push({ id: 'T1', kind: 'task', title: '시나리오', user: {} });
  for (const r of m.projects[0].tickets[0].rows) { delete r.ticket; delete r.project; }
  const all = D.list(m);
  assert.deepEqual(all.map((d) => d.id), ['D9', 'D1', 'D10', 'D2', 'D3', 'D4'], '작업 행은 없다');
  assert.ok(all.every((d) => d.ticket === 'wm/t' && d.project === 'wm'));
  assert.equal(all[0], m.projects[0].tickets[0].rows[0], '같은 객체 — 한 곳만 고치면 된다');
  assert.equal(m.decisions, undefined, '모델에 따로 복제한 목록이 없다');
  assert.deepEqual(D.list({}), []);
  assert.deepEqual(D.list(null), []);
});

test('로컬 답 반영은 한 벌만 고치고 사이드바 숫자는 목록에서 다시 센다', () => {
  const m = MODEL();
  D.applyUser(m, 'wm/t', 'D1', { answer: 'B' });
  assert.equal(m.projects[0].tickets[0].rows.find((r) => r.id === 'D1').user.answer, 'B');
  assert.equal(m.summary.decisions_blocking, 0);
  assert.equal(m.summary.decisions_open, 3);
});
