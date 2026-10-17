#!/usr/bin/env python3
"""보드가 담당 스레드를 깨운다(spec/board-wake) — 담당 스레드 기록(n1), 깨우기 메시지(n2), 보내기 묶음(n3).

  python3 -m unittest discover -s tests -p 'test_wake.py'
"""
import contextlib
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _store  # noqa: F401  사람 칸 저장소를 임시 폴더로

import sheet
import spec_model as sm
from test_spec_model import Repo, Tmp


def run(*argv, thread=None):
    env = {k: v for k, v in os.environ.items() if k != "CODEX_THREAD_ID"}
    if thread:
        env["CODEX_THREAD_ID"] = thread
    out = io.StringIO()
    with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(sys, "argv", ["spec-board", *argv]), contextlib.redirect_stdout(out):
        code = sheet.main()
    return code, out.getvalue()


class ThreadRecord(Tmp):
    """n1 — apply·pending·wait를 부른 스레드가 그 시트의 담당으로 남는다(D3). 웨이브의 node review는 바꾸지 않는다."""

    def setUp(self):
        super().setUp()
        self.r = Repo(self.tmp); self.r.node("n1", "확인 대기"); self.r.row("D1", "decision"); self.r.write_spec()
        self.sheet = str(self.r.dir)

    def agent(self):
        return sm.read_agent(self.r.dir)

    def test_pending_records_the_thread_and_board_shows_it(self):
        run("pending", self.sheet, thread="01a13d24-main")
        a = self.agent()
        self.assertEqual((a["thread"], a["cmd"]), ("01a13d24-main", "pending"))
        t = sm.build_board(self.tmp)["projects"][0]["tickets"][0]
        self.assertEqual(t["agent"]["thread"], "01a13d24-main")

    def test_no_env_no_file_and_same_thread_does_not_rewrite(self):
        run("pending", self.sheet)
        self.assertEqual(self.agent(), {})
        self.assertFalse(sm.agent_file(self.r.dir).exists())
        run("apply", self.sheet, thread="01a13d24-main")
        v1 = sm.board_version(self.tmp)
        before = sm.agent_file(self.r.dir).stat().st_mtime_ns
        run("pending", self.sheet, thread="01a13d24-main")   # heartbeat가 다시 불러도
        self.assertEqual(sm.agent_file(self.r.dir).stat().st_mtime_ns, before)
        self.assertEqual(sm.board_version(self.tmp), v1, "같은 스레드면 보드 버전이 그대로")

    def test_later_apply_by_another_thread_takes_over_and_bad_ids_are_ignored(self):
        run("pending", self.sheet, thread="01a13d24-main")
        run("apply", self.sheet, thread="01a1ffff-relay")   # 메인을 새 스레드로 옮겼다
        self.assertEqual(self.agent()["thread"], "01a1ffff-relay")
        run("pending", self.sheet, thread="../../etc")
        self.assertEqual(self.agent()["thread"], "01a1ffff-relay")

    def test_pending_and_wait_by_other_thread_keep_the_owner_but_fill_an_empty_one(self):
        run("pending", self.sheet, thread="01a13d24-main")              # 담당이 없으면 pending도 기록한다
        self.assertEqual(self.agent()["thread"], "01a13d24-main")
        run("pending", self.sheet, thread="01a1aaaa-peek")              # 상태 확인용 채팅
        run("wait", self.sheet, "--timeout", "0", thread="01a1bbbb-peek")
        self.assertEqual(self.agent()["thread"], "01a13d24-main", "읽기 확인은 담당을 바꾸지 않는다")
        run("apply", self.sheet, thread="01a1cccc-newmain")             # 입력을 가져가는 apply만 바꾼다
        self.assertEqual(self.agent()["thread"], "01a1cccc-newmain")


