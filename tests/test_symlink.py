#!/usr/bin/env python3
"""심볼릭 링크 테스트 — spec.md·ticket.json·rows/·rows/*.json·README.md·브리프·evidence는 티켓 폴더 안의 실제 파일일 때만
읽고 쓴다. 링크가 폴더 밖을 가리켜도 내용이 보드·응답에 안 나오고, 밖의 파일은 바뀌지 않는다.

  python3 -m unittest discover -s tests -p 'test_symlink.py'
"""
import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))

import migrate_format
import node_state
import sheet
import spec_model as sm
from test_spec_model import Repo, Tmp

SECRET = "SECRET-OUTSIDE-CONTENT"


class SymlinkBase(Tmp):
    def setUp(self):
        super().setUp()
        self.out = self.tmp / "outside"
        self.out.mkdir()
        r = Repo(self.tmp)
        r.node("n1", "확인 대기", rows="T1")
        r.row("T1")
        r.write_spec()
        self.r = r
        self.t = r.dir

    def outside_file(self, name="secret.txt", text=SECRET):
        f = self.out / name
        f.write_text(text, encoding="utf-8")
        return f

    def link(self, at: Path, to: Path):
        at.parent.mkdir(parents=True, exist_ok=True)
        if at.exists() or at.is_symlink():
            at.unlink()
        os.symlink(to, at)

    def board_text(self):
        return json.dumps(sm.build_board(self.tmp), ensure_ascii=False)


