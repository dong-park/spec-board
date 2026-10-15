// node --test spec_board/board_web/outbox.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const O = require('./outbox.js');

const B = (over) => ({ thread: '01a137ff-aaaa', state: 'waiting', held: false, count: 3, summary: '보드 입력 3건(결정 2 · 통과 1)',
  sheets: [{ ws: 'z', sheet: '/r/spec/coupon' }], left: 100, sent_at: null, info: '', error: '', ...over });

test('기다림: 요약·시트·남은 시간과 붙잡기·지금 보내기', () => {
  const v = { bundles: [B()], orphans: [] };
  const dl = O.deadlines(v, 1_000_000);
  assert.deepEqual(dl, { '01a137ff-aaaa': 1_100_000 });
  const h = O.bar(v, 1000, dl);
  assert.match(h, /에이전트에게 보낼 보드 입력 3건\(결정 2 · 통과 1\) · coupon · <span data-ob-left="1100000">1:40<\/span> 뒤 보냄/);
  assert.match(h, /data-ob-hold="01a137ff-aaaa"/);
  assert.match(h, /class="btn-primary" data-ob-flush="01a137ff-aaaa">지금 보내기/);
  assert.match(h, /스레드 01a137ff-aaaa/);
});

test('붙잡음·실패·보냄·주인 없음', () => {
  assert.match(O.bar({ bundles: [B({ held: true, left: null })] }, 0, {}), /붙잡음<\/span>.*data-ob-release/);
  assert.match(O.bar({ bundles: [B({ error: 'boom', held: true })] }, 0, {}), /보내지 못했어요 — boom.*다시 보내기/);
  const sent = B({ state: 'sent', sent_at: 5000 });
  assert.match(O.bar({ bundles: [sent] }, 5010, {}), /class="ob is-sent".*보냄 · \d\d:\d\d/);
  assert.equal(O.bar({ bundles: [sent] }, 5000 + O.SENT_SHOW + 1, {}), '', '보낸 지 오래되면 안 보인다');
  assert.match(O.bar({ bundles: [B({ state: 'merged', sent_at: 5000 })] }, 5001, {}), /앞서 보낸 깨우기에 합침/);
  const orph = O.bar({ bundles: [], orphans: [{ ws: 'z', sheet: '/r/spec/x', count: 2, reason: 'none' }, { ws: 'z', sheet: '/r/spec/y', count: 1, reason: 'off' }] }, 0, {});
  assert.match(orph, /x 입력 2건 — 담당 스레드가 없어 보내지 않아요/);
  assert.match(orph, /y 입력 1건 — 이 시트는 깨우기를 꺼 두어/);
  assert.equal(O.bar({ bundles: [], orphans: [] }, 0, {}), '');
  assert.equal(O.left(65.4), '1:05');
  assert.equal(O.left(-3), '0:00');
});

test('글자는 이스케이프', () => {
  assert.match(O.bar({ bundles: [B({ summary: '<b>x</b>', thread: 't"1' })] }, 0, {}), /&lt;b&gt;x&lt;\/b&gt;.*data-ob-flush="t&quot;1"/);
});
