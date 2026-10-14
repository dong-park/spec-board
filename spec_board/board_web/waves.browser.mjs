// 실제 브라우저 회귀: 지원되는 Playwright Page로 실행한다. API는 합성 fixture만 반환한다.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { waveFixture } from './waves.fixture.mjs';
const evidence = '/tmp/waves-row-preview-evidence';
const row = (page, slug) => page.locator(`.wrow[data-row="${slug}"]`);
const cell = (page, slug, wave = 0) => row(page, slug).locator('.cell').nth(wave);
const button = (host, action) => host.locator(`[data-wave-action="${action}"]`).first();
const active = (page, action) => page.evaluate(a => document.activeElement?.dataset.waveAction === a, action);
const snapshot = (page, name) => page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });

export async function sessionChecks(page) {
  await mkdir(evidence, { recursive: true });
  let model = waveFixture();
  let fail = '';
  let versionCalls = 0;
  const handler = async route => {
    const version = route.request().url().includes('/api/version');
    if (version) versionCalls++;
    await route.fulfill({ status: fail === (version ? 'version' : 'board') ? 503 : 200, contentType: 'application/json', body: JSON.stringify(version ? { v: model.v } : model) });
  };
  await page.route('**/api/**', handler);
  const checks = [];
  try {
    await page.setViewportSize({ width: 800, height: 900 });
    await page.goto('about:blank');
    await page.goto('http://127.0.0.1:8791/board/#wave');
    await page.waitForSelector('.wrow');
    await button(cell(page, 'p/first'), 'more').click();
    await button(cell(page, 'p/first'), 'done').click();
    await button(row(page, 'p/first'), 'folded').click();
    assert.equal(await row(page, 'p/first').locator('.wc').count(), 0);
    assert.match(await cell(page, 'p/first').innerText(), /미완료 7 · 반영 대기 1 · 완료 21/);
    assert.equal(await cell(page, 'p/long').locator('.wc').count(), 3);
    await button(row(page, 'p/first'), 'folded').click();
    assert.equal(await cell(page, 'p/first').locator('.wc').count(), 29);
    checks.push({ row: 'T8', result: 'pass' });

    await page.locator('.view').evaluate(e => { e.scrollTop = 500; e.scrollLeft = 640; });
    const rects = await page.evaluate(() => {
      const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; };
      return { view: rect('.view'), header: rect('.wh'), title: rect('.wtitle'), lane: rect('.lanehd'), row: rect('.wrow') };
    });
    assert.ok(rects.header.y >= rects.view.y && rects.header.y < rects.view.y + 8, JSON.stringify(rects));
    assert.ok(rects.title.y >= rects.header.bottom && rects.title.y < rects.header.bottom + 16, JSON.stringify(rects));
    assert.ok(rects.lane.x >= rects.view.x && rects.lane.x <= rects.view.x + 16);
    await snapshot(page, 'sticky-800');
    checks.push({ row: 'T9', result: 'pass', rects });

    await page.locator('.view').evaluate(e => { e.scrollTop = 0; e.scrollLeft = 0; });
    // 실제 Tab 순회로 첫 제목 접기 버튼에 도달한다.
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    for (let i = 0; i < 25 && !(await active(page, 'folded')); i++) await page.keyboard.press('Tab');
    assert.ok(await active(page, 'folded'));
    await page.keyboard.press('Enter');
    assert.ok(await active(page, 'folded'));
    assert.equal(await row(page, 'p/first').locator('.wc').count(), 0);
    await page.keyboard.press('Space');
    assert.ok(await active(page, 'folded'));
    for (const action of ['more', 'done']) {
      await button(cell(page, 'p/first'), action).focus();
      await page.keyboard.press('Enter');
      assert.ok(await active(page, action));
      assert.equal(await button(cell(page, 'p/first'), action).getAttribute('aria-expanded'), 'false');
      await page.keyboard.press('Space');
      assert.ok(await active(page, action));
      assert.equal(await button(cell(page, 'p/first'), action).getAttribute('aria-expanded'), 'true');
    }
    await button(row(page, 'p/first'), 'folded').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => !document.activeElement.closest('.wrow[data-row="p/first"]')));
    await button(row(page, 'p/first'), 'folded').click();
    checks.push({ row: 'T12', result: 'pass' });

    await button(row(page, 'p/long'), 'folded').click();
    await button(cell(page, 'p/first'), 'more').focus();
    await page.locator('.view').evaluate(e => { e.scrollTop = 180; e.scrollLeft = 480; });
    model = structuredClone(model);
    model.v = '2';
    const tickets = model.projects[0].tickets;
    tickets[0].nodes[6].state = '끝남';
    for (let i = 38; i < 42; i++) tickets[0].nodes.push({ ...tickets[0].nodes[0], key: `n${i}`, id: `WP-${i}`, deps: ['n37'], blocked_by_ids: [] });
    tickets.unshift({ slug: 'p/new', title: '새 제목', nodes: waveFixture().projects[0].tickets[3].nodes });
    tickets.reverse();
    await page.waitForFunction(() => document.querySelector('.wrow[data-row="p/new"]'));
    assert.ok(await active(page, 'more'));
    assert.equal(await page.evaluate(() => document.activeElement.dataset.waveChoice), JSON.stringify(['wave-fixture', 'p/first', 0]));
    assert.equal(await cell(page, 'p/first').locator('.wc').count(), 29);
    assert.match(await cell(page, 'p/first').innerText(), /미완료 6 · 반영 대기 1 · 완료 22/);
    assert.equal(await row(page, 'p/long').locator('.wc').count(), 0);
    assert.equal(await cell(page, 'p/new').locator('.wc').count(), 3);
    assert.equal(await cell(page, 'p/first', 9).locator('.wc').count(), 3);
    const scroll = await page.locator('.view').evaluate(e => ({ top: e.scrollTop, left: e.scrollLeft }));
    assert.deepEqual(scroll, { top: 180, left: 480 });
    await page.evaluate(() => location.hash = '#board');
    await page.waitForSelector('.board');
    await page.evaluate(() => location.hash = '#wave');
    await page.waitForSelector('.wrow');
    assert.equal(await cell(page, 'p/first').locator('.wc').count(), 29);
    assert.equal(await row(page, 'p/long').locator('.wc').count(), 0);
    checks.push({ row: 'T13', result: 'pass', versionCalls, scroll, workspace: 'unit test isolates same slug in another workspace' });

    for (const failure of ['version', 'board']) {
      fail = failure;
      model.v = failure === 'version' ? '3' : '4';
      await page.waitForSelector('body.is-offline');
      assert.equal(await cell(page, 'p/first').locator('.wc').count(), 29);
      assert.equal(await row(page, 'p/long').locator('.wc').count(), 0);
      fail = '';
      await page.waitForSelector('body:not(.is-offline)');
    }
    await snapshot(page, 'session-after-recovery-800');
    checks.push({ row: 'T14', result: 'pass', failures: ['version 503', 'board 503'], recovered: true });
    await page.reload();
    await page.waitForSelector('.wrow');
    assert.equal(await cell(page, 'p/first').locator('.wc').count(), 4);
    assert.equal(await cell(page, 'p/long').locator('.wc').count(), 3);
    await page.goto('about:blank');
    await page.goto('http://127.0.0.1:8791/board/#wave');
    await page.waitForSelector('.wrow');
    assert.equal(await cell(page, 'p/first').locator('.wc').count(), 4);
    checks.push({ row: 'D1', result: 'pass', reset: ['reload', 'revisit'] });
    return checks;
  } finally {
    await writeFile(`${evidence}/session-checks.json`, JSON.stringify(checks, null, 2));
    await page.unroute('**/api/**', handler);
  }
}