class ReadTest(SymlinkBase):
    def test_spec_md_symlink_to_outside_file_shows_nothing(self):
        out = self.outside_file("spec.md", f"# {SECRET}\n\n| 항목 | 값 |\n|---|---|\n| 문제 | {SECRET} |\n| ID 머리 | XX |\n")
        self.link(self.t / "spec.md", out)
        self.assertNotIn(SECRET, self.board_text())
        self.assertEqual(sm.find_tickets(self.tmp), {})
        self.assertEqual(sm.read_spec_md(self.t), "")
        self.assertEqual(sm.node_keys(self.t), {"n1"})   # 표는 못 읽고 브리프 이름 앞토막만

    def test_ticket_dir_symlink_is_not_a_ticket(self):
        real = self.out / "evil"
        real.mkdir()
        (real / "spec.md").write_text(f"# {SECRET}\n\n| 항목 | 값 |\n|---|---|\n| ID 머리 | EV |\n", encoding="utf-8")
        self.link(self.tmp / "spec" / "g" / "evil", real)
        self.assertEqual(list(sm.find_tickets(self.tmp)), ["g/t"])
        self.assertNotIn(SECRET, self.board_text())

    def test_project_readme_symlink_shows_nothing(self):
        out = self.outside_file("README.md", f"# {SECRET}\n\n| 항목 | 값 |\n|---|---|\n| 문제 | {SECRET} |\n| 상태 | 진행 |\n")
        self.link(self.tmp / "spec" / "g" / "README.md", out)
        b = sm.build_board(self.tmp)
        self.assertNotIn(SECRET, json.dumps(b, ensure_ascii=False))
        self.assertEqual(b["projects"][0]["title"], "g")

    def test_brief_symlink_listed_in_the_table_is_not_read(self):
        out = self.outside_file("n1-demo.md", f"# n1-demo — {SECRET}\n\n**id**: ZZ-1\n**상태**: 끝남\n**담당 행**: T1\n\n## 문제\n\n{SECRET}\n")
        self.link(self.t / "n1-demo.md", out)
        text = self.board_text()
        self.assertNotIn(SECRET, text)
        t = sm.build_board(self.tmp)["projects"][0]["tickets"][0]
        n = next(n for n in t["nodes"] if n["key"] == "n1")
        self.assertNotEqual(n["state"], "끝남")
        self.assertTrue(n["error"])

    def test_unlisted_brief_symlink_is_not_picked_up(self):
        out = self.outside_file("n9-x.md", f"# n9-x — {SECRET}\n\n**상태**: 진행\n")
        self.link(self.t / "n9-x.md", out)
        t = sm.build_board(self.tmp)["projects"][0]["tickets"][0]
        self.assertEqual([n["key"] for n in t["nodes"]], ["n1"])
        self.assertNotIn(SECRET, self.board_text())

    def test_ticket_json_symlink_is_not_read(self):
        out = self.outside_file("ticket.json", json.dumps({"user": {"priority": SECRET[:19], "paused": True}}))
        self.link(self.t / "ticket.json", out)
        t = sm.build_board(self.tmp)["projects"][0]["tickets"][0]
        self.assertFalse(t["paused"])
        self.assertNotIn(SECRET[:19], t["priority_user"])
        self.assertEqual(sheet.apply_sheet(self.t), [])

    def test_rows_dir_symlink_hides_every_row(self):
        real = self.out / "rows"
        real.mkdir()
        (real / "T9.json").write_text(json.dumps({"id": "T9", "kind": "task", "title": SECRET, "status": "끝남"}), encoding="utf-8")
        for f in (self.t / "rows").iterdir():
            f.unlink()
        (self.t / "rows").rmdir()
        self.link(self.t / "rows", real)
        self.assertNotIn(SECRET, self.board_text())
        self.assertEqual(sheet.find_sheets(self.tmp), {})
        with self.assertRaises(ValueError):   # apply는 빈 목록으로 얼버무리지 않고 거부한다
            sheet.apply_sheet(self.t)

    def test_row_file_symlink_is_skipped(self):
        out = self.outside_file("D1.json", json.dumps({"id": "D1", "kind": "decision", "title": SECRET, "status": "아직 안 함",
                                                       "user": {"answer": "A", "fix": ""}}))
        self.link(self.t / "rows" / "D1.json", out)
        self.assertNotIn(SECRET, self.board_text())
        self.assertEqual([x["id"] for x in sheet.apply_sheet(self.t)], [])
        with self.assertRaises(KeyError):
            sheet.patch_row(self.t, "D1", {"log+": "x"})
        self.assertEqual(json.loads(out.read_text())["user"]["answer"], "A")

    def test_node_cell_symlink_is_skipped(self):
        out = self.outside_file("n1.json", json.dumps({"id": "n1", "user": {"verdict": "통과", "fix": SECRET}}))
        self.link(self.t / "rows" / "nodes" / "n1.json", out)
        t = sm.build_board(self.tmp)["projects"][0]["tickets"][0]
        n = t["nodes"][0]
        self.assertEqual((n["verdict"], n["fix"]), ("", ""))
        self.assertEqual(sheet.apply_sheet(self.t), [])

    def test_evidence_dir_symlink_is_not_listed(self):
        real = self.out / "ev"
        real.mkdir()
        (real / "shot.png").write_text(SECRET, encoding="utf-8")
        self.link(self.t / "evidence" / "n1", real)
        n = sm.build_board(self.tmp)["projects"][0]["tickets"][0]["nodes"][0]
        self.assertEqual(n["evidence"], [])

    def test_evidence_file_symlink_is_not_listed(self):
        out = self.outside_file("shot.png")
        (self.t / "evidence" / "n1").mkdir(parents=True)
        (self.t / "evidence" / "n1" / "ok.png").write_text("ok", encoding="utf-8")
        self.link(self.t / "evidence" / "n1" / "leak.png", out)
        n = sm.build_board(self.tmp)["projects"][0]["tickets"][0]["nodes"][0]
        self.assertEqual(n["evidence"], ["ok.png"])

    def test_json_files_skips_links_and_dirs_behind_links(self):
        out = self.outside_file("x.json", "{}")
        self.link(self.t / "rows" / "X.json", out)
        names = [f.name for f in sm.json_files(self.t / "rows", self.t)]
        self.assertEqual(names, ["T1.json"])

    def test_lint_does_not_read_symlinked_spec(self):
        out = self.outside_file("spec.md", "| 상태 | 엉뚱한 값 |\n")
        self.link(self.t / "spec.md", out)
        lines = []

        class W:
            def write(self, s):
                lines.append(s)

        migrate_format.check([self.t], out=W())
        self.assertNotIn("엉뚱한 값", "".join(lines))