class WaveWatchRules(Tmp):
    """D6=B — 잠금이 남은 웨이브의 세션 기록이 STALL 넘게 조용하면 담당 스레드를 한 번 깨운다."""

    def make(self, mtime, owner=("T1", True), queued=False, send_ok=True):
        import wavewatch
        self.sent = []
        self.now = 10000.0
        def send(t, m):
            self.sent.append((t, m))
            return (send_ok, "Queued message x")
        d = Path(self.tmp) / "spec" / "s1"
        d.mkdir(parents=True, exist_ok=True)
        self.d = d
        return wavewatch.WaveWatch(lambda: [d], lambda s: owner, send=send, queued=lambda t: queued,
                                   clock=lambda: self.now, mtime=lambda w: mtime(self), stall=1200)

    def test_quiet_wave_wakes_owner_once_and_message_names_the_wave(self):
        w = self.make(lambda s: s.now - 1500)
        (self.d / ".wave").write_text("01a1wave-aaaa\n")
        self.assertEqual(w.tick(), ["01a1wave-aaaa"])
        self.assertEqual(w.tick(), [], "같은 웨이브는 다시 안 보낸다")
        self.assertEqual(self.sent[0][0], "T1")
        self.assertIn("01a1wave-aaaa", self.sent[0][1])
        self.assertIn("25분째", self.sent[0][1])

    def test_nothing_to_send_when_alive_empty_lock_no_owner_or_wake_off(self):
        w = self.make(lambda s: s.now - 60)              # 최근에 움직였다
        (self.d / ".wave").write_text("01a1wave-aaaa\n")
        self.assertEqual(w.tick(), [])
        (self.d / ".wave").write_text("")                # 잠금이 비었다 = 웨이브가 정상으로 끝났다
        w2 = self.make(lambda s: s.now - 5000)
        (self.d / ".wave").write_text("")
        self.assertEqual(w2.tick(), [])
        for owner in (("", True), ("T1", False)):
            w3 = self.make(lambda s: s.now - 5000, owner=owner)
            (self.d / ".wave").write_text("01a1wave-aaaa\n")
            self.assertEqual(w3.tick(), [])
        self.assertEqual(self.sent, [])

    def test_new_wave_after_stall_is_told_again_and_failed_send_retries(self):
        w = self.make(lambda s: s.now - 5000, send_ok=False)
        (self.d / ".wave").write_text("01a1wave-aaaa\n")
        self.assertEqual(w.tick(), [])
        self.assertEqual(w.tick(), [], "보내기에 실패하면 told에 안 넣고 다음 틱에 다시")
        self.assertEqual(len(self.sent), 2)
        w.send = lambda t, m: (True, "ok")
        self.assertEqual(w.tick(), ["01a1wave-aaaa"])
        (self.d / ".wave").write_text("01a1wave-bbbb\n")
        self.assertEqual(w.tick(), ["01a1wave-bbbb"])


class WakeMessage(unittest.TestCase):
    """n2 — 묶음 하나를 메시지 한 줄로. 같은 항목을 여러 번 바꾸면 한 건."""

    def test_counts_kinds_and_lists_sheets(self):
        import wake
        home = os.path.expanduser("~")
        a, b = f"{home}/w/a/spec/x", f"{home}/w/b/spec/y"
        items = [{"sheet": a, "kind": "answer", "id": "D1"}, {"sheet": a, "kind": "answer", "id": "D2"},
                 {"sheet": b, "kind": "answer", "id": "D1"}, {"sheet": b, "kind": "pass", "id": "n3"},
                 {"sheet": a, "kind": "fix", "id": "n4"}]
        m = wake.wake_message(items)
        self.assertTrue(m.startswith("[spec-board] 보드 입력 5건(결정 3 · 통과 1 · 고쳐줘 1) — ~/w/a/spec/x, ~/w/b/spec/y."), m)
        self.assertIn("spec-board apply", m)

    def test_same_item_changed_twice_is_one_and_comments_each_count(self):
        import wake
        items = [{"sheet": "/s", "kind": "answer", "id": "D1"}, {"sheet": "/s", "kind": "answer", "id": "D1"},
                 {"sheet": "/s", "kind": "comment", "id": "n1"}, {"sheet": "/s", "kind": "comment", "id": "n1"}]
        self.assertEqual(wake.summary(items), "보드 입력 3건(결정 1 · 댓글 2)")
        self.assertEqual(wake.wake_message([]), "")

    def test_many_sheets_stay_short(self):
        import wake
        items = [{"sheet": f"/very/long/path/{'x' * 80}/spec/s{i}", "kind": "pass", "id": "n1"} for i in range(9)]
        m = wake.wake_message(items)
        self.assertLessEqual(len(m), wake.MAX_LEN)
        self.assertIn("보드 입력 9건(통과 9)", m)