export async function regressionChecks(page) {
  await mkdir(evidence, { recursive: true });
  const model = waveFixture();
  const confirmationPosts = [];
  const handler = async route => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON();
      confirmationPosts.push(request);
      const node = model.projects[0].tickets.find(t => t.slug === request.sheet).nodes.find(n => n.key === request.id);
      Object.assign(node, request.user);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, user: { verdict: node.verdict, fix: node.fix || '' } }) });
    } else await route.fulfill({ contentType: 'application/json', body: JSON.stringify(route.request().url().includes('/api/version') ? { v: model.v } : model) });
  };
  await page.route('**/api/**', handler);
  const checks = [];
  try {
    await page.goto('about:blank');
    await page.goto('http://127.0.0.1:8791/board/#wave');
    await page.waitForSelector('.wrow');
    assert.equal(await page.locator('.wrow').count(), 4);
    const first = cell(page, 'p/first');
    assert.equal(await first.locator('.wc').count(), 4);
    assert.match(await first.innerText(), /미완료 7 · 반영 대기 1 · 완료 21/);
    assert.match(await first.innerText(), /남은 4개 더 보기/);
    assert.equal(await row(page, 'p/classify').locator('.card.is-err').count(), 1);
    for (const key of ['n2', 'n3']) assert.match(await row(page, 'p/classify').locator(`.card[data-key="${key}"]`).innerText(), /반영 대기/);
    checks.push({ rows: 'T1/T2/T6/T7', result: 'pass' });

    await button(first, 'more').click();
    assert.equal(await first.locator('.wc').count(), 8);
    await button(first, 'more').click();
    assert.equal(await first.locator('.wc').count(), 4);
    await button(first, 'done').click();
    assert.equal(await first.locator('.wc').count(), 25);
    await button(first, 'done').click();
    assert.equal(await first.locator('.wc').count(), 4);
    checks.push({ rows: 'T3/T4/T5', result: 'pass' });

    // 숨긴 n4도 n30의 앞 사슬 계산에 남는다. 다른 제목의 n30과 n4는 강조하지 않는다.
    const target = row(page, 'p/first').locator('.wc[data-n="0:n30"]');
    await target.hover();
    assert.ok(await target.evaluate(e => e.classList.contains('lit') && e.dataset.up.includes('0:n4')));
    assert.equal(await row(page, 'p/first').locator('.wc[data-n="0:n4"]').count(), 0);
    assert.equal(await row(page, 'p/edges').locator('.wc.lit').count(), 0);
    assert.equal(await first.locator('.wc').count(), 4, '사슬 계산이 자동으로 펼치지 않는다');
    await page.locator('.top').hover();
    assert.equal(await page.locator('.wgrid.focus').count(), 0);
    await target.locator('.card').focus();
    assert.ok(await target.evaluate(e => e.classList.contains('lit')));
    await button(row(page, 'p/edges'), 'folded').focus();
    assert.equal(await page.locator('.wgrid.focus').count(), 0);
    await button(first, 'more').click();
    await target.hover();
    assert.equal(await first.locator('.wc.up[data-n="0:n4"]').count(), 1);
    assert.equal(await row(page, 'p/edges').locator('.wc.lit').count(), 0);
    await snapshot(page, 'chain-expanded-800');
    await page.locator('.top').hover();
    checks.push({ row: 'T11', result: 'pass', hiddenPredecessor: '0:n4', isolatedDuplicate: '1:n30', input: ['hover', 'focus'] });

    await button(first, 'done').click();
    for (const key of ['n1', 'n4', 'n9', 'n8']) {
      await first.locator(`.card[data-key="${key}"]`).click();
      await page.waitForSelector('.nm');
      assert.match(await page.locator('.nm').innerText(), new RegExp('WP-' + key.slice(1)));
      if (key === 'n8') {
        assert.equal(await page.locator('.nm [data-nm="pass"]').count(), 1);
        await page.locator('.nm [data-nm="fix"]').click();
        await page.getByRole('textbox', { name: '고칠 내용' }).waitFor();
        await page.getByRole('textbox', { name: '고칠 내용' }).fill('합성 확인 조작');
        await page.locator('.nm [data-nm="cancel"]').click();
        await snapshot(page, 'pending-node-modal-800');
      }
      await page.locator('.nm [data-nm="close"]').click();
      await page.waitForSelector('.nm', { state: 'detached' });
      assert.equal(await first.locator('.wc').count(), 29);
    }
    await first.locator('.chip[data-dec="WP-D1"]').click();
    await page.waitForSelector('.modal');
    assert.match(await page.locator('.modal').innerText(), /합성 결정/);
    await snapshot(page, 'decision-modal-800');
    await page.locator('.modal [data-modal-close]').click();
    assert.equal(await first.locator('.wc').count(), 29);
    await first.locator('.card[data-key="n8"]').click();
    await page.locator('.nm [data-nm="pass"]').click();
    await page.waitForFunction(() => document.querySelector('.nm [role="status"]')?.textContent.includes('통과를 남겼어요'));
    await page.locator('.nm [data-nm="fix"]').click();
    await page.getByRole('textbox', { name: '고칠 내용' }).fill('합성 확인 저장');
    await page.locator('.nm [data-nm="send"]').click();
    await page.waitForFunction(() => document.querySelector('.nm [role="status"]')?.textContent.includes('고쳐줘를 보냈어요'));
    assert.equal(confirmationPosts.length, 2);
    assert.equal(confirmationPosts[0].user.verdict, '통과');
    assert.equal(confirmationPosts[1].user.fix, '합성 확인 저장');
    await page.locator('.nm [data-nm="close"]').click();
    assert.equal(await first.locator('.wc').count(), 29);
    assert.match(await first.locator('.card[data-key="n8"]').innerText(), /반영 대기/);
    checks.push({ row: 'T10', result: 'pass', nodeCards: ['preview n1', 'more n4', 'done n9', 'pending n8'], decision: 'WP-D1', confirmation: 'fix cancel and pass/fix POST accepted by synthetic API; selection remains' });

    for (const width of [800, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.reload();
      await page.waitForSelector('.wrow');
      assert.equal(await page.locator('.wrow').count(), 4);
      assert.equal(await row(page, 'p/nodeless').count(), 0);
      assert.equal(await cell(page, 'p/edges', 0).locator('.wc').count(), 1);
      assert.equal(await cell(page, 'p/edges', 2).locator('.wc').count(), 3);
      assert.equal(await row(page, 'p/edges').locator('[data-wave-action="more"]').count(), 0);
      assert.equal(await cell(page, 'p/edges', 1).locator('.wc').count(), 0);
      assert.equal(await cell(page, 'p/edges', 1).locator('[data-wave-action="done"]').count(), 1);
      assert.match(await cell(page, 'p/edges', 4).innerText(), /빈 칸/);
      const geometry = await page.evaluate(() => {
        const g = document.querySelector('.wgrid');
        const errors = [];
        for (const e of document.querySelectorAll('.wrowbutton,.wcounts,.wbutton')) {
          if (e.scrollWidth > e.clientWidth + 1) errors.push(e.textContent);
        }
        const rows = [...document.querySelectorAll('.wrow')].map(r => [...r.querySelectorAll('.cell')].map(c => c.getBoundingClientRect().x));
        return { errors, rows, waves: g.dataset.waves };
      });
      assert.deepEqual(geometry.errors, []);
      for (const xs of geometry.rows) assert.deepEqual(xs, geometry.rows[0]);
      await snapshot(page, `default-${width}`);
      await button(cell(page, 'p/first'), 'more').click();
      await button(cell(page, 'p/first'), 'done').click();
      await snapshot(page, `expanded-${width}`);
      await page.locator('.view').evaluate(e => e.scrollLeft = e.scrollWidth);
      const last = await page.locator('.wgrid > .wh').last().boundingBox();
      assert.ok(last.x >= 0 && last.x + last.width <= width);
      await snapshot(page, `last-wave-${width}`);
      await page.locator('.view').evaluate(e => { e.scrollLeft = 0; e.scrollTop = e.scrollHeight; });
      await snapshot(page, `bottom-titles-${width}`);
      checks.push({ row: 'T15', result: 'pass', width, waves: geometry.waves, overflowErrors: geometry.errors, alignedRows: geometry.rows.length });
    }
    return checks;
  } finally {
    await writeFile(`${evidence}/regression-checks.json`, JSON.stringify(checks, null, 2));
    await page.unroute('**/api/**', handler);
  }
}
