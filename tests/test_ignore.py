#!/usr/bin/env python3
"""ticket.json 자동 제외 — 보드가 만드는 로컬 설정 파일이 레포에 미추적으로 쌓이지 않게 한다.

  python3 -m unittest discover -s tests -p 'test_ignore.py'
"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))

import sheet


def git(cwd, *a):
    return subprocess.run(["git", "-C", str(cwd), *a], capture_output=True, text=True, check=True).stdout


def init(path: Path) -> Path:
    path.mkdir(parents=True)
    git(path, "init", "-q", "-b", "main")
    (path / "README.md").write_text("x")
    git(path, "add", "-A")
    git(path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
    return path


class TicketIgnore(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.addCleanup(self._t.cleanup)
        self.base = Path(self._t.name)

    def write_ticket(self, repo: Path) -> Path:
        d = repo / "spec" / "t1"
        d.mkdir(parents=True, exist_ok=True)
        (d / "ticket.json").write_text('{"user": {"archived": true}}')
        return d

    def test_untracked_ticket_json_stops_showing_up_and_second_call_adds_nothing(self):
        repo = init(self.base / "r")
        self.write_ticket(repo)
        self.assertIn("ticket.json", git(repo, "status", "--short", "-uall"))
        sheet.ensure_ticket_ignored(repo)
        self.assertNotIn("ticket.json", git(repo, "status", "--short", "-uall"))
        before = (repo / ".git" / "info" / "exclude").read_text()
        sheet.ensure_ticket_ignored(repo)
        self.assertEqual((repo / ".git" / "info" / "exclude").read_text(), before, "두 번 불러도 한 줄만")
        self.assertEqual(before.count(sheet.IGNORE_LINE), 1)
        self.assertEqual(git(repo, "ls-files"), "README.md\n", "추적 파일·.gitignore는 건드리지 않는다")

    def test_worktree_is_covered_through_the_shared_exclude(self):
        repo = init(self.base / "r")
        wt = self.base / "wt"
        git(repo, "worktree", "add", "-q", "-b", "side", str(wt))
        sheet.ensure_ticket_ignored(wt)
        self.write_ticket(wt)
        self.write_ticket(repo)
        self.assertNotIn("ticket.json", git(wt, "status", "--short", "-uall"))
        self.assertNotIn("ticket.json", git(repo, "status", "--short", "-uall"))

    def test_repo_that_already_tracks_ticket_json_keeps_its_own_choice(self):
        repo = init(self.base / "r")
        self.write_ticket(repo)
        git(repo, "add", "-A")
        git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "ticket")
        sheet.ensure_ticket_ignored(repo)
        self.assertFalse(sheet.IGNORE_LINE in (repo / ".git" / "info" / "exclude").read_text())

    def test_repo_with_gitignore_rule_is_left_alone(self):
        repo = init(self.base / "r")
        (repo / ".gitignore").write_text("**/ticket.json\n")
        sheet.ensure_ticket_ignored(repo)
        self.assertFalse(sheet.IGNORE_LINE in (repo / ".git" / "info" / "exclude").read_text())

    def test_non_git_folder_is_silent(self):
        plain = self.base / "plain"
        plain.mkdir()
        sheet.ensure_ticket_ignored(plain)   # 예외가 나지 않는다
        self.assertEqual(list(plain.iterdir()), [])

    def test_registering_a_root_and_saving_a_ticket_both_add_the_exclude(self):
        repo = init(self.base / "r")
        d = self.write_ticket(repo)
        (d / "ticket.json").unlink()
        (d / "spec.md").write_text("# t\n\n| 항목 | 값 |\n|---|---|\n| 문제 | x |\n| ID 머리 | T |\n")
        sheet.save_ticket_user(d, {"archived": True}, None)
        self.assertNotIn("ticket.json", git(repo, "status", "--short", "-uall"))


if __name__ == "__main__":
    unittest.main()

