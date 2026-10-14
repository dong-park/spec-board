#!/usr/bin/env python3
"""시트 사이드바·시트 화면의 서버 쪽 — 리뷰 판정, 보고서 시각 대체, 시트 묶음·요약, 브랜치, /api/sheets.

  python3 -m unittest discover -s tests -p 'test_sheets.py'
"""
import json
import sys
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import sheet
import spec_model as sm
from test_spec_model import Repo, Tmp


class ReviewKind(unittest.TestCase):
    def test_real_first_lines(self):
        cases = {
            "5축 생략: 변경 60줄(<100)이고 인증·마이그레이션 아님": "skip",
            "다섯 축 심사(줄 수 약 600). P0 0건. 판정: 수정 없이 보고, 사람 결정 필요 P1 3건 남김": "fix",
            "5축 심사(admin 658줄+api 46줄). 판정 ⚠️ REQUEST_CHANGES, P0 0건.": "fix",
            "5축 실행(297줄+마이그레이션). 판정 APPROVE, P0 0건. P1 중 mid 없는 알림톡": "ok",
            "조건부 승인 → P1(회원 문자수신내역 smsLog가 cooldown_days 무시) 고침": "ok",
            "미실행(웨이브 스레드에서 /review 스킬을 부르지 못함).": "no",
            "5축 병렬 /review는 돌리지 않았다. diff가 190줄": "no",
            "": "",
        }
        for line, want in cases.items():
            self.assertEqual(sm.review_kind(line), want, line)

    def test_parse_reads_review_and_name_fallback(self):
        w = sm.parse_wave("# wave 2026-10-13 · 스레드 t\nn5 | 끝남 | z | y\n## /review (범위: 약 1500줄)\n5축 심사. 초기 REQUEST_CHANGES\n")
        self.assertEqual(w["review"], "fix")
        self.assertEqual(sm._wave_at("이상한 머리", "20261013-wave3"), "2026-10-13")
        self.assertEqual(sm._wave_at("이상한 머리", "20261013-1520b"), "2026-10-13 15:20")


class SheetState(unittest.TestCase):
    def t(self, states, state="진행", waves=()):
        return {"slug": "s", "title": "s — 이름", "state": state, "rows": [], "waves": list(waves),
                "nodes": [{"key": f"n{i}", "state": s, "error": ""} for i, s in enumerate(states)]}

    def test_groups(self):
        self.assertEqual(sm.sheet_state(self.t(["끝남", "끝남"], state="아직 안 함")), "끝남", "상태 칸이 늦어도 노드가 다 끝나면 끝남")
        self.assertEqual(sm.sheet_state(self.t([])), "준비")
        self.assertEqual(sm.sheet_state(self.t(["아직 안 함"])), "준비")
        self.assertEqual(sm.sheet_state(self.t(["아직 안 함"], waves=[{"at": "x"}])), "진행 중", "웨이브가 돌았으면 준비가 아니다")
        self.assertEqual(sm.sheet_state(self.t(["끝남", "확인 대기"])), "진행 중")

    def test_summary(self):
        t = self.t(["끝남", "확인 대기"], waves=[{"at": "2026-10-13 13:30"}, {"at": "2026-10-13 17:40"}])
        t["rows"] = [{"kind": "decision", "blocking": True}, {"kind": "decision", "blocking": False}]
        s = sm.sheet_summary(t)
        self.assertEqual((s["done"], s["total"], s["blocking"], s["to_check"], s["last"]), (1, 2, 1, 1, "2026-10-13 17:40"))


class Branch(Tmp):
    def test_plain_repo_and_worktree(self):
        (self.tmp / "main" / ".git").mkdir(parents=True)
        (self.tmp / "main" / ".git" / "HEAD").write_text("ref: refs/heads/feat/x\n")
        self.assertEqual(sm.git_branch(self.tmp / "main"), "feat/x")
        wt_git = self.tmp / "main" / ".git" / "worktrees" / "w"
        wt_git.mkdir(parents=True)
        (wt_git / "HEAD").write_text("ref: refs/heads/worktree/y\n")
        (self.tmp / "wt").mkdir()
        (self.tmp / "wt" / ".git").write_text(f"gitdir: {wt_git}\n")
        self.assertEqual(sm.git_branch(self.tmp / "wt"), "worktree/y")
        (wt_git / "HEAD").write_text("0123456789abcdef\n")
        self.assertEqual(sm.git_branch(self.tmp / "wt"), "", "분리 HEAD")
        self.assertEqual(sm.git_branch(self.tmp / "none"), "")


