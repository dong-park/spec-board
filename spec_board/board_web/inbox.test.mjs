// node --test skills/spec/scripts/board_web/inbox.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const I = req('./inbox.js');
const V = req('./view.js');
const D = req('./decisions.js');

// ── 고정 데이터: 막는 결정 1(되돌리기 어려움), 쉬운 결정 1, 답은 했지만 반영 대기 1, 끝난 결정 1 · 확인 대기 2(하나는 통과를 남김) · 진행 1
const dec = (over) => ({
  id: 'D1', display_id: 'WM-D1', kind: 'decision', title: '결정', given: '', when: '', then: '',
  options: [{ key: 'A', label: '지나간 자리만', why: '' }, { key: 'B', label: '통째로', why: '' }],
  recommend: 'A', confidence: 'high', reversible: true, status: '아직 안 함', open: true, blocking: false,
  blocks: [], user: { answer: '', fix: '' }, blocked_nodes: [], blocked_node_ids: [], ticket: 'wm/t', project: 'wm', ...over,
});
const nodeOf = (over) => ({ key: 'n1', id: 'WM-1', title: '노드', state: '아직 안 함', column: '시작 가능', deps: [], waiting_on: [],
  blocked_by: [], blocked_by_ids: [], warnings: [], error: '', verdict: '', fix: '', evidence: [], ...over });
const MODEL = (extra) => {
  const decisions = [
    dec({ id: 'D2', display_id: 'WM-D2', title: '쉬운 결정' }),
    dec({ id: 'D1', display_id: 'WM-D1', title: '막는 결정', reversible: false, blocking: true, blocked_nodes: ['n3'], blocked_node_ids: ['WM-3'] }),
    dec({ id: 'D3', display_id: 'WM-D3', title: '답함 반영 대기', user: { answer: 'B', fix: '' } }),
    dec({ id: 'D4', display_id: 'WM-D4', title: '끝난 결정', open: false, status: '끝남', user: { answer: 'A', fix: '' } }),
  ];
  return {
    root: '/x/demo', workspace: 'demo', local: false,
    summary: { decisions_open: 3, decisions_blocking: 1, to_check: 2 },
    projects: [{ key: 'wm', title: '유리벽 — 문제', state: '진행', tickets: [{
      slug: 'wm/t', title: '마카', counts: {}, rows: decisions,
      nodes: [
        nodeOf({ key: 'n1', id: 'WM-1', title: '마카 들기', state: '확인 대기', column: '확인 대기', verdict: '통과', evidence: ['a.png'] }),
        nodeOf({ key: 'n2', id: 'WM-2', title: '지우개', state: '확인 대기', column: '확인 대기', evidence: ['b.png', 'c.png'] }),
        nodeOf({ key: 'n3', id: 'WM-3', title: '모양', state: '막힘', column: '기다림', blocked_by: ['D1'], blocked_by_ids: ['WM-D1'] }),
        nodeOf({ key: 'n4', id: 'WM-4', title: '진행 중', state: '진행', column: '진행' }),
      ],
    }] }],
    ...(extra || {}),
  };
};

// 가짜 fetch — 호출을 모으고 준비한 응답을 차례로 준다
const fakeFetch = (...replies) => {
  const calls = [];
  const fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: (init && init.method) || 'GET', body });
    const r = replies.shift() || { status: 200, json: { ok: true, user: body && body.user ? { ...body.user } : {} } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
  };
  return { fetch, calls };
};
const make = (model, ...replies) => {
  const f = fakeFetch(...replies);
  let draws = 0;
  const ctl = I.controller({ getModel: () => model, fetch: f.fetch, redraw: () => { draws += 1; } });
  return { ctl, calls: f.calls, draws: () => draws };
};

// 링크 검사용 — 아이콘 스프라이트(안 쓰는 i-board 등 심볼 id 포함)와 <use href> 참조는 이동 길이 아니다
const nav = (html) => html.replace(/<svg class="sprite"[\s\S]*?<\/defs><\/svg>/, '').replace(/<use href="#[a-z-]+"\/>/g, '');