class OutboxRules(unittest.TestCase):
    """n3 — 묶기 규칙. 시계·실행기·남은 할 일·대기열을 바꿔 끼운다."""

    def make(self, owner=("T1", True), todo=None, queued=False, send_ok=True):
        import outbox
        self.now = [1000.0]
        self.sent = []
        self.todo = todo if todo is not None else {"T1": 3}
        def send(t, m):
            self.sent.append((t, m))
            return (True, "Queued message x") if send_ok else (False, "boom")
        return outbox.Outbox(lambda s: owner, lambda t: self.todo.get(t, 0), send=send, queued=lambda t: queued,
                             clock=lambda: self.now[0], quiet=120)

    def answer(self, ob, i, kind="answer"):
        return ob.add("ws", Path("/r/spec/s"), kind, f"D{i}")

    def test_sends_once_when_the_last_todo_is_answered(self):
        ob = self.make()
        for i in (1, 2, 3):
            self.answer(ob, i); self.todo["T1"] -= 1
            if i < 3:
                self.now[0] += 20
                self.assertEqual(ob.tick(), [], "남은 할 일이 있으면 기다린다")
        self.assertEqual(ob.tick(), ["T1"], "마지막 것을 답하면 바로")
        self.assertEqual(len(self.sent), 1)
        self.assertIn("보드 입력 3건(결정 3)", self.sent[0][1])
        self.assertEqual(ob.view()["bundles"][0]["state"], "sent")

    def test_stops_halfway_then_quiet_time(self):
        ob = self.make()
        self.answer(ob, 1); self.todo["T1"] = 2
        self.now[0] += 119
        self.assertEqual(ob.tick(), [])
        self.assertEqual(ob.view()["bundles"][0]["left"], 1)
        self.now[0] += 1
        self.assertEqual(ob.tick(), ["T1"])
        self.assertEqual(len(self.sent), 1)

    def test_new_input_restarts_the_clock_and_hold_waits(self):
        ob = self.make()
        self.answer(ob, 1); self.now[0] += 100
        self.answer(ob, 2); self.now[0] += 100
        self.assertEqual(ob.tick(), [], "새 입력이 오면 조용한 시간을 처음부터")
        ob.hold("T1", True); self.now[0] += 500
        self.assertEqual(ob.tick(), [])
        ob.hold("T1", False); self.now[0] += 120
        self.assertEqual(ob.tick(), ["T1"])
        self.assertIn("보드 입력 2건", self.sent[0][1])

    def test_flush_now_and_queue_merge(self):
        ob = self.make(queued=True)
        self.answer(ob, 1)
        b = ob.flush("T1")
        self.assertEqual((b["state"], self.sent), ("merged", []), "아직 안 꺼낸 깨우기가 있으면 안 넣는다")
        self.answer(ob, 2)   # 보낸 뒤 새 입력은 새 묶음
        self.assertEqual(ob.view()["bundles"][0]["state"], "waiting")

    def test_no_owner_or_wake_off_is_orphan_and_never_sent(self):
        ob = self.make(owner=("", True))
        self.assertEqual(self.answer(ob, 1), "")
        ob2 = self.make(owner=("T1", False))
        self.answer(ob2, 1)
        self.now[0] += 1000
        self.assertEqual((ob.tick(), ob2.tick(), self.sent), ([], [], []))
        self.assertEqual(ob.view()["orphans"][0]["reason"], "none")
        self.assertEqual(ob2.view()["orphans"][0]["reason"], "off")

    def test_failed_send_keeps_items_held_for_retry(self):
        ob = self.make(send_ok=False)
        self.answer(ob, 1); self.todo["T1"] = 0
        ob.tick()
        v = ob.view()["bundles"][0]
        self.assertEqual((v["state"], v["held"], v["count"], v["error"]), ("waiting", True, 1, "boom"))
        self.now[0] += 1000
        self.assertEqual(ob.tick(), [], "실패한 묶음은 붙잡아 두고 사람이 다시 보낸다")


