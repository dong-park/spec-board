// node --test skills/spec/scripts/board_web/ticket_modal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const M = require('./ticket_modal.js');
const V = require('./view.js');
const scripts = join(here, '..');

// ── 픽스처: 시나리오 8개 중 1개 통과, 1개는 어느 노드도 안 맡음
const row = (id, over) => ({
  id, kind: 'task', title: `행 ${id}`, given: `조건 ${id}`, when: `행동 ${id}`, then: `결과 ${id}`,
  status: '아직 안 함', owners: [], ...over,
});
const node = (key, over) => ({
  key, id: `WM-${key.slice(1)}`, title: `노드 ${key}`, state: '아직 안 함', column: '시작 가능', rows: [], ...over,
});
const NODES = [
  node('n1', { state: '끝남', column: '끝남', rows: ['T1'] }),
  node('n2', { state: '진행', column: '진행', rows: ['T2', 'T3'] }),
  node('n3', { state: '막힘', column: '기다림', rows: ['T4'] }),
  node('n4', { rows: ['T5'] }),
  node('n5', { state: '확인 대기', column: '확인 대기', rows: ['T6'] }),
  node('n6', { rows: ['T7'] }),
];
const ROWS = [
  row('T1', { owners: ['n1'] }),
  row('T2', { owners: ['n2'] }), row('T3', { owners: ['n2'] }),
  row('T4', { owners: ['n3'] }), row('T5', { owners: ['n4'] }), row('T6', { owners: ['n5'] }),
  row('T7', { owners: ['n6'] }),
  row('T8', { owners: [] }),
];
const TICKET = {
  slug: 'glass-wall/wall-marker', title: 'wall-marker — 펜이 메모 안에서만 그려져 벽에 바로 못 쓴다',
  problem: '펜이 메모 안에서만 그려져 벽에 바로 못 쓴다', state: '진행', priority: 'P0', id_head: 'WM', project: 'glass-wall',
  paused: false, head: { 문제: '펜이 메모 안에서만 그려져 벽에 바로 못 쓴다', 'ID 머리': 'WM' },
  spec_md: '# wall-marker\n\n| 문제 | 펜 |\n', nodes: NODES, rows: ROWS,
};
const PROJECT = { key: 'glass-wall', title: '유리벽 — 마카로 쓰고 포스트잇을 붙이는 개인 사고판' };
const ticket = (over) => ({ ...TICKET, ...over });
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const count = (html, re) => (html.match(re) || []).length;

