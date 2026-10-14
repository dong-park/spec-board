#!/usr/bin/env python3
"""migrate_format.py(린트) 테스트 — 쓰지 않는다 · HTML 주석을 값에서 뗀다 · `## 노드 인덱스 (…)` 접두 허용 · 위반을 센다.

  python3 -m unittest discover -s tests -p 'test_spec_lint.py'
"""
from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))

import migrate_format as lint

SCRIPT = Path(lint.__file__).resolve()

SPEC = """# {title}

| 항목 | 값 |
|---|---|
| 문제 | 왜 하는가 |
| 상태 | {state} <!-- 아직 안 함 | 진행 | 확인 대기 | 막힘 | 보류 | 끝남 -->|
| ID 머리 | {head} |

## 노드 인덱스{suffix}

<!-- 상태 칸은 참고용이다 | 아직 안 함 | 진행 -->

| ID | 브리프 | deps | 상태 |
|---|---|---|---|
| n1 | [n1-one.md](n1-one.md) | — | {st1} |
"""

NODE = """# n1-one — 하나

**agent**: runner
**id**: {nid}
**deps**: 없음
**상태**: {state} <!-- 아직 안 함 | 진행 | 확인 대기 | 막힘 | 보류 | 끝남 -->
**담당 행**: {rows}

## 문제

하나.
"""


class LintTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="lint-test-")
        self.repo = Path(self.tmp.name)
        (self.repo / ".git").mkdir()
        self.t = self.repo / "spec" / "stem" / "alpha"
        (self.t / "rows").mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def ticket(self, d=None, *, state="진행", head="AL", suffix="", st1="진행", nid="AL-1", nstate="진행",
               rows="T1, T2", row_status="끝남"):
        d = d or self.t
        (d / "rows").mkdir(parents=True, exist_ok=True)
        (d / "spec.md").write_text(SPEC.format(title=d.name, state=state, head=head, suffix=suffix, st1=st1), encoding="utf-8")
        (d / "n1-one.md").write_text(NODE.format(nid=nid, state=nstate, rows=rows), encoding="utf-8")
        (d / "rows" / "T1.json").write_text(json.dumps({"id": "T1", "kind": "task", "status": row_status, "user": {}}), encoding="utf-8")
        return d

    def run_check(self, *paths):
        out = io.StringIO()
        code = lint.check([Path(p) for p in (paths or [self.t])], out)
        return code, out.getvalue()

    def snapshot(self):
        return {str(p): p.read_bytes() for p in self.repo.rglob("*") if p.is_file()}

    def test_clean_ticket_with_html_comments_passes(self):
        self.ticket()
        code, out = self.run_check()
        self.assertEqual(code, 0, out)
        self.assertIn("위반 0줄", out)

    def test_value_is_compared_without_its_html_comment(self):
        # 값 뒤 주석 안에 어휘 밖 글자·파이프가 있어도 값만 본다
        self.ticket(state="확인 대기", nstate="막힘")
        self.assertEqual(self.run_check()[0], 0)

    def test_node_index_state_column_is_reference_only_and_not_linted(self):
        # 표 4열은 아무도 읽지 않는 참고 칸이다 — 어휘 밖 값이 있어도 위반이 아니다. 원본은 브리프 상태 줄 한 곳
        self.ticket(suffix=" (참고용 — 상태 원본은 브리프)", st1="done")
        code, out = self.run_check()
        self.assertEqual(code, 0, out)
        self.assertNotIn("(노드 표)", out)

    def test_vocabulary_violations_are_reported_with_line_numbers(self):
        self.ticket(state="running", nstate="pending", row_status="done")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertRegex(out, r"spec\.md:6: 어휘 밖 값 'running'")
        self.assertRegex(out, r"n1-one\.md:\d+: 어휘 밖 값 'pending'")
        self.assertIn("T1.json: 어휘 밖 값 'done'", out)

    def test_missing_head_missing_id_and_bad_owner_rows(self):
        self.ticket(head="", nid="AL-1", rows="T1(괄호), T2")
        (self.t / "n2-two.md").write_text("# n2\n\n**상태**: 진행\n", encoding="utf-8")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("ID 머리 없음", out)
        self.assertIn("담당 행 꼴 위반 'T1(괄호), T2'", out)
        self.assertIn("n2-two.md: id 없음", out)
        self.assertIn("n2-two.md: 담당 행 꼴 위반 — **담당 행** 줄이 없음", out)

    def test_duplicate_heads_and_node_ids_in_one_repo(self):
        self.ticket()
        other = self.ticket(self.repo / "spec" / "stem" / "beta")
        code, out = self.run_check(self.repo / "spec" / "stem")
        self.assertEqual(code, 1)
        self.assertIn("머리 'AL'가", out)
        self.assertIn("노드 id 'AL-1'가 겹침", out)
        self.assertTrue(other.exists())

    def test_broken_files_are_skipped_not_violations(self):
        self.ticket()
        (self.t / "rows" / "broken.json").write_text("{ not json", encoding="utf-8")
        (self.t / "n2-bin.md").write_bytes(b"\xff\xfe\x00")
        code, out = self.run_check()
        self.assertEqual(code, 0, out)
        self.assertIn("건너뜀 2", out)

    def test_tmp_files_from_atomic_writes_are_not_rows(self):
        self.ticket()
        (self.t / "rows" / ".tmp-abc.json").write_text("{partial", encoding="utf-8")
        self.assertEqual(self.run_check()[0], 0)

    def test_lint_never_writes(self):
        self.ticket(state="running", nstate="pending")
        before = self.snapshot()
        self.run_check()
        subprocess.run([sys.executable, str(SCRIPT), "--check", str(self.t)], capture_output=True, text=True)
        subprocess.run([sys.executable, str(SCRIPT), str(self.t)], capture_output=True, text=True)
        self.assertEqual(before, self.snapshot())

    def test_no_ticket_is_exit_1(self):
        empty = self.repo / "empty"
        empty.mkdir()
        self.assertEqual(self.run_check(empty)[0], 1)

    def test_write_flag_is_gone(self):
        self.ticket()
        r = subprocess.run([sys.executable, str(SCRIPT), "--write", str(self.t)], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("unrecognized arguments", r.stderr)

    def test_migration_code_is_removed(self):
        src = SCRIPT.read_text(encoding="utf-8")
        for name in ("def run(", "migrate_row", "migrate_node_text", "migrate_ticket_text", "assign_heads", "import sheet"):
            self.assertNotIn(name, src, name)

    def test_cli_exit_codes(self):
        self.ticket()
        ok = subprocess.run([sys.executable, str(SCRIPT), "--check", str(self.t)], capture_output=True, text=True)
        self.assertEqual(ok.returncode, 0, ok.stdout)
        self.ticket(state="done")
        bad = subprocess.run([sys.executable, str(SCRIPT), "--check", str(self.t)], capture_output=True, text=True)
        self.assertEqual(bad.returncode, 1)


if __name__ == "__main__":
    unittest.main()