// ── 목록
test('목록은 열린 결정과 확인 대기 노드이고 사이드바 Inbox 숫자와 같다', () => {
  const m = MODEL();
  const it = I.items(m);
  assert.deepEqual(it.decisions.map((x) => x.d.id), ['D1', 'D2'], '막는 결정 → 답 없음. 답한 D3은 에이전트 차례라 빠진다');
  assert.deepEqual(it.decisions.map((x) => x.blocking), [true, false]);
  assert.deepEqual(it.checks.map((x) => x.n.key), ['n2'], '통과를 남긴 n1은 빠진다');
  assert.equal(I.count(m), 3);
  const side = V.sidebar(m, { view: 'inbox' });
  assert.match(side, /Inbox<\/span><span class="c">3<\/span>/, '사이드바 숫자도 같은 셈');
});

test('끝난 결정·진행·막힘 노드는 Inbox에 없다', () => {
  const html = I.html(MODEL(), {});
  assert.doesNotMatch(html, /끝난 결정|진행 중|data-in-key="n3"|data-in-key="n4"/);
});

test('할 일이 없으면 빈 안내 한 줄이다', () => {
  const m = MODEL();
  m.projects[0].tickets[0].rows = []; m.projects[0].tickets[0].nodes = [];
  const html = I.html(m, {});
  assert.match(html, /data-empty/);
  assert.doesNotMatch(html, /<button/);
});

// ── 어디서 열든 같은 전체 보드 — 원격(tailnet) 요청도 사이드바와 해시가 가리킨 화면을 그린다
test('원격 요청도 사이드바가 있는 전체 보드를 그리고 해시대로 간다', () => {
  const m = { ...MODEL(), local: false };
  for (const [hash, mark] of [['', /data-inbox/], ['#inbox', /data-inbox/], ['#wm/board', /class="board/], ['#wm/wave', /class="wgrid/]]) {
    const html = V.page(m, V.parseHash(hash), {});
    assert.match(html, /class="side/, `${hash}: 사이드바`);
    assert.match(html, mark, `${hash}: 해시가 가리킨 화면`);
  }
});

test('폰 모드 결정 줄에는 선택지 버튼이, 확인 대기 줄에는 통과·고쳐줘 버튼이 있다', () => {
  const html = I.html(MODEL(), {});
  const row = (id) => html.match(new RegExp(`<div class="irow[^"]*" data-in="dec"[^>]*data-in-dec="${id}">[\\s\\S]*?</div></div>`))[0];
  const d2 = row('WM-D2');
  assert.equal((d2.match(/data-in-pick/g) || []).length, 2, '선택지 둘 → 버튼 둘');
  assert.match(d2, /data-in-key="A"[^>]*>[^<]*A 지나간 자리만<span class="tag">추천<\/span>/, '추천 표시');
  assert.match(d2, /data-in-key="B"[^>]*>B 통째로<\/button>/);

  const chk = html.match(/<div class="irow is-rev" data-in="chk"[^>]*data-in-key="n2">[\s\S]*?(?=<div class="irow|$)/)[0];
  assert.match(chk, /data-in-pass[^>]*>통과<\/button>/);
  assert.match(chk, /data-in-fix[^>]*>고쳐줘<\/button>/);
  assert.match(chk, /근거 2개/);
});

test('이미 답한 결정·통과를 남긴 확인은 Inbox에서 빠지고, Decisions에서는 답이 보인다', () => {
  const m = MODEL();
  const html = I.html(m, {});
  assert.doesNotMatch(html, /data-in-dec="WM-D3"|data-in-key="n1"/);
  assert.match(D.menu(m), /data-dec="WM-D3"[\s\S]*?✓ B/, '답을 바꾸려면 Decisions(또는 시트 결정 탭)에서');
});

test('버튼·줄은 다른 모달이 위임으로 듣는 속성을 달지 않는다 — 누르면 티켓·노드 모달이 같이 열린다', () => {
  const st = { armed: { ticket: 'wm/t', display: 'WM-D1', key: 'A' }, fixing: { ticket: 'wm/t', key: 'n2' }, draft: 'x' };
  const html = I.html(MODEL(), { state: st });
  // 결정 모달을 여는 제목(data-dec + data-ticket)만 예외다 — view.js가 그 클릭을 먼저 가져가 전파를 멈춘다
  // 확인 줄 본문(.iopen)은 노드 모달을 여는 곳이라 data-nm-open·data-tkt를 단다 — 버튼에는 달지 않는다
  const rest = html.replace(/<b class="it"[^>]*data-dec=[^>]*>/g, '<b class="it">')
    .replace(/<div class="iopen" data-nm-open data-tkt="[^"]*" data-key="[^"]*" data-ws="[^"]*"/g, '<div class="iopen"');
  assert.doesNotMatch(rest, /data-ticket=|data-act=|data-nm=|data-tkt=/);
  assert.doesNotMatch(rest, /\sclass="[^"]*\bcard\b/, '.card가 아니다 — 노드 모달이 줄을 카드로 오인하지 않는다');
});

test('로컬과 원격 Inbox는 같은 줄을 쓴다', () => {
  const m = MODEL();
  const rows = (h) => (h.match(/data-in="(?:dec|chk)"[^>]*>/g) || []);
  const desk = V.stage({ ...m, local: true }, { view: 'inbox' });
  const remote = V.page({ ...m, local: false }, { view: 'inbox' }, {});
  assert.deepEqual(rows(desk), rows(remote));
  assert.equal(rows(desk).length, 3);
});

// ── 컨트롤러: 쓰는 칸과 요청 수
test('되돌리기 쉬운 결정은 선택지를 누르면 user.answer 하나만 쓰고 끝난다', async () => {
  const m = MODEL();
  const t = make(m);
  const r = await t.ctl.pick('wm/t', 'WM-D2', 'B');
  assert.equal(r.ok, true);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0], {
    url: '/w/demo/api/user', method: 'POST',
    body: { sheet: 'wm/t', id: 'D2', user: { answer: 'B' }, base: { answer: '' } },
  });
  assert.equal(D.answerOf(D.list(m).find((d) => d.id === 'D2')), 'B', '화면 모델에 바로 반영');
  assert.equal(t.ctl.state.busy, '');
});