class SheetsApi(Tmp):
    def test_lists_every_workspace_and_reuses_unchanged(self):
        conf = mock.patch.object(sheet, "CONF", self.tmp / "no-roots")   # 이 PC에 등록된 레포가 섞이지 않게
        conf.start()
        self.addCleanup(conf.stop)
        a, b = self.tmp / "a", self.tmp / "b"
        a.mkdir(); b.mkdir()
        ra = Repo(a); ra.node("n1", "끝남"); ra.node("n2", "진행", deps=("n1",)); ra.write_spec()
        (ra.dir / "wave-20261013-1330.md").write_text("# wave 20261013-1330 · 스레드 t\n## 노드\n| n1 | 끝남 | x | y |\n", encoding="utf-8")
        rb = Repo(b, slug="h/u"); rb.node("n1", "끝남"); rb.write_spec()
        reg = sheet.Registry([a, b])
        srv = ThreadingHTTPServer(("127.0.0.1", 0), sheet.make_handler(reg))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{srv.server_address[1]}/api/sheets"
            got = json.load(urllib.request.urlopen(url))["sheets"]
            by = {(s["workspace"], s["slug"]): s for s in got}
            sa, sb = by[("a", "g/t")], by[("b", "h/u")]
            self.assertEqual((sa["group"], sa["done"], sa["total"], sa["last"], sa["repo"]), ("진행 중", 1, 2, "2026-10-13 13:30", "a"))
            self.assertEqual(sb["group"], "끝남")
            self.assertEqual(got[0]["slug"], "g/t", "마지막 웨이브가 최근인 시트가 앞")
            calls = []
            orig = sheet.build_board
            sheet.build_board = lambda root: calls.append(root) or orig(root)
            try:
                json.load(urllib.request.urlopen(url))
            finally:
                sheet.build_board = orig
            self.assertEqual(calls, [], "버전이 그대로면 보드를 다시 계산하지 않는다")
        finally:
            srv.shutdown(); srv.server_close()
            sheet._SHEETS.clear()


class Archive(Tmp):
    def test_archived_flag_is_written_alone_and_leaves_the_counts(self):
        r = Repo(self.tmp); r.node("n1", "확인 대기"); r.row("D1", "decision", blocks=["n1"]); r.write_spec()
        before = sm.build_board(self.tmp)["summary"]
        self.assertEqual((before["to_check"], before["decisions_open"]), (1, 1))
        sheet.save_ticket_user(r.dir, {"archived": True}, {"archived": False})
        b = sm.build_board(self.tmp)
        t = b["projects"][0]["tickets"][0]
        self.assertTrue(t["archived"])
        self.assertTrue(sm.sheet_summary(t)["archived"])
        self.assertEqual((b["summary"]["to_check"], b["summary"]["decisions_open"]), (0, 0), "보관한 시트는 Inbox·Decisions 숫자에 없다")
        tj = json.loads((r.dir / "ticket.json").read_text(encoding="utf-8"))
        self.assertEqual(tj["user"], {"priority": "", "paused": False, "archived": True})
        with self.assertRaises(ValueError):
            sm.clean_ticket_user({"archived": "yes"})
        with self.assertRaises(sheet.Conflict):   # 다른 곳에서 먼저 바꿨다
            sheet.save_ticket_user(r.dir, {"archived": False}, {"archived": False})
        sheet.save_ticket_user(r.dir, {"archived": False}, {"archived": True})
        self.assertFalse(sm.build_board(self.tmp)["projects"][0]["tickets"][0]["archived"])

    def test_repos_lists_workspaces_with_counts(self):
        conf = mock.patch.object(sheet, "CONF", self.tmp / "no-roots")
        conf.start()
        self.addCleanup(conf.stop)
        a = self.tmp / "a"; a.mkdir()
        ra = Repo(a); ra.node("n1", "끝남"); ra.write_spec()
        sheet.save_ticket_user(ra.dir, {"archived": True}, None)
        got = sheet.repos_info(sheet.Registry([a]), 8790)
        self.assertEqual(got["service"]["port"], 8790)
        self.assertEqual([(w["workspace"], w["sheets"], w["archived"]) for w in got["workspaces"]], [("a", 1, 1)])


if __name__ == "__main__":
    unittest.main()
