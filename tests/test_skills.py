#!/usr/bin/env python3
"""스킬 설치 명령 — 설치·최신 판정·갱신·남의 폴더 보호·삭제, TUI의 키 처리.

  python3 -m unittest discover -s tests -p 'test_skills.py'
"""
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))

import skills_cmd as sk


class Install(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.addCleanup(self._t.cleanup)
        self.root = str(Path(self._t.name) / "skills")   # 폴더 경로도 대상이 된다 — 진짜 ~/.claude를 건드리지 않는다

    def dest(self):
        return Path(self.root) / "spec-board"

    def test_bundle_has_skill_and_references(self):
        self.assertTrue((sk.bundle() / "SKILL.md").is_file())
        self.assertTrue((sk.bundle() / "references" / "rows.md").is_file())
        head = (sk.bundle() / "SKILL.md").read_text(encoding="utf-8").split("---")[1]
        self.assertIn("name: spec-board", head)
        self.assertIn("description:", head)

    def test_install_then_current_then_stale_after_change(self):
        self.assertEqual(sk.state(self.root), "none")
        self.assertIn("설치", sk.install(self.root))
        self.assertTrue((self.dest() / "SKILL.md").is_file())
        self.assertTrue((self.dest() / "references" / "reading.md").is_file())
        self.assertEqual(sk.state(self.root), "current")
        self.assertIn("이미 최신", sk.install(self.root))
        (self.dest() / sk.MARKER).write_text("옛 지문\n", encoding="utf-8")   # 패키지가 바뀐 것과 같다
        self.assertEqual(sk.state(self.root), "stale")
        self.assertIn("갱신", sk.install(self.root))
        self.assertEqual(sk.state(self.root), "current")

    def test_foreign_folder_is_never_overwritten_without_force(self):
        self.dest().mkdir(parents=True)
        (self.dest() / "mine.txt").write_text("내 파일")
        self.assertEqual(sk.state(self.root), "foreign")
        with self.assertRaises(ValueError):
            sk.install(self.root)
        with self.assertRaises(ValueError):
            sk.uninstall(self.root)
        self.assertTrue((self.dest() / "mine.txt").exists())
        sk.install(self.root, force=True)
        self.assertFalse((self.dest() / "mine.txt").exists())
        self.assertEqual(sk.state(self.root), "current")

    def test_uninstall_removes_only_ours(self):
        sk.install(self.root)
        self.assertIn("삭제", sk.uninstall(self.root))
        self.assertFalse(self.dest().exists())
        self.assertIn("설치돼 있지 않다", sk.uninstall(self.root))

    def test_main_target_and_list_and_uninstall(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(sk.main(["--target", self.root]), 0)
            self.assertEqual(sk.main(["--target", self.root, "--uninstall"]), 0)
        self.assertFalse(self.dest().exists())
        self.dest().mkdir(parents=True)
        with redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(sk.main(["--target", self.root]), 1)   # 남의 폴더는 건너뛰고 실패 코드
        self.assertIn("건너뜀", err.getvalue())

    def test_main_without_target_and_without_terminal_explains_instead_of_hanging(self):
        err = io.StringIO()
        with redirect_stderr(err), self.assertRaises(SystemExit) as e:
            sk.main([])
        self.assertIn("--target", str(e.exception))


class Keys(unittest.TestCase):
    def items(self):
        return [{"key": "a", "on": False}, {"key": "b", "on": True}, {"key": "c", "on": False}]

    def test_move_wraps_toggle_and_all(self):
        it = self.items()
        cur, res = sk.step(it, 0, "up")
        self.assertEqual((cur, res), (2, ""))
        cur, _ = sk.step(it, cur, "down")
        self.assertEqual(cur, 0)
        sk.step(it, 0, "space")
        self.assertTrue(it[0]["on"])
        sk.step(it, 0, "a")
        self.assertTrue(all(i["on"] for i in it))
        sk.step(it, 0, "a")
        self.assertFalse(any(i["on"] for i in it), "전부 켜져 있으면 a는 전부 끈다")

    def test_enter_applies_and_q_cancels(self):
        self.assertEqual(sk.step(self.items(), 1, "enter"), (1, "apply"))
        self.assertEqual(sk.step(self.items(), 1, "q"), (1, "cancel"))
        self.assertEqual(sk.step(self.items(), 1, "esc"), (1, "cancel"))
        self.assertEqual(sk.step(self.items(), 1, "x"), (1, ""))


if __name__ == "__main__":
    unittest.main()