test('되돌리기 어려운 결정은 한 번 눌러 고르고 답하기를 눌러야 쓴다. 취소는 요청이 0이다', async () => {
  const m = MODEL();
  const t = make(m);
  const first = await t.ctl.pick('wm/t', 'WM-D1', 'A');
  assert.equal(first.armed, true);
  assert.equal(t.calls.length, 0, '첫 누름은 쓰지 않는다');
  assert.match(I.html(m, { state: t.ctl.view() }), /data-in-send/, '답하기가 나타난다');

  t.ctl.unarm();
  assert.equal(t.calls.length, 0);
  assert.doesNotMatch(I.html(m, { state: t.ctl.view() }), /data-in-send/);

  await t.ctl.pick('wm/t', 'WM-D1', 'B');
  await t.ctl.pick('wm/t', 'WM-D1', 'A'); // 다른 선택지를 다시 누르면 그쪽으로 바뀐다
  assert.equal(t.calls.length, 0);
  const r = await t.ctl.sendArmed();
  assert.equal(r.ok, true);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0].body.user, { answer: 'A' });
  assert.equal(t.ctl.state.armed, null);
});

test('같은 답을 다시 눌러도 요청이 없고, 닫힌 결정은 못 건드린다', async () => {
  const m = MODEL();
  const t = make(m);
  assert.equal((await t.ctl.pick('wm/t', 'WM-D3', 'B')).same, true);
  assert.equal((await t.ctl.pick('wm/t', 'WM-D4', 'B')).reason, 'closed');
  assert.equal(t.calls.length, 0);
});

test('다른 곳에서 먼저 답했으면 409 안내를 그 줄에 보이고 서버 값을 받는다', async () => {
  const m = MODEL();
  const t = make(m, { status: 409, json: { error: 'conflict', user: { answer: 'A', fix: '' } } });
  const r = await t.ctl.pick('wm/t', 'WM-D2', 'B');
  assert.equal(r.conflict, true);
  assert.equal(D.answerOf(D.list(m).find((d) => d.id === 'D2')), 'A', '서버 값을 받았다');
  const html = I.html(m, { state: t.ctl.view() });
  assert.match(html, /class="inote is-err"[^>]*>다른 곳에서 먼저 바꿨어요/, '서버 값으로 답이 생겨도 안내가 떠 있는 동안은 줄이 남는다');
  assert.match(html, /data-in-dec="WM-D2"[^>]*data-in-key="A"[^>]*aria-pressed="true"/);
});