class OutboxHttp(Tmp):
    """n3 — 보드에서 답하면 담당 스레드 묶음에 들어가고, /api/outbox로 보이고, 지금 보내기가 한 번 보낸다."""

    def test_answer_goes_to_the_owner_bundle(self):
        import threading, urllib.request
        from http.server import ThreadingHTTPServer
        import outbox
        conf = mock.patch.object(sheet, "CONF", self.tmp / "no-roots"); conf.start(); self.addCleanup(conf.stop)
        self.addCleanup(sheet._SHEETS.clear)
        r = Repo(self.tmp); r.node("n1", "확인 대기"); r.row("D1", "decision"); r.row("D2", "decision"); r.write_spec()
        run("pending", str(r.dir), thread="01a1main-thread")
        sent = []
        reg = sheet.Registry([self.tmp])
        ob = outbox.Outbox(sheet.wake_owner, lambda t: sheet.wake_todo(reg, t), send=lambda t, m: (sent.append((t, m)) or (True, "Queued")),
                           queued=lambda t: False)
        srv = ThreadingHTTPServer(("127.0.0.1", 0), sheet.make_handler(reg, outbox=ob))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close); self.addCleanup(srv.shutdown)
        base = f"http://127.0.0.1:{srv.server_address[1]}"
        ws = next(iter(reg.roots()))

        def post(path, body):
            q = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json"})
            return json.load(urllib.request.urlopen(q))

        post(f"/w/{ws}/api/user", {"sheet": r.slug, "id": "D1", "user": {"answer": "A"}, "base": {"answer": ""}})
        v = json.load(urllib.request.urlopen(base + "/api/outbox"))
        self.assertEqual([(b["thread"], b["count"], b["state"]) for b in v["bundles"]], [("01a1main-thread", 1, "waiting")])
        self.assertEqual(sheet.wake_todo(reg, "01a1main-thread"), 2, "D2와 확인 대기 n1이 남았다")
        post(f"/w/{ws}/api/node", {"sheet": r.slug, "id": "n1", "user": {"verdict": "통과"}, "base": {"verdict": "", "fix": ""}})
        got = post("/api/outbox", {"action": "flush", "thread": "01a1main-thread"})
        self.assertEqual(got["bundle"]["state"], "sent")
        self.assertEqual(len(sent), 1)
        self.assertIn("보드 입력 2건(결정 1 · 통과 1)", sent[0][1])
        self.assertIn(str(r.dir).replace(os.path.expanduser("~"), "~"), sent[0][1])