// ── T16: 시나리오 x/y와 담당 없음
test('8개 중 1개 통과면 "시나리오 1 / 8 통과"가 보인다', () => {
  const html = M.render(TICKET, { project: PROJECT });
  assert.match(text(html), /시나리오 1 \/ 8 통과/);
  assert.equal(count(html, /<li class="tm-sc\b/g), 8);
});

test('안 맡은 시나리오 줄 끝에만 "담당 없음"이 한 번 보인다', () => {
  const html = M.render(TICKET, { project: PROJECT });
  assert.equal(count(html, /담당 없음/g), 1);
  assert.equal(count(html, /class="tm-sc[^"]*is-unowned"/g), 1);
  const line = html.match(/<li class="tm-sc[^"]*is-unowned"[^>]*>.*?<\/li>/s)[0];
  assert.match(line, /data-row="T8"/);
  assert.match(line, /<span class="tm-end"><span class="tm-none">담당 없음<\/span><\/span>/);
});

test('맡은 시나리오는 줄 끝에 노드 ID를 보인다', () => {
  const line = M.render(TICKET, { project: PROJECT }).match(/<li class="tm-sc[^"]*"[^>]*data-row="T2".*?<\/li>/s)[0];
  assert.match(line, /<span class="tm-own">WM-2<\/span>/);
  assert.doesNotMatch(line, /담당 없음/);
});

test('통과 = 맡은 노드 전부 끝남 — 하나라도 남으면 통과가 아니다', () => {
  const nodes = [node('n1', { state: '끝남', column: '끝남' }), node('n2', { state: '진행', column: '진행' })];
  const t = ticket({ nodes, rows: [row('T1', { owners: ['n1', 'n2'] }), row('T2', { owners: ['n1'] })] });
  const s = M.scenarios(t);
  assert.deepEqual(s.items.map((i) => i.passed), [false, true]);
  assert.equal(s.passed, 1);
});

test('행 상태가 끝남이면 노드와 상관없이 통과다', () => {
  const t = ticket({ nodes: [], rows: [row('T1', { status: '끝남', owners: [] })] });
  assert.equal(M.scenarios(t).passed, 1);
});

test('노드가 있어도 안 맡은 시나리오는 통과가 아니다 (티켓 끝은 시나리오 전부 통과)', () => {
  const s = M.scenarios(ticket({ nodes: [node('n1', { state: '끝남', column: '끝남' })], rows: [row('T1', { owners: [] })] }));
  assert.equal(s.passed, 0);
  assert.equal(s.items[0].unowned, true);
});

test('owners가 없는 행은 노드의 담당 행 목록에서 거꾸로 찾는다', () => {
  const rows = [row('T1'), row('T2')];
  for (const r of rows) delete r.owners;
  const t = ticket({ rows, nodes: [node('n1', { state: '끝남', column: '끝남', rows: ['T1'] })] });
  const s = M.scenarios(t);
  assert.deepEqual(s.items.map((i) => [i.passed, i.unowned]), [[true, false], [false, true]]);
});

test('결정 행은 시나리오에 세지 않는다', () => {
  const t = ticket({ rows: [...ROWS, { id: 'D1', kind: 'decision', title: '결정', status: '아직 안 함', open: true, blocking: true }] });
  assert.match(text(M.render(t, {})), /시나리오 1 \/ 8 통과/);
});

// ── T16: 버튼
test('노드가 0이면 주 버튼은 "노드로 나누기"이고 "Waves에서 보기"는 없다', () => {
  const html = M.render(ticket({ nodes: [], rows: [row('T1')] }), { project: PROJECT });
  assert.match(html, /data-act="split">노드로 나누기</);
  assert.doesNotMatch(html, /Waves에서 보기/);
  assert.match(text(html), /노드 0 \/ 0/);
});

test('노드가 있으면 주 버튼은 "Waves에서 보기"이고 "노드로 나누기"는 없다', () => {
  const html = M.render(TICKET, { project: PROJECT });
  assert.match(html, /data-act="waves">Waves에서 보기</);
  assert.doesNotMatch(html, /노드로 나누기/);
  assert.match(text(html), /노드 1 \/ 6/);
});

test('주 버튼은 .btn-primary 하나뿐이고 멈춤은 보조 버튼이다', () => {
  const html = M.render(TICKET, {});
  assert.equal(count(html, /class="btn-primary"/g), 1);
  assert.match(html, /class="tm-btn" data-act="pause" aria-pressed="false">멈춤</);
});

test('멈춘 티켓은 "멈춤 풀기"와 멈춤 표시가 나온다', () => {
  const html = M.render(ticket({ paused: true }), {});
  assert.match(html, /aria-pressed="true">멈춤 풀기</);
  assert.match(html, /class="tm-flag">멈춤</);
  assert.doesNotMatch(M.render(TICKET, {}), /tm-flag/);
});

// ── T16: 노드·막는 결정·spec.md
test('노드 목록은 화면 ID와 제목을 보인다', () => {
  const html = M.render(TICKET, {});
  assert.equal(count(html, /<li class="tm-nd"/g), 6);
  assert.match(html, /<span class="tm-rid">WM-3<\/span><span class="tm-nt">노드 n3<\/span>/);
});

test('막는 결정은 열린 것만, 노드를 막거나 답 없이 기다리는 것만 보인다', () => {
  const dec = (id, over) => ({ id, display_id: `WM-${id}`, kind: 'decision', title: `결정 ${id}`, status: '아직 안 함',
    open: true, blocking: false, blocked_nodes: [], ...over });
  const t = ticket({ rows: [...ROWS,
    dec('D1', { blocking: true }), dec('D2', { blocked_nodes: ['n3'] }),
    dec('D3', { open: false, status: '끝남', blocked_nodes: ['n3'] }), dec('D4')] });
  const html = M.render(t, {});
  const ids = [...html.matchAll(/<li class="tm-dc" data-row="(D\d)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['D1', 'D2']);
  assert.match(text(html), /막는 결정 2/);
  assert.doesNotMatch(M.render(TICKET, {}), /막는 결정/);
});

test('spec.md는 읽기 전용 <pre>이고 입력 요소가 없다', () => {
  const html = M.render(TICKET, {});
  assert.match(html, /<pre class="tm-pre"[^>]*># wall-marker/);
  assert.match(text(html), /spec\.md 읽기 전용/);
  assert.doesNotMatch(html, /<(textarea|input|select)[\s>]|contenteditable/i);
});

test('spec.md 전문이 없으면 머리 표로 대신한다', () => {
  const html = M.render(ticket({ spec_md: undefined }), {});
  assert.match(html, /\| ID 머리 \| WM \|/);
});

test('옆 칸에는 우선순위·프로젝트·ID 머리가 있다', () => {
  const side = M.render(TICKET, { project: PROJECT }).match(/<aside class="tm-side">.*?<\/aside>/s)[0];
  const t = text(side);
  assert.match(t, /우선순위 P0/);
  assert.match(t, /프로젝트 유리벽(?! —)/);
  assert.match(t, /ID 머리 WM-/);
});

test('문자는 이스케이프된다', () => {
  const t = ticket({ title: '<img src=x onerror=alert(1)>', problem: '"><script>x</script>', spec_md: '</pre><b>x</b>',
    rows: [row('T1', { given: '<i>g</i>' })] });
  const html = M.render(t, {});
  assert.doesNotMatch(html, /<img|<script|<b>x|<i>g/);
});

test('읽기 실패 티켓도 모달은 그려진다', () => {
  const html = M.render({ slug: 'a/b', title: 'b', error: '읽기 실패: OSError', nodes: [], rows: [], head: {} }, {});
  assert.match(html, /읽기 실패: OSError/);
  assert.match(text(html), /시나리오 0 \/ 0 통과/);
});

// ── 멈춤 저장: ticket.json user.paused만, 409면 남의 값
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('멈춤은 sheet·user.paused·base.paused를 /w/<w>/api/ticket에 보낸다', async () => {
  const calls = [];
  const r = await M.setPaused(TICKET, true, {
    w: 'demo repo', fetch: async (url, init) => { calls.push([url, JSON.parse(init.body), init.method]); return res(200, { ok: true, user: { paused: true } }); },
  });
  assert.deepEqual(r, { ok: true, paused: true });
  assert.equal(calls[0][0], '/w/demo%20repo/api/ticket');
  assert.equal(calls[0][2], 'POST');
  assert.deepEqual(calls[0][1], { sheet: 'glass-wall/wall-marker', user: { paused: true }, base: { paused: false } });
});

test('409면 "다른 곳에서 먼저 바꿨어요"와 서버 값을 돌려준다', async () => {
  const r = await M.setPaused(TICKET, true, { w: 'w', fetch: async () => res(409, { error: 'conflict', user: { priority: '', paused: true } }) });
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.equal(r.paused, true);
  assert.match(r.message, /다른 곳에서 먼저 바꿨어요/);
});

test('저장 실패는 지금 값을 그대로 두고 안내한다', async () => {
  const bad = await M.setPaused(TICKET, true, { w: 'w', fetch: async () => res(500, {}) });
  assert.deepEqual([bad.ok, bad.paused], [false, false]);
  assert.match(bad.message, /500/);
  const down = await M.setPaused(TICKET, true, { w: 'w', fetch: async () => { throw new Error('net'); } });
  assert.equal(down.ok, false);
  assert.match(down.message, /저장하지 못했어요/);
});

test('워크스페이스를 모르면 요청을 보내지 않는다', async () => {
  let n = 0;
  const r = await M.setPaused(TICKET, true, { w: '', fetch: async () => { n++; return res(200, {}); } });
  assert.equal(n, 0);
  assert.equal(r.ok, false);
});

test('멈춤 외에는 아무 칸도 쓰지 않는다 (보내는 user 키는 paused 하나)', async () => {
  let body;
  await M.setPaused(TICKET, false, { w: 'w', fetch: async (_u, i) => { body = JSON.parse(i.body); return res(200, { user: { paused: false } }); } });
  assert.deepEqual(Object.keys(body.user), ['paused']);
});

// ── 티켓 목록에서 누르면 열린다
test('티켓 목록의 제목줄에 data-ticket이 있어 모달을 열 수 있다', () => {
  const model = { projects: [{ key: 'glass-wall', title: '유리벽', state: '진행', tickets: [{ ...TICKET, counts: {} }] }] };
  const html = V.stage(model, { view: 'tickets', project: 'glass-wall' });
  assert.match(html, /<h2 class="gh" data-ticket="glass-wall\/wall-marker">/);
  assert.equal(M.findTicket(model, 'glass-wall/wall-marker').project.key, 'glass-wall');
  assert.equal(M.findTicket(model, 'nope'), null);
});

test('이벤트 연결: 제목줄 클릭→열림, 멈춤 클릭→저장·표시, 막·Esc→닫힘 (가짜 document)', async () => {
  const handlers = {};
  const pre = { textContent: '' };
  const holder = { innerHTML: '', className: '', querySelector: (q) => (q === '.tm-pre' ? pre : null) };
  const doc = {
    body: { appendChild() {} }, createElement: () => holder,
    addEventListener: (t, f) => { handlers[t] = f; },
  };
  const model = { workspace: 'wsA', projects: [{ key: 'glass-wall', title: '유리벽', tickets: [{ ...TICKET, spec_md: undefined }] }] };
  const sent = [];
  const gets = [];
  let hash = '';
  const api = M.mount({
    document: doc, getModel: () => model, w: () => model.workspace, go: (h) => { hash = h; },
    fetch: async (u, i) => {
      if (!i) { gets.push(u); return res(200, { spec_md: '# 전문\n\n본문' }); }   // 열 때 한 번 받는 spec.md
      sent.push([u, JSON.parse(i.body)]); return res(200, { user: { paused: true } });
    },
  });
  const el = (ds, self) => ({ dataset: ds, closest() { return self === false ? null : this; } });
  const click = (ds, target) => handlers.click({ target: target || el(ds), });
  // 열림
  await click({ ticket: 'glass-wall/wall-marker' });
  assert.match(text(holder.innerHTML), /시나리오 1 \/ 8 통과/);
  await new Promise((ok) => setImmediate(ok));
  assert.deepEqual(gets, ['/w/wsA/api/spec?sheet=glass-wall%2Fwall-marker'], '전문은 열 때 한 번만 받는다');
  assert.equal(pre.textContent, '# 전문\n\n본문', '본문 칸만 갈아 끼운다');
  // 막이 아닌 곳(모달 안쪽)을 눌러도 안 닫힌다
  const inner = { dataset: {}, closest: () => ({ dataset: { act: 'scrim' } }) };
  await handlers.click({ target: inner });
  assert.notEqual(holder.innerHTML, '');
  // 멈춤
  await click({ act: 'pause' });
  assert.deepEqual(sent, [['/w/wsA/api/ticket', { sheet: 'glass-wall/wall-marker', user: { paused: true }, base: { paused: false } }]]);
  assert.match(holder.innerHTML, /멈춤 풀기/);
  // Waves에서 보기 → 닫고 그 프로젝트 Waves로
  await click({ act: 'waves' });
  assert.equal(hash, '#glass-wall/wave');
  assert.equal(holder.innerHTML, '');
  // Esc
  await click({ ticket: 'glass-wall/wall-marker' });
  handlers.keydown({ key: 'Escape' });
  assert.equal(holder.innerHTML, '');
  assert.equal(api.current, null);
});

// ── 실경로: 실제 spec_model.py·sheet.py를 통과시킨다 (stub 아님)
const modelOf = (repo) => JSON.parse(execFileSync('python3', ['-I', join(scripts, 'spec_model.py'), repo], { encoding: 'utf8', maxBuffer: 64 << 20 }));

// 이 레포 자신만 본다 — 다른 레포(개발자 개인 레포 등)의 상태에 따라 이 테스트가 흔들리지 않게.
for (const [name, repo] of [['spec-board', join(here, '..', '..')]]) {
  test(`실제 ${name} 티켓마다 모달의 x/y가 spec_model의 scenarios와 같고 담당 없음 줄 수가 unowned와 같다`,
    { skip: !existsSync(join(repo, 'spec')) }, () => {
      const m = modelOf(repo);
      let seen = 0;
      for (const p of m.projects) for (const t of p.tickets) {
        if (t.error) continue;
        seen++;
        const html = M.render(t, { project: p });
        assert.match(text(html), new RegExp(`시나리오 ${t.scenarios.passed} / ${t.scenarios.total} 통과`), t.slug);
        assert.equal(count(html, /class="tm-sc[^"]*is-unowned"/g), t.unowned.length, t.slug);
        assert.equal(count(html, /<li class="tm-nd"/g), t.nodes.length, t.slug);
        assert.equal(/data-act="split"/.test(html), t.nodes.length === 0, t.slug);
        assert.equal(/data-act="waves"/.test(html), t.nodes.length > 0, t.slug);
        assert.equal(t.spec_md, undefined, `${t.slug}: 모델에는 spec_md를 싣지 않는다 (열 때 /api/spec으로 받는다)`);
      }
      assert.ok(seen > 0);
    });
}

// 실제 sheet.py를 빈 포트에 띄워 GET /api/board → 렌더 → 멈춤 POST → 409까지 본다. 실파일은 안 쓰고 임시 레포를 쓴다.
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), 'tm-repo-'));
  const t = join(root, 'spec', 'proj', 'tix');
  mkdirSync(join(t, 'rows'), { recursive: true });
  writeFileSync(join(root, 'spec', 'proj', 'README.md'), '# 프로젝트 — 시험\n\n| 항목 | 값 |\n|---|---|\n| 문제 | 시험 |\n| 상태 | 진행 |\n');
  writeFileSync(join(t, 'spec.md'), [
    '# 티켓 — 시험 문제', '', '| 항목 | 값 |', '|---|---|', '| 문제 | 시험 문제 |', '| 상태 | 진행 |', '| ID 머리 | TX |', '',
    '## 노드 인덱스', '', '| ID | 브리프 | deps | 상태 |', '|---|---|---|---|',
    '| n1 | [n1-a.md](n1-a.md) | — | 끝남 |', '| n2 | [n2-b.md](n2-b.md) | n1 | 진행 |', '',
  ].join('\n'));
  writeFileSync(join(t, 'n1-a.md'), '# n1-a — 첫째\n\n**id**: TX-1\n**상태**: 끝남\n**담당 행**: T1\n');
  writeFileSync(join(t, 'n2-b.md'), '# n2-b — 둘째\n\n**id**: TX-2\n**상태**: 진행\n**deps**: n1\n**담당 행**: T2\n');
  for (const [id, status] of [['T1', '아직 안 함'], ['T2', '아직 안 함'], ['T3', '아직 안 함']]) {
    writeFileSync(join(t, 'rows', `${id}.json`), JSON.stringify({
      id, kind: 'task', title: `행 ${id}`, given: 'g', when: 'w', then: 't', options: [], recommend: '', confidence: 'high',
      reversible: true, status, blocks: [], user: { answer: '', fix: '' }, log: [],
    }, null, 2));
  }
  return { root, ticketDir: t };
}

test('실제 sheet.py: /api/board 모델로 모달이 그려지고 멈춤이 ticket.json에 저장되며 낡은 base는 409다', async () => {
  const { root, ticketDir } = tempRepo();
  const port = await freePort();
  const srv = spawn('python3', [join(scripts, 'sheet.py'), root, '--port', String(port), '--no-sessions'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((ok, no) => {
      const to = setTimeout(() => no(new Error('서버가 안 떴다')), 8000);
      srv.stdout.on('data', (b) => { if (String(b).includes(`:${port}/`)) { clearTimeout(to); ok(); } });
      let err = '';
      srv.stderr.on('data', (b) => { err += b; });
      srv.on('exit', (c) => no(new Error(`서버 종료 ${c}: ${err.slice(-400)}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    const f = (u, i) => fetch(base + u, i);
    const raw = await (await f('/api/board')).json();
    const key = basename(root);               // 서버는 기본 레포도 같이 연다 — 임시 레포를 키로 고른다
    assert.ok(V.isBare(raw), 'w가 없으면 서버는 보드 없이 목록만 준다');
    assert.equal(V.chooseWorkspace(raw.workspaces, key), key);
    const model = await (await f(`/api/board?w=${encodeURIComponent(key)}`)).json();
    assert.equal(model.workspace, key);
    assert.ok(model.workspace, '워크스페이스 키가 모델에 붙어 온다');
    const hit = M.findTicket(model, 'proj/tix');
    assert.ok(hit, '티켓이 모델에 있다');

    const html = M.render(hit.ticket, { project: hit.project });
    assert.match(text(html), /시나리오 1 \/ 3 통과/);          // T1 = n1 끝남 → 통과, T2 = n2 진행, T3 = 담당 없음
    assert.equal(count(html, /is-unowned/g), 1);
    assert.match(html, /data-row="T3"/);
    assert.match(html, /Waves에서 보기/);

    const io = { w: model.workspace, fetch: f };
    const a = await M.setPaused(hit.ticket, true, io);
    assert.deepEqual(a, { ok: true, paused: true });
    const disk = JSON.parse(readFileSync(join(ticketDir, 'ticket.json'), 'utf8'));
    assert.equal(disk.user.paused, true);
    assert.deepEqual(Object.keys(disk.user).sort(), ['archived', 'paused', 'priority']);
    assert.equal(readdirSync(join(ticketDir, 'rows')).filter((x) => x.startsWith('T')).length, 3, '행 파일은 안 건드린다');

    // 낡은 화면(paused=false로 알고 있음)이 다시 멈추려 하면 서버가 거절하고 지금 값을 준다
    const stale = await M.setPaused({ ...hit.ticket, paused: false }, false, io);
    assert.equal(stale.conflict, true);
    assert.equal(stale.paused, true);
    assert.match(stale.message, /다른 곳에서 먼저 바꿨어요/);
    assert.equal(JSON.parse(readFileSync(join(ticketDir, 'ticket.json'), 'utf8')).user.paused, true, '덮지 않았다');

    // 다시 읽으면 모델이 멈춤을 반영하고 모달은 "멈춤 풀기"를 낸다
    const again = M.findTicket(await (await f(`/api/board?w=${encodeURIComponent(key)}`)).json(), 'proj/tix');
    assert.equal(again.ticket.paused, true);
    assert.match(M.render(again.ticket, { project: again.project }), /멈춤 풀기/);
    // spec.md 전문은 모델에 없고, 모달을 열 때 /api/spec으로 받는다
    assert.equal(again.ticket.spec_md, undefined);
    const spec = await M.loadSpec(again.ticket, io);
    assert.equal(spec.ok, true);
    assert.match(spec.text, /## 노드 인덱스/);
    assert.match(M.render(again.ticket, { project: again.project, spec: spec.text }), /## 노드 인덱스/);
  } finally {
    srv.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 테마
test('CSS는 accent·테두리·고정 색을 직접 쓰지 않는다', () => {
  const css = readFileSync(join(here, 'ticket_modal.css'), 'utf8');
  assert.doesNotMatch(css, /--accent|--on-accent/);
  assert.doesNotMatch(css, /border:\s*1px/);
  assert.doesNotMatch(css.replace(/rgba\(0, 0, 0, 0\.28\)/, ''), /#[0-9a-fA-F]{3,6}\b|rgba?\(/, '막 하나 말고는 토큰만');
  assert.match(readFileSync(join(here, 'index.html'), 'utf8'), /ticket_modal\.css/);
  assert.match(readFileSync(join(here, 'index.html'), 'utf8'), /ticket_modal\.js/);
});

test('모달 클래스가 카드의 .tm(경과 시간)과 겹치지 않는다', () => {
  const html = M.render(TICKET, {});
  assert.doesNotMatch(html, /class="(?:[^"]*\s)?tm(?:\s[^"]*)?"/, '맨 .tm 클래스를 쓰지 않는다');
  const mine = readFileSync(join(here, 'ticket_modal.css'), 'utf8');
  assert.doesNotMatch(mine, /(^|\n)\.tm\s*[{:,]/, 'CSS도 맨 .tm 규칙이 없다');
});