test('저장 실패(서버 오류)는 줄에 안내가 남고 답은 그대로다', async () => {
  const m = MODEL();
  const t = make(m, { status: 500, json: {} });
  const r = await t.ctl.pick('wm/t', 'WM-D2', 'B');
  assert.equal(r.ok, false);
  assert.equal(D.answerOf(D.list(m).find((d) => d.id === 'D2')), '');
  assert.match(I.html(m, { state: t.ctl.view() }), /저장하지 못했어요/);
});

test('통과는 verdict 하나만 쓴다 — 상태 칸은 안 건드린다', async () => {
  const m = MODEL();
  const t = make(m);
  await t.ctl.pass('wm/t', 'n2');
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].url, '/w/demo/api/node');
  assert.deepEqual(t.calls[0].body, { sheet: 'wm/t', id: 'n2', user: { verdict: '통과' }, base: { verdict: '', fix: '' } });
  const n = m.projects[0].tickets[0].nodes.find((x) => x.key === 'n2');
  assert.equal(n.verdict, '통과');
  assert.equal(n.state, '확인 대기', '저장 상태는 그대로 — 반영은 에이전트 몫');
});

test('고쳐줘: 취소하면 요청이 0이고, 보내면 verdict·fix 둘만 쓴다', async () => {
  const m = MODEL();
  const t = make(m);
  t.ctl.startFix('wm/t', 'n2');
  assert.match(I.html(m, { state: t.ctl.view() }), /data-in-draft/);
  t.ctl.setDraft('손잡이가 안 보여요');
  t.ctl.cancelFix();
  assert.equal(t.calls.length, 0);
  assert.equal(t.ctl.state.fixing, null);
  assert.doesNotMatch(I.html(m, { state: t.ctl.view() }), /data-in-draft/);

  t.ctl.startFix('wm/t', 'n2');
  await t.ctl.sendFix(); // 비어 있다
  assert.equal(t.calls.length, 0);
  assert.match(I.html(m, { state: t.ctl.view() }), /고칠 내용을 적어 주세요/);

  t.ctl.setDraft('  손잡이가 안 보여요  ');
  await t.ctl.sendFix();
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0].body.user, { verdict: '고쳐줘', fix: '손잡이가 안 보여요' });
  assert.equal(t.ctl.state.fixing, null, '보낸 뒤 입력이 닫힌다');
  const n = m.projects[0].tickets[0].nodes.find((x) => x.key === 'n2');
  assert.equal(n.fix, '손잡이가 안 보여요');
});

test('고쳐줘 보내기가 409면 입력은 열려 있고 안내가 보인다', async () => {
  const m = MODEL();
  const t = make(m, { status: 409, json: { error: 'conflict', user: { verdict: '통과', fix: '' } } });
  t.ctl.startFix('wm/t', 'n2');
  t.ctl.setDraft('다시 해줘');
  await t.ctl.sendFix();
  assert.ok(t.ctl.state.fixing, '입력이 남아 있다');
  assert.match(I.html(m, { state: t.ctl.view() }), /다른 곳에서 먼저 바꿨어요/);
});

// ── 실경로: 진짜 sheet.py가 /board/로 화면을 내고, tailnet 요청은 폰 Inbox가 되고, 답이 파일에 쓰인다
const hasPython = spawnSync('python3', ['--version']).status === 0;
// 사람 칸은 레포 밖 저장소에 있다 — 테스트는 임시 저장소를 쓰고, 파일 경로는 spec_model에게 묻는다
const STORE = mkdtempSync(join(tmpdir(), 'spec-board-store-'));
const storeFile = (ticketDir, kind, key) => spawnSync('python3', ['-c',
  'import sys; sys.path.insert(0, sys.argv[1]); import spec_model as m; from pathlib import Path; t = Path(sys.argv[2]); ' +
  'print(m.node_file(t, sys.argv[4]) if sys.argv[3] == "node" else m.ticket_file(t))',
  join(here, '..'), ticketDir, kind, key || ''], { env: { ...process.env, SPEC_BOARD_STORE: STORE }, encoding: 'utf8' }).stdout.trim();

const free = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const tmp = mkdtempSync(join(tmpdir(), 'inboxtest-'));
let server;
after(() => { if (server) server.kill(); rmSync(tmp, { recursive: true, force: true }); });