class ThreadRecordWorktrees(unittest.TestCase):
    """n1 — 같은 레포의 워크트리끼리 담당 기록을 함께 본다(사람 칸 저장소가 git common dir로 묶인다)."""

    def test_worktree_sees_the_same_owner(self):
        import subprocess, tempfile
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        repo = Path(tmp.name) / "repo"; t = repo / "spec" / "s"
        (t / "rows").mkdir(parents=True)
        (t / "spec.md").write_text("# s\n\n| 칸 | 값 |\n|---|---|\n| 상태 | 진행 |\n", encoding="utf-8")
        (t / "rows" / "D1.json").write_text('{"id": "D1", "kind": "decision", "title": "d"}', encoding="utf-8")
        g = lambda cwd, *a: subprocess.run(["git", "-C", str(cwd), *a], check=True, capture_output=True)
        g(repo, "init", "-q"); g(repo, "add", "-A"); g(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x")
        wt = Path(tmp.name) / "wt"; g(repo, "worktree", "add", "-q", str(wt))
        run("pending", str(wt / "spec" / "s"), thread="01a1worktree-main")
        self.assertEqual(sm.read_agent(t)["thread"], "01a1worktree-main", "원래 체크아웃에서도 같은 담당이 보인다")
        self.assertEqual(sheet.wake_owner(t), ("01a1worktree-main", True))


class SiteNudgeAndOwner(Tmp):
    """사이트에서 — 담당 없는 시트에 담당을 정하고, 반영 대기를 담당에게 바로 보낸다."""

    def test_owner_then_nudge_sends_pending_once(self):
        import threading, urllib.request, urllib.error
        from http.server import ThreadingHTTPServer
        import outbox
        conf = mock.patch.object(sheet, "CONF", self.tmp / "no-roots"); conf.start(); self.addCleanup(conf.stop)
        self.addCleanup(sheet._SHEETS.clear)
        r = Repo(self.tmp); r.node("n1", "확인 대기"); r.row("D1", "decision", user={"answer": "A", "fix": ""}); r.row("D2", "decision"); r.write_spec()
        sheet.save_node_user(r.dir, "n1", {"verdict": "통과"}, None)   # 어제 남긴 통과 — 아직 반영 안 됨
        sent = []
        reg = sheet.Registry([self.tmp])
        ob = outbox.Outbox(sheet.wake_owner, lambda t: 99, send=lambda t, m: (sent.append((t, m)) or (True, "Queued")), queued=lambda t: False)
        srv = ThreadingHTTPServer(("127.0.0.1", 0), sheet.make_handler(reg, outbox=ob))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close); self.addCleanup(srv.shutdown)
        base = f"http://127.0.0.1:{srv.server_address[1]}"
        ws = next(iter(reg.roots()))

        def post(path, body):
            q = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json"})
            try:
                return 200, json.load(urllib.request.urlopen(q))
            except urllib.error.HTTPError as e:
                return e.code, json.load(e)

        code, j = post("/api/outbox", {"action": "nudge", "ws": ws, "sheet": r.slug})
        self.assertEqual(code, 400, "담당이 없으면 못 보낸다")
        self.assertEqual(post("/api/owner", {"ws": ws, "sheet": r.slug, "thread": "../x"})[0], 400)
        code, j = post("/api/owner", {"ws": ws, "sheet": r.slug, "thread": "01a139c2-177e-main"})
        self.assertEqual((code, sm.read_agent(r.dir)["cmd"]), (200, "board"))
        self.assertEqual(j["owners"][0]["thread"], "01a139c2-177e-main")
        code, j = post("/api/outbox", {"action": "nudge", "ws": ws, "sheet": r.slug})
        self.assertEqual((code, j["bundle"]["state"]), (200, "sent"))
        self.assertEqual(len(sent), 1)
        self.assertIn("보드 입력 2건(결정 1 · 통과 1)", sent[0][1], "답만 있는 D2는 빼고 반영 대기 둘만")


