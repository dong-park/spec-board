#!/usr/bin/env python3
"""워크스페이스 주소 키 — 원본 체크아웃은 폴더 이름, 링크된 워크트리는 "<이름>-<워크트리 폴더>".

  python3 -m unittest discover -s tests -p 'test_workspace_keys.py'
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))

import sheet


def checkout(base: Path, rel: str, worktree: bool) -> Path:
    p = base / rel
    p.mkdir(parents=True)
    if worktree:
        (p / ".git").write_text("gitdir: /x/.git/worktrees/y\n")   # 링크된 워크트리는 .git이 파일이다
    else:
        (p / ".git").mkdir()
    return p


class WorkspaceKeys(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_worktrees_get_name_dash_folder_and_original_keeps_name(self):
        main = checkout(self.base, "my-repo", worktree=False)
        a = checkout(self.base, "wt/2ac1/my-repo", worktree=True)
        b = checkout(self.base, "wt/d01e/my-repo", worktree=True)
        self.assertEqual(sheet.assign_keys([b, a, main]), {"my-repo": main, "my-repo-2ac1": a, "my-repo-d01e": b})

    def test_worktree_key_does_not_change_when_other_workspaces_come_and_go(self):
        a = checkout(self.base, "wt/2ac1/my-repo", worktree=True)
        b = checkout(self.base, "wt/d01e/my-repo", worktree=True)
        self.assertEqual(sheet.assign_keys([b])["my-repo-d01e"], b)
        self.assertEqual(sheet.assign_keys([a, b])["my-repo-d01e"], b)

    def test_single_plain_folder_keeps_its_name(self):
        p = checkout(self.base, "demo", worktree=False)
        self.assertEqual(sheet.assign_keys([p]), {"demo": p})

    def test_two_plain_folders_with_same_name_stay_distinct(self):
        a = checkout(self.base, "x/repo", worktree=False)
        b = checkout(self.base, "y/repo", worktree=False)
        keys = sheet.assign_keys([a, b])
        self.assertEqual(sorted(keys.values()), sorted([a, b]))
        self.assertEqual(len(keys), 2)


if __name__ == "__main__":
    unittest.main()