function seedRepo() {
  const t = join(tmp, 'spec', 'g', 't');
  mkdirSync(join(t, 'rows'), { recursive: true });
  writeFileSync(join(tmp, 'spec', 'g', 'README.md'), '# 줄기\n\n| 항목 | 값 |\n|---|---|\n| 종류 | 줄기 |\n| 문제 | 줄기 문제 |\n| 상태 | 진행 |\n');
  writeFileSync(join(t, 'spec.md'),
    '# 데모 티켓\n\n| 항목 | 값 |\n|---|---|\n| 문제 | 데모 |\n| 상태 | 진행 |\n| ID 머리 | DM |\n\n## 노드 인덱스\n\n' +
    '| ID | 브리프 | deps | 상태 |\n|---|---|---|---|\n| n1 | [n1-demo.md](n1-demo.md) | — | 확인 대기 |\n');
  writeFileSync(join(t, 'n1-demo.md'),
    '# n1-demo — 데모\n\n**agent**: runner\n**id**: DM-1\n**상위**: spec/g/t/spec.md\n**deps**: 없음\n**상태**: 확인 대기\n**담당 행**: T1\n\n## 문제\n\n데모.\n');
  const base = { kind: 'decision', given: 'g', when: 'w', then: 't', options: [{ key: 'A', label: '하나', why: '' }, { key: 'B', label: '둘', why: '' }],
    recommend: 'A', confidence: 'high', status: '아직 안 함', user: { answer: '', fix: '' }, log: [] };
  writeFileSync(join(t, 'rows', 'D1.json'), JSON.stringify({ ...base, id: 'D1', title: '쉬운 결정', reversible: true, blocks: [] }));
  return t;
}

// node:http는 Host를 바꿀 수 있다 — tailscale serve가 127.0.0.1로 넘겨 온 요청을 흉내 낸다
const getAs = (port, path, host) => new Promise((res, rej) => {
  const r = request({ host: '127.0.0.1', port, path, headers: { Host: host } }, (resp) => {
    let b = ''; resp.on('data', (c) => { b += c; }); resp.on('end', () => res({ status: resp.statusCode, body: b }));
  });
  r.on('error', rej); r.end();
});

test('실경로: /board/로 화면이 나가고 tailnet 요청은 폰 Inbox가 되며 답과 통과가 파일에 쓰인다', { skip: !hasPython }, async () => {
  const ticket = seedRepo();
  const port = await free();
  server = spawn('python3', [join(here, '..', 'sheet.py'), '--port', String(port), tmp], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SPEC_SHEET_HOSTS: 'box.example.ts.net', SPEC_BOARD_STORE: STORE } });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('서버가 안 떴다')), 8000);
    server.stdout.on('data', (b) => { if (String(b).includes(`http://127.0.0.1:${port}/`)) { clearTimeout(t); res(); } });
    let err = '';
    server.stderr.on('data', (b) => { err += b; });
    server.on('exit', (c) => rej(new Error(`서버 종료 ${c}: ${err.slice(-300)}`)));
  });
  const origin = `http://127.0.0.1:${port}`;
  const ws = tmp.split('/').pop();

  // 폰이 여는 주소 — 화면의 스크립트·스타일이 전부 서버에서 받아진다
  const page = await (await fetch(`${origin}/board/`)).text();
  const srcs = [...page.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  assert.ok(srcs.includes('inbox.js') && srcs.includes('view.js'));
  for (const s of srcs) {
    const r = await fetch(`${origin}/board/${s}`);
    assert.equal(r.status, 200, s);
    assert.ok(existsSync(join(here, s)), `${s} 파일이 board_web에 있다`);
  }
  assert.equal((await fetch(`${origin}/board/../sheet.py`)).status, 404);
  assert.equal((await fetch(`${origin}/w/${encodeURIComponent(ws)}/board/`)).status, 200);

  // tailnet 쪽 요청: local이 false여도 전체 보드다 (세션 버튼만 숨는다)
  const remote = await getAs(port, `/api/board?w=${encodeURIComponent(ws)}`, 'box.example.ts.net:8443');
  const model = JSON.parse(remote.body);
  assert.equal(model.local, false);
  assert.match(V.page(model, V.parseHash('#g/board'), {}), /class="side/);
  const html = V.page(model, V.parseHash('#inbox'), {});
  assert.match(html, /data-in-dec="DM-D1"/);
  assert.match(html, /data-in="chk"[^>]*data-in-key="n1"/);

  // 줄의 버튼으로 답하고 통과를 누른다 — 쓰는 칸은 user.answer, user.verdict뿐이다
  const ctl = I.controller({
    getModel: () => model, redraw: () => {},
    fetch: (u, i) => fetch(origin + u, i),
  });
  assert.equal((await ctl.pick('g/t', 'DM-D1', 'B')).ok, true);
  const d1 = JSON.parse(readFileSync(join(ticket, 'rows', 'D1.json'), 'utf8'));
  assert.equal(d1.user.answer, 'B');
  assert.equal(d1.status, '아직 안 함', '상태 칸은 화면이 쓰지 않는다');

  await ctl.pass('g/t', 'n1');
  const nf = JSON.parse(readFileSync(storeFile(ticket, 'node', 'n1'), 'utf8'));
  assert.equal(nf.user.verdict, '통과');
  assert.match(readFileSync(join(ticket, 'n1-demo.md'), 'utf8'), /\*\*상태\*\*: 확인 대기/, '브리프 상태는 그대로');

  // 다시 읽은 모델: 답·통과가 파일에 남아 Inbox에서는 빠지고 Decisions에는 답이 보인다
  const again = JSON.parse((await getAs(port, `/api/board?w=${encodeURIComponent(ws)}`, 'box.example.ts.net:8443')).body);
  const html2 = I.html(again, {});
  assert.doesNotMatch(html2, /data-in-dec="DM-D1"|data-in-key="n1"/);
  assert.match(D.menu(again), /data-dec="DM-D1"[\s\S]*?✓ B/);
});