class ContextRelay(Tmp):
    """D7 — 담당 스레드 문맥이 크고 웨이브가 없을 때만 보드에서 릴레이를 요청할 수 있다."""

    def setUp(self):
        super().setUp()
        home = self.tmp / "codex-home"; d = home / "sessions" / "2026" / "10" / "17"; d.mkdir(parents=True)
        self.th = "01a139c2-177e-main"
        line = lambda n: json.dumps({"type": "event_msg", "payload": {"type": "token_count", "info": {"last_token_usage": {"input_tokens": n}}}})
        (d / f"rollout-2026-10-17T00-00-00-{self.th}.jsonl").write_text(line(120000) + "\n" + json.dumps({"type": "x"}) + "\n" + line(450000) + "\n", encoding="utf-8")
        env = mock.patch.dict(os.environ, {"CODEX_HOME": str(home)}); env.start(); self.addCleanup(env.stop)

    def test_tokens_come_from_the_last_call_and_missing_thread_is_none(self):
        import ctxwatch
        self.assertEqual(ctxwatch.context_tokens(self.th), 450000)
        self.assertIsNone(ctxwatch.context_tokens("01a1none-none-none"))

    def test_relay_request_is_blocked_while_a_wave_runs_and_sent_once_otherwise(self):
        import threading, urllib.request, urllib.error
        from http.server import ThreadingHTTPServer
        import outbox
        conf = mock.patch.object(sheet, "CONF", self.tmp / "no-roots"); conf.start(); self.addCleanup(conf.stop)
        self.addCleanup(sheet._SHEETS.clear)
        r = Repo(self.tmp); r.node("n1", "진행"); r.row("D1", "decision"); r.write_spec()
        sheet.set_owner(r.dir, self.th)
        sent = []
        reg = sheet.Registry([self.tmp])
        ob = outbox.Outbox(sheet.wake_owner, lambda t: 0, send=lambda t, m: (sent.append((t, m)) or (True, "Queued")), queued=lambda t: False)
        srv = ThreadingHTTPServer(("127.0.0.1", 0), sheet.make_handler(reg, outbox=ob))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close); self.addCleanup(srv.shutdown)
        base = f"http://127.0.0.1:{srv.server_address[1]}"
        ws = next(iter(reg.roots()))

        def post(path, body):
            q = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json"})
            try:
                return 200, json.load(urllib.request.urlopen(q))
            except urllib.error.HTTPError as e:
                return e.code, json.load(e)

        own = json.load(urllib.request.urlopen(base + "/api/outbox"))["owners"][0]
        self.assertEqual((own["tokens"], own["running"], own["relay"]), (450000, False, True))
        (r.dir / ".wave").write_text("01a1wave-aaaa\n")
        own = json.load(urllib.request.urlopen(base + "/api/outbox"))["owners"][0]
        self.assertEqual((own["running"], own["relay"]), (True, False), "웨이브가 돌면 권하지 않는다")
        code, j = post("/api/outbox", {"action": "relay", "ws": ws, "sheet": r.slug})
        self.assertEqual((code, sent), (400, []), "웨이브가 돌면 서버가 막는다")
        (r.dir / ".wave").write_text("")
        code, j = post("/api/outbox", {"action": "relay", "ws": ws, "sheet": r.slug})
        self.assertEqual((code, len(sent)), (200, 1))
        self.assertEqual(sent[0][0], self.th)
        self.assertIn("45만 토큰", sent[0][1])
        self.assertIn(f"target_thread_id가 {self.th}", sent[0][1])
        self.assertIn(f"spec-board apply spec/{r.slug}", sent[0][1])


class RelayWatchRules(unittest.TestCase):
    """D7=B — 보드가 조건이 모두 맞을 때만 스스로 릴레이를 요청하고, 같은 스레드에는 한 시간에 한 번만."""

    def make(self, **o):
        import ctxwatch
        base = {"thread": "T1", "tokens": 200000, "running": False, "relay": True, "sheets": [{"ws": "w", "slug": "s1"}]}
        base.update({k: v for k, v in o.items() if k in base})
        self.sent, self.now = [], 10000.0
        def send(t, m):
            self.sent.append((t, m))
            return (True, "Queued")
        return ctxwatch.RelayWatch(lambda: [base], lambda _o: o.get("wake", True), send=send,
                                   queued=lambda t: o.get("queued", False), clock=lambda: self.now, mtime=lambda t: self.now - o.get("idle", 600),
                                   quiet=90, again=3600)

    def test_all_conditions_met_sends_once_with_auto_wording_then_waits_an_hour(self):
        w = self.make()
        self.assertEqual(w.tick(), ["T1"])
        self.assertIn("자동 릴레이", self.sent[0][1])
        self.assertIn("spec/s1/relay.md", self.sent[0][1])
        self.assertEqual(w.tick(), [], "같은 스레드는 한 시간 안에 다시 안 보낸다")
        self.now += 3601
        self.assertEqual(w.tick(), ["T1"], "한 시간 뒤에도 그대로면 다시")

    def test_each_missing_condition_blocks(self):
        for kw in ({"relay": False}, {"idle": 30}, {"queued": True}, {"wake": False}, {"sheets": []}):
            w = self.make(**kw)
            self.assertEqual(w.tick(), [], kw)
        self.assertEqual(self.sent, [])

if __name__ == "__main__":
    unittest.main()
