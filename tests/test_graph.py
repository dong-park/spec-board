#!/usr/bin/env python3
"""graph.py ready 테스트."""
import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _store  # noqa: F401  사람 칸 저장소를 임시 폴더로
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_spec_model import Tmp

GRAPH = Path(__file__).resolve().parents[1] / "spec_board" / "graph.py"


def make(tmp: Path, nodes: dict, table: bool = True) -> Path:
    """nodes: {id: (deps, 상태)}"""
    rows = ["## 노드 인덱스", "", "| ID | 브리프 | deps | 상태 |", "|---|---|---|---|"]
    for k, (deps, st) in nodes.items():
        rows.append(f"| {k} | [{k}.md]({k}.md) | {deps or '—'} | x |")
        (tmp / f"{k}.md").write_text(f"# {k} — t\n\n**상태**: {st}\n\n## 문제\n\nx\n", encoding="utf-8")
    spec = tmp / "spec.md"
    spec.write_text("# s\n\n" + ("\n".join(rows) + "\n" if table else "본문\n"), encoding="utf-8")
    return spec


def run(spec: Path):
    p = subprocess.run([sys.executable, str(GRAPH), "ready", str(spec)], capture_output=True, text=True)
    return p


class GraphReadyTest(Tmp):
    def test_t1_ready_deterministic(self):
        spec = make(self.tmp, {
            "n1": ("", "끝남"), "n2": ("", "진행"), "n3": ("", "막힘"),
            "n4": ("n1", "아직 안 함"), "n5": ("n3", "아직 안 함")})
        a, b = run(spec), run(spec)
        self.assertEqual(a.returncode, 0)
        self.assertEqual(a.stdout, b.stdout)
        out = json.loads(a.stdout)
        self.assertEqual(out["ready"], ["n4"])
        self.assertEqual(out["running"], ["n2"])
        self.assertEqual(out["held"], ["n3", "n5"])
        self.assertFalse(out["done"])
        self.assertIsNone(out["error"])

    def test_unknown_state_is_held_and_natural_order(self):
        nodes = {f"n{i}": ("", "아직 안 함") for i in (10, 2, 1)}
        nodes["n3"] = ("", "failed")
        out = json.loads(run(make(self.tmp, nodes)).stdout)
        self.assertEqual(out["ready"], ["n1", "n2", "n10"])
        self.assertEqual(out["held"], ["n3"])

    def test_done(self):
        out = json.loads(run(make(self.tmp, {"n1": ("", "끝남")})).stdout)
        self.assertTrue(out["done"])

    def _broken(self, spec):
        p = run(spec)
        self.assertEqual(p.returncode, 2)
        out = json.loads(p.stdout)
        self.assertEqual(out["ready"], [])
        self.assertTrue(out["error"])
        return out["error"]

    def test_t2_cycle(self):
        e = self._broken(make(self.tmp, {"n1": ("n2", "아직 안 함"), "n2": ("n1", "아직 안 함")}))
        self.assertIn("n1", e)

    def test_t2_undefined_dep(self):
        e = self._broken(make(self.tmp, {"n1": ("n9", "아직 안 함")}))
        self.assertIn("n9", e)

    def test_t2_no_table(self):
        self._broken(make(self.tmp, {}, table=False))


if __name__ == "__main__":
    unittest.main()