// ── 확인 카드: 본문 열기 · 썸네일 · 확인할 것 N개
test('확인 카드: 본문이 노드 모달을 열고, 첫 근거 이미지 썸네일과 확인할 것 N개가 보인다', () => {
  const m = MODEL();
  const n2 = m.projects[0].tickets[0].nodes.find((n) => n.key === 'n2');
  n2.checks = { intro: '안내', items: ['하나', '둘', '셋'] };
  n2.evidence = ['notes.txt', 'b.png', 'c.png'];
  const html = I.html(m, {});
  const chk = html.match(/<div class="irow is-rev" data-in="chk"[^>]*data-in-key="n2">[\s\S]*?(?=<div class="irow|$)/)[0];
  assert.match(chk, /<div class="iopen" data-nm-open data-tkt="wm\/t" data-key="n2" data-ws="demo" role="button" tabindex="0">/);
  assert.match(chk, /확인할 것 3개 · 근거 3개/);
  assert.match(chk, /<img class="in-th" src="\/w\/demo\/api\/evidence\?sheet=wm%2Ft&amp;id=n2&amp;name=b\.png"/);
  assert.equal((chk.match(/<img/g) || []).length, 1, '첫 이미지 하나만');
  // 버튼은 본문 밖이다 — 눌러도 모달이 같이 열리지 않는다
  const open = chk.match(/<div class="iopen"[\s\S]*?<\/div><img[^>]*><\/div>/)[0];
  assert.doesNotMatch(open, /<button/);
  assert.doesNotMatch(chk.replace(open, ''), /data-nm-open|data-tkt=/);
});

test('확인 카드: 확인할 것도 이미지도 없으면 메타·썸네일이 없다', () => {
  const m0 = MODEL();
  m0.projects[0].tickets[0].nodes.find((x) => x.key === 'n2').evidence = [];
  const html = I.html(m0, {});
  const n2 = html.match(/<div class="irow is-rev" data-in="chk"[^>]*data-in-key="n2">[\s\S]*?(?=<div class="irow|$)/)[0];
  assert.doesNotMatch(n2, /확인할 것 \d|근거|<img/);
  const bare = MODEL();
  delete bare.workspace;
  assert.doesNotMatch(I.html(bare, {}), /<img/, '워크스페이스를 모르면 주소를 못 만든다');
});

test('고쳐줘 입력은 여러 줄이고, 줄바꿈 그대로 한 번에 보낸다', async () => {
  const m = MODEL();
  const t = make(m);
  t.ctl.startFix('wm/t', 'n2');
  assert.match(I.html(m, { state: t.ctl.view() }), /<textarea class="in-fix"[^>]*data-in-draft/);
  t.ctl.setDraft('첫 줄\n둘째 줄');
  await t.ctl.sendFix();
  assert.equal(t.calls[0].body.user.fix, '첫 줄\n둘째 줄');
});



// ── 모든 레포 Inbox: 워크트리 둘에 같은 시트·같은 결정 id가 있어도 누른 줄의 레포에만 쓴다
const GLOBAL = () => {
  const part = (ws) => {
    const m = MODEL();
    const p = m.projects[0];
    p.tickets[0].workspace = ws; p.tickets[0].repo = 'demo';
    return { ...p, workspace: ws, repo: 'demo' };
  };
  return { global: true, workspace: '', projects: [part('demo-a'), part('demo-b')] };
};
const rowOf = (g, ws, id) => g.projects.find((p) => p.workspace === ws).tickets[0].rows.find((r) => r.id === id);

test('모든 레포: 같은 시트·결정이 두 워크트리에 있으면 누른 줄의 레포로 쓰고 그 줄만 바뀐다', async () => {
  const g = GLOBAL();
  const t = make(g);
  const h = I.html(g, { state: t.ctl.view() });
  assert.match(h, /<a class="where" href="\/w\/demo-b\/board\/#s\/wm\/t" data-ws="demo-b" data-hash="#s\/wm\/t"[^>]*>demo-b<\/a>/);
  const r = await t.ctl.pick('wm/t', 'WM-D2', 'B', 'demo-b');
  assert.equal(r.ok, true);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].url, '/w/demo-b/api/user');
  assert.equal(rowOf(g, 'demo-b', 'D2').user.answer, 'B');
  assert.equal(rowOf(g, 'demo-a', 'D2').user.answer, '', '다른 워크트리의 같은 결정은 그대로');

  await t.ctl.pass('wm/t', 'n2', 'demo-a');
  assert.equal(t.calls[1].url, '/w/demo-a/api/node');
  const nodeIn = (ws) => g.projects.find((p) => p.workspace === ws).tickets[0].nodes.find((n) => n.key === 'n2');
  assert.equal(nodeIn('demo-a').verdict, '통과');
  assert.equal(nodeIn('demo-b').verdict, '');
});

test('추천대로 답하기: 되돌리기 쉽고 답 없는 결정만, 그 레포·시트에만 쓴다', async () => {
  const g = GLOBAL();
  const rows = g.projects[0].tickets[0].rows;
  rows.push(dec({ id: 'D5', display_id: 'WM-D5', title: '쉬운 결정 둘', recommend: 'B' }));
  const t = make(g);
  const h = I.html(g, { state: t.ctl.view() });
  // demo-a에는 쉬운 결정이 둘(D2·D5)이라 한 번에 답하는 줄이 있고, 하나뿐인 demo-b에는 없다
  assert.match(h, /data-in-bulk data-in-ws="demo-a" data-in-ticket="wm\/t"[^>]*>추천대로 2개 답하기/);
  assert.doesNotMatch(h, /data-in-bulk data-in-ws="demo-b"/);
  const r = await t.ctl.bulk('wm/t', 'demo-a');
  assert.deepEqual(r, { ok: true, done: 2 });
  assert.deepEqual(t.calls.map((c) => [c.url, c.body.id, c.body.user.answer]),
    [['/w/demo-a/api/user', 'D2', 'A'], ['/w/demo-a/api/user', 'D5', 'B']]);
  assert.equal(rowOf(g, 'demo-a', 'D1').user.answer, '', '되돌리기 어려운 결정은 건드리지 않는다');
  assert.equal(rowOf(g, 'demo-b', 'D2').user.answer, '');
});

test('추천대로 답하기: 하나가 실패하면 거기서 멈추고 줄에 알린다', async () => {
  const g = GLOBAL();
  g.projects[0].tickets[0].rows.push(dec({ id: 'D5', display_id: 'WM-D5', title: '쉬운 결정 둘' }));
  const t = make(g, { status: 500, json: {} });
  const r = await t.ctl.bulk('wm/t', 'demo-a');
  assert.deepEqual(r, { ok: false, done: 0 });
  assert.equal(t.calls.length, 1);
  assert.match(I.html(g, { state: t.ctl.view() }), /WM-D2에서 멈췄어요/);
});



test('결정 없이 막힌 노드: 사유가 없으면 이유 물어보기, 에이전트 사유가 있으면 그 사유와 방향 답하기, 사람이 마지막이면 숨김', () => {
  const m = MODEL();
  const nodes = m.projects[0].tickets[0].nodes;
  nodes.push(nodeOf({ key: 'n9', id: 'WM-9', title: '사유 없음', state: '막힘', column: '기다림' }));
  nodes.push(nodeOf({ key: 'n8', id: 'WM-8', title: '사람 차례', state: '막힘', column: '기다림', comments: [
    { id: 'c1', by: 'agent', at: '2026-10-15 11:18', text: '막힘 사유: 공식 페이지에 수분이 없습니다.\n풀려면: 포장지 사진' }] }));
  nodes.push(nodeOf({ key: 'n7', id: 'WM-7', title: '에이전트 차례', state: '막힘', column: '기다림', comments: [
    { id: 'c1', by: 'agent', at: '2026-10-15 11:18', text: '사유' }, { id: 'c2', by: 'user', at: '2026-10-15 13:51', text: '환산에 써보자', reply_to: 'c1' }] }));
  const it = I.items(m);
  assert.deepEqual(it.stuck.map((x) => x.n.id), ['WM-9', 'WM-8'], '사람이 마지막으로 답한 WM-7은 에이전트 차례라 빠진다');
  assert.equal(I.count(m), it.decisions.length + it.checks.length + 2);
  const h = I.html(m, {});
  assert.match(h, /막힘 · 방향이 필요해요 <span class="n">2<\/span>/);
  const row9 = h.match(/data-in="stuck"[^>]*data-in-key="n9">[\s\S]*?(?=<div class="irow|$)/)[0];
  assert.match(row9, /사유가 남아 있지 않아요/);
  assert.match(row9, /data-in-ask[^>]*>이유 물어보기/);
  const row8 = h.match(/data-in="stuck"[^>]*data-in-key="n8">[\s\S]*?(?=<div class="irow|$)/)[0];
  assert.match(row8, /<b>사유<\/b> 막힘 사유: 공식 페이지에 수분이 없습니다\.</, '첫 줄만');
  assert.match(row8, /data-in-note[^>]*data-in-reply="c1"[^>]*>방향 답하기/);
  assert.match(row8, /<div class="iopen" data-nm-open data-tkt="wm\/t" data-key="n8" data-ws="demo"/);
});

test('막힘: 이유 물어보기·방향 답하기는 댓글 하나를 보내고(방향은 사유 스레드에 답글) 줄이 바로 빠진다', async () => {
  const m = MODEL();
  const nodes = m.projects[0].tickets[0].nodes;
  nodes.push(nodeOf({ key: 'n9', id: 'WM-9', title: '사유 없음', state: '막힘', column: '기다림' }));
  nodes.push(nodeOf({ key: 'n8', id: 'WM-8', title: '사람 차례', state: '막힘', column: '기다림', comments: [{ id: 'c1', by: 'agent', at: 'x', text: '사유' }] }));
  const reply = (body) => ({ status: 200, json: { ok: true, comments: [...(body.prev || []), { id: 'u1', by: 'user', at: 'y', text: 't', ...(body.reply_to ? { reply_to: body.reply_to } : {}) }] } });
  const t = make(m, reply({}), reply({ prev: [{ id: 'c1', by: 'agent', at: 'x', text: '사유' }], reply_to: 'c1' }));
  await t.ctl.ask('wm/t', 'n9');
  assert.equal(t.calls[0].url, '/w/demo/api/comment');
  assert.equal(t.calls[0].body.id, 'n9');
  assert.match(t.calls[0].body.comment.text, /왜 막혔는지/);
  t.ctl.startNote('wm/t', 'n8', '', 'c1');
  assert.match(I.html(m, { state: t.ctl.view() }), /data-in-note-draft/);
  assert.deepEqual(await t.ctl.sendNote(), { ok: false }, '빈 글은 안 보낸다');
  t.ctl.setNoteDraft('환산에 써보자');
  await t.ctl.sendNote();
  assert.deepEqual(t.calls[1].body.comment, { text: '환산에 써보자', reply_to: 'c1' });
  assert.deepEqual(I.items(m).stuck.map((x) => x.n.id), [], '둘 다 사람이 마지막이라 빠졌다');
});