class WriteTest(SymlinkBase):
    def test_node_cell_write_refuses_a_symlinked_cell_and_leaves_the_outside_file_alone(self):
        out = self.outside_file("n1.json", json.dumps({"id": "n1", "user": {"verdict": "", "fix": ""}}))
        before = out.read_text()
        self.link(self.t / "rows" / "nodes" / "n1.json", out)
        with self.assertRaises(ValueError):
            sheet.save_node_user(self.t, "n1", {"verdict": "통과"}, None)
        self.assertEqual(out.read_text(), before)

    def test_node_cell_write_refuses_a_symlinked_nodes_dir(self):
        real = self.out / "nodes"
        real.mkdir()
        self.link(self.t / "rows" / "nodes", real)
        with self.assertRaises(ValueError):
            sheet.save_node_user(self.t, "n1", {"verdict": "통과"}, None)
        self.assertEqual(list(real.iterdir()), [])

    def test_ticket_json_write_refuses_a_symlink(self):
        out = self.outside_file("ticket.json", json.dumps({"user": {"priority": "", "paused": False}}))
        before = out.read_text()
        self.link(self.t / "ticket.json", out)
        with self.assertRaises(ValueError):
            sheet.save_ticket_user(self.t, {"priority": "P0"}, None)
        self.assertEqual(out.read_text(), before)

    def test_rows_dir_symlink_refuses_writes_and_creates_nothing_outside(self):
        real = self.out / "rows"
        real.mkdir()
        (real / "T1.json").write_text(json.dumps({"id": "T1", "kind": "task", "user": {"answer": "", "fix": ""}}), encoding="utf-8")
        for f in (self.t / "rows").iterdir():
            f.unlink()
        (self.t / "rows").rmdir()
        self.link(self.t / "rows", real)
        before = sorted(p.name for p in real.iterdir())
        with self.assertRaises((ValueError, KeyError)):
            sheet.save_user(self.t, "T1", {"answer": "x"}, None)
        with self.assertRaises(ValueError):
            sheet.save_ticket_user(self.t, {"priority": "P1"}, None)
        with self.assertRaises(ValueError):
            with sheet.locked(self.t):
                pass
        self.assertEqual(sorted(p.name for p in real.iterdir()), before)    # .lock도 안 만들었다
        self.assertEqual(json.loads((real / "T1.json").read_text())["user"]["answer"], "")

    def test_lock_file_symlink_is_refused(self):
        out = self.outside_file("lock", "")
        self.link(self.t / "rows" / ".lock", out)
        with self.assertRaises(ValueError):
            with sheet.locked(self.t):
                pass

    def test_brief_symlink_is_not_written_by_node_state(self):
        out = self.outside_file("n2-x.md", "# n2\n\n**상태**: 진행\n")
        before = out.read_text()
        self.link(self.t / "n2-x.md", out)
        with self.assertRaises(SystemExit):
            node_state.set_status(self.t / "n2-x.md", "확인 대기")
        with self.assertRaises(SystemExit):
            node_state.review(self.t / "n2-x.md", [])
        with self.assertRaises(SystemExit):
            node_state.block(self.t / "n2-x.md", "t", ["A:x"])
        with self.assertRaises(SystemExit):
            node_state._brief(str(self.t / "n2-x.md"))
        self.assertEqual(out.read_text(), before)

    def test_review_refuses_a_symlinked_evidence_dir_and_moves_nothing(self):
        real = self.out / "ev"
        real.mkdir()
        self.link(self.t / "evidence", real)
        src = self.tmp / "shot.png"
        src.write_text("본문", encoding="utf-8")
        with self.assertRaises(SystemExit):
            node_state.review(self.t / "n1-demo.md", [str(src)])
        self.assertTrue(src.exists())
        self.assertEqual(list(real.iterdir()), [])

    def test_review_refuses_a_symlinked_evidence_source(self):
        out = self.outside_file("shot.png")
        src = self.tmp / "link.png"
        self.link(src, out)
        with self.assertRaises(SystemExit):
            node_state.review(self.t / "n1-demo.md", [str(src)])
        self.assertTrue(out.exists())
        self.assertFalse((self.t / "evidence").exists())

    def test_verdict_leaves_a_symlinked_cell_alone(self):
        out = self.outside_file("n1.json", json.dumps({"id": "n1", "user": {"verdict": "통과", "fix": ""}}))
        before = out.read_text()
        self.link(self.t / "rows" / "nodes" / "n1.json", out)
        r = node_state.verdict(self.t / "n1-demo.md")
        self.assertFalse(r["applied"])
        self.assertEqual(out.read_text(), before)
        self.assertEqual(node_state.read_status((self.t / "n1-demo.md").read_text(encoding="utf-8")), "확인 대기")

    def test_block_refuses_a_symlinked_rows_dir(self):
        real = self.out / "rows"
        real.mkdir()
        for f in (self.t / "rows").iterdir():
            f.unlink()
        (self.t / "rows").rmdir()
        self.link(self.t / "rows", real)
        with self.assertRaises(SystemExit):
            node_state.block(self.t / "n1-demo.md", "t", ["A:x", "B:y"], "A")
        self.assertEqual(list(real.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
