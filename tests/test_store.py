#!/usr/bin/env python3
"""사람 칸 저장소 — 레포 밖(~/.local/share/spec-board), 같은 레포의 워크트리끼리 공유, 옛 레포 안 칸은 한 번만 옮긴다.

  python3 -m unittest discover -s tests -p 'test_store.py'
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _store  # noqa: F401  사람 칸 저장소를 임시 폴더로

import sheet
import spec_model as sm

SPEC = "# s\n\n| 칸 | 값 |\n|---|---|\n| 상태 | 진행 |\n\n## 노드 인덱스\n\n| ID | 브리프 | deps | 상태 |\n|---|---|---|---|\n| n1 | n1-a.md | - | 확인 대기 |\n"


def git(cwd, *a):
    return subprocess.run(["git", "-C", str(cwd), *a], check=True, capture_output=True, text=True).stdout


class Store(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        t = self.repo / "spec" / "s"
        (t / "rows").mkdir(parents=True)
        (t / "spec.md").write_text(SPEC, encoding="utf-8")
        (t / "n1-a.md").write_text("# n1-a — a\n\n**상태**: 확인 대기\n", encoding="utf-8")
        (t / "rows" / "T1.json").write_text('{"id": "T1", "kind": "task", "title": "t"}', encoding="utf-8")
        git(self.repo, "init", "-q")
        git(self.repo, "add", "-A")
        git(self.repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x")
        self.wt = Path(self.tmp.name) / "wt"
        git(self.repo, "worktree", "add", "-q", str(self.wt))
        self.main_t, self.wt_t = t, self.wt / "spec" / "s"

    def tearDown(self):
        self.tmp.cleanup()

    def test_worktrees_share_one_store_outside_the_repo(self):
        self.assertEqual(sm.local_dir(self.main_t), sm.local_dir(self.wt_t))
        self.assertFalse(sm.local_dir(self.main_t).is_relative_to(self.repo.resolve()))
        sheet.save_node_user(self.wt_t, "n1", {"verdict": "통과"}, None)
        sheet.add_comment(self.wt_t, "n1", {"text": "워크트리에서 단 댓글"}, "user")
        n = sm.build_board(self.repo)["projects"][0]["tickets"][0]["nodes"][0]
        self.assertEqual((n["verdict"], n["comments"][0]["text"]), ("통과", "워크트리에서 단 댓글"), "main에서도 보인다")
        self.assertFalse((self.wt_t / "rows" / "nodes").exists(), "레포 안에는 아무것도 안 만든다")
        self.assertFalse((self.wt_t / "ticket.json").exists())

    def test_legacy_cells_move_once_and_do_not_come_back(self):
        nd = self.wt_t / "rows" / "nodes"
        nd.mkdir(parents=True)
        (nd / "n1.json").write_text(json.dumps({"id": "n1", "user": {"verdict": "통과", "fix": ""}}), encoding="utf-8")
        (self.wt_t / "ticket.json").write_text(json.dumps({"user": {"archived": True}}), encoding="utf-8")
        self.assertEqual(json.loads(sm.node_file(self.wt_t, "n1").read_text())["user"]["verdict"], "통과")
        self.assertTrue(json.loads(sm.ticket_file(self.wt_t).read_text())["user"]["archived"])
        self.assertTrue((nd / "n1.json").exists(), "옛 파일은 지우지 않는다")
        sheet.save_node_user(self.wt_t, "n1", {"verdict": ""}, None)   # 반영해서 비웠다
        sm._MIGRATED.clear()                                          # 서버를 다시 띄워도
        self.assertEqual(json.loads(sm.node_file(self.wt_t, "n1").read_text())["user"]["verdict"], "", "옛 값이 되살아나지 않는다")

    def test_second_worktree_legacy_fills_only_empty_cells(self):
        sheet.save_node_user(self.main_t, "n1", {"verdict": "통과"}, None)
        nd = self.wt_t / "rows" / "nodes"
        nd.mkdir(parents=True)
        (nd / "n1.json").write_text(json.dumps({"id": "n1", "user": {"verdict": "고쳐줘", "fix": "여백"}}), encoding="utf-8")
        sm._MIGRATED.clear()
        u = json.loads(sm.node_file(self.wt_t, "n1").read_text())["user"]
        self.assertEqual(u, {"verdict": "통과", "fix": "여백"})


if __name__ == "__main__":
    unittest.main()
