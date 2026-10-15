#!/usr/bin/env python3
"""spec_model.py·sheet.py 보드 경로 테스트 — 실제 glass-wall 읽기, 칸 계산, 불가능한 조합, 사람 칸 쓰기.

  python3 -m unittest discover -s tests -p 'test_spec_model.py'
"""
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _store  # noqa: F401  사람 칸 저장소를 임시 폴더로

import sheet
import spec_model as sm



def brief(key, state="아직 안 함", deps="없음", rows="", ident="", check="", extra=""):
    lines = [f"# {key}-demo — 데모", "", "**agent**: runner", f"**id**: {ident}" if ident else "",
             "**상위**: spec/g/t/spec.md", f"**deps**: {deps}", f"**상태**: {state}", f"**담당 행**: {rows}"]
    if check:
        lines.append(f"**사람 확인**: {check}")
    if extra:
        lines.append(extra)
    return "\n".join(l for l in lines if l is not None) + "\n\n## 문제\n\n데모 문제.\n"


class Repo:
    """임시 레포 — spec/g/README.md(줄기) 아래 티켓 하나."""

    def __init__(self, tmp: Path, slug="g/t", head="TT", ticket_state="진행"):
        self.root = tmp
        self.dir = tmp / "spec" / slug
        self.slug = slug
        self.dir.mkdir(parents=True)
        (tmp / "spec" / slug.split("/")[0] / "README.md").write_text(
            "# 줄기\n\n| 항목 | 값 |\n|---|---|\n| 종류 | 줄기 |\n| 문제 | 줄기 문제 |\n| 상태 | 진행 |\n", encoding="utf-8")
        self.head, self.ticket_state = head, ticket_state
        self.index: list[tuple] = []

    def node(self, key, state="아직 안 함", table=None, deps=(), rows="", check="", name="demo", brief_state=True):
        """브리프와 노드 인덱스 표 한 줄을 만든다. table이 None이면 표도 브리프와 같은 값."""
        f = f"{key}-{name}.md"
        text = brief(key, state, ", ".join(deps) or "없음", rows, f"{self.head}-{key[1:]}", check)
        if not brief_state:
            text = text.replace(f"**상태**: {state}\n", "")
        (self.dir / f).write_text(text, encoding="utf-8")
        self.index.append((key, f, ", ".join(deps) or "—", table if table is not None else state))

    def row(self, rid, kind="task", status="아직 안 함", blocks=(), reversible=True, user=None, title=""):
        (self.dir / "rows").mkdir(exist_ok=True)
        (self.dir / "rows" / f"{rid}.json").write_text(json.dumps({
            "id": rid, "kind": kind, "title": title or rid, "given": "g", "when": "w", "then": "t",
            "options": [], "recommend": "", "confidence": "high", "reversible": reversible, "status": status,
            "blocks": list(blocks), "user": user or {"answer": "", "fix": ""}, "log": []}, ensure_ascii=False))

    def write_spec(self):
        table = "\n".join(f"| {k} | [{f}]({f}) | {d} | {s} |" for k, f, d, s in self.index)
        (self.dir / "spec.md").write_text(
            f"# 데모 티켓\n\n| 항목 | 값 |\n|---|---|\n| 문제 | 데모 문제 |\n| 상태 | {self.ticket_state} |\n"
            f"| ID 머리 | {self.head} |\n| 우선순위 | P1 |\n\n## 노드 인덱스\n\n| ID | 브리프 | deps | 상태 |\n|---|---|---|---|\n{table}\n",
            encoding="utf-8")
        return self

    def board(self):
        self.write_spec()
        b = sm.build_board(self.root)
        t = b["projects"][0]["tickets"][0]
        return t, {n["key"]: n for n in t["nodes"]}, {r["id"]: r for r in t["rows"]}


class Tmp(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()


# ── 실제 glass-wall ───────────────────────────────────────────

class ColumnTest(Tmp):
    def test_ready_vs_waiting(self):
        r = Repo(self.tmp)
        r.node("n1", "끝남")
        r.node("n2", "아직 안 함", deps=["n1"])
        r.node("n3", "아직 안 함", deps=["n1", "n2"])
        t, n, _ = r.board()
        self.assertEqual(n["n1"]["column"], "끝남")
        self.assertEqual(n["n2"]["column"], "시작 가능")
        self.assertEqual(n["n3"]["column"], "기다림")
        self.assertEqual(n["n3"]["waiting_on"], ["n2"])
        self.assertEqual(t["counts"], {"시작 가능": 1, "진행": 0, "확인 대기": 0, "기다림": 1, "끝남": 1})

    def test_blocked_on_top_of_waiting_and_paused_also_waits(self):
        r = Repo(self.tmp)
        r.node("n1", "끝남")
        r.node("n2", "보류", deps=["n1"])
        r.node("n3", "아직 안 함", deps=["n9"])
        r.node("n4", "막힘", deps=["n1"])
        r.row("D1", "decision", blocks=["n4"])
        t, n, _ = r.board()
        wait = [x["key"] for x in t["nodes"] if x["column"] == "기다림"]
        self.assertEqual(wait, ["n4", "n2", "n3"], "막힘 → 보류 → 아직 안 함")
        self.assertEqual({x["column"] for x in t["nodes"]} - {"끝남"}, {"기다림"})

    def test_progress_and_review_columns(self):
        r = Repo(self.tmp)
        r.node("n1", "진행")
        r.node("n2", "확인 대기", check="필요")
        t, n, _ = r.board()
        self.assertEqual((n["n1"]["column"], n["n2"]["column"]), ("진행", "확인 대기"))
        self.assertTrue(n["n2"]["needs_check"])

    def test_long_dep_names_from_brief_resolve(self):
        r = Repo(self.tmp)
        r.node("n1", "끝남", name="ime-guard")
        r.node("n2", "아직 안 함")
        # 표에는 deps가 비었고 브리프에만 이름 붙은 deps가 있다 → 표가 원본이라 표를 따른다
        t, n, _ = r.board()
        self.assertEqual(n["n2"]["column"], "시작 가능")
        brief_only = r.dir / "n3-x.md"
        brief_only.write_text(brief("n3", "아직 안 함", "n1-ime-guard, n2"), encoding="utf-8")
        t, n, _ = r.board()  # 표에 없는 브리프 → 브리프 deps를 쓰고 이름을 key로 푼다
        self.assertEqual(n["n3"]["deps"], ["n1", "n2"])
        self.assertEqual(n["n3"]["column"], "기다림")
        self.assertIn("not-in-index", [w["code"] for w in n["n3"]["warnings"]])

    def test_old_values_mix(self):
        r = Repo(self.tmp)
        r.node("n1", "done")           # 옛 영어 값
        r.node("n2", "pending", deps=["n1"])
        r.node("n3", "blocked", deps=["n1"])
        r.row("D1", "decision", blocks=["n3"])
        t, n, _ = r.board()
        self.assertEqual([n["n1"]["state"], n["n2"]["state"], n["n3"]["state"]], ["끝남", "아직 안 함", "막힘"])
        self.assertEqual(n["n2"]["column"], "시작 가능")

    def test_brief_is_the_only_state_source_and_table_column_is_ignored(self):
        """D-R3 — 노드 인덱스 표 4열은 참고용이다. 브리프가 `아직 안 함`이어도 표 값으로 바꾸지 않는다."""
        r = Repo(self.tmp)
        r.node("n1", "아직 안 함", table="끝남")   # 표만 끝남으로 고친 경우 — 보드는 표를 안 믿는다
        r.node("n2", "확인 대기", table="진행")
        r.node("n3", "끝남", table="아직 안 함")
        t, n, _ = r.board()
        self.assertEqual([n["n1"]["state"], n["n2"]["state"], n["n3"]["state"]], ["아직 안 함", "확인 대기", "끝남"])
        self.assertEqual(n["n1"]["column"], "시작 가능")
        self.assertNotIn("state_source", n["n1"])

    def test_brief_without_status_line_is_unknown_with_a_warning_not_the_table(self):
        r = Repo(self.tmp)
        r.node("n1", "끝남", table="끝남", brief_state=False)
        t, n, _ = r.board()
        self.assertEqual(n["n1"]["state"], "모름")
        self.assertIn("no-status", [w["code"] for w in n["n1"]["warnings"]])
        self.assertEqual(n["n1"]["column"], "기다림")

    def test_ids_prefer_brief_and_fall_back_to_head(self):
        r = Repo(self.tmp, head="ZZ")
        r.node("n7", "끝남")
        (r.dir / "n8-demo.md").write_text("# n8\n\n**상태**: 끝남\n", encoding="utf-8")
        r.index.append(("n8", "n8-demo.md", "—", "끝남"))
        _, n, _ = r.board()
        self.assertEqual(n["n7"]["id"], "ZZ-7")
        self.assertEqual(n["n8"]["id"], "ZZ-8")

    def test_row_ids_ranges_and_parentheses(self):
        self.assertEqual(sm.row_ids("T2 · T3(힌트가 사라지는 조건) · T1(빈 벽 화면 부분)"), ["T2", "T3", "T1"])
        self.assertEqual(sm.row_ids("T9–T12, T1"), ["T9", "T10", "T11", "T12", "T1"])
        self.assertEqual(sm.row_ids("없음"), [])
        self.assertEqual(sm.row_ids("<!-- 예: T5, T6 -->"), [])


# ── 불가능한 조합 5종 ────────────────────────────────────────────

class ImpossibleTest(Tmp):
    def codes(self, items):
        return [w["code"] for w in items["warnings"]]

    def test_1_progress_with_unfinished_dep(self):
        r = Repo(self.tmp)
        r.node("n1", "진행")
        r.node("n2", "진행", deps=["n1"])
        _, n, _ = r.board()
        self.assertIn("progress-before-deps", self.codes(n["n2"]))
        self.assertNotIn("progress-before-deps", self.codes(n["n1"]))

    def test_2_blocked_without_open_decision(self):
        r = Repo(self.tmp)
        r.node("n1", "막힘")
        r.node("n2", "막힘")
        r.row("D1", "decision", status="끝남", blocks=["n2"])
        r.row("D2", "decision", status="아직 안 함", blocks=["n1"])
        _, n, _ = r.board()
        self.assertNotIn("blocked-without-decision", self.codes(n["n1"]))   # 열린 결정이 막고 있다
        self.assertIn("blocked-without-decision", self.codes(n["n2"]))      # 결정은 이미 끝났다
        self.assertEqual(n["n1"]["blocked_by_ids"], ["TT-D2"])

    def test_2b_blocked_via_owned_row(self):
        r = Repo(self.tmp)
        r.node("n1", "막힘", rows="T1")
        r.row("T1", "task")
        r.row("D1", "decision", blocks=["T1"])
        _, n, _ = r.board()
        self.assertNotIn("blocked-without-decision", self.codes(n["n1"]))

    def test_3_ticket_done_with_unpassed_scenario(self):
        r = Repo(self.tmp, ticket_state="끝남")
        r.node("n1", "끝남", rows="T1")
        r.row("T1", "task", status="끝남")
        r.row("T2", "task", status="아직 안 함")   # 담당 노드도 없다
        t, _, rows = r.board()
        self.assertIn("done-with-open-scenarios", self.codes(t))
        self.assertIn("T2", t["warnings"][0]["text"])
        self.assertEqual(t["unowned"], ["T2"])
        self.assertEqual(t["scenarios"], {"total": 2, "passed": 1})

    def test_3b_ticket_done_clean(self):
        r = Repo(self.tmp, ticket_state="끝남")
        r.node("n1", "끝남", rows="T1")
        r.row("T1", "task", status="아직 안 함")   # 행은 안 닫혔어도 담당 노드가 다 끝났으면 통과
        t, _, rows = r.board()
        self.assertEqual(self.codes(t), [])
        self.assertTrue(rows["T1"]["passed"])

    def test_4_done_with_fix_verdict(self):
        r = Repo(self.tmp)
        r.node("n1", "끝남", check="필요")
        r.write_spec()
        nf = sm.local_dir(r.dir) / "nodes"
        nf.mkdir(parents=True, exist_ok=True)
        (nf / "n1.json").write_text(json.dumps({"id": "n1", "user": {"verdict": "고쳐줘", "fix": "여백"}}))
        _, n, _ = r.board()
        self.assertIn("done-with-fix", self.codes(n["n1"]))
        self.assertEqual((n["n1"]["verdict"], n["n1"]["fix"]), ("고쳐줘", "여백"))

    def test_5_decision_done_but_node_still_blocked(self):
        r = Repo(self.tmp)
        r.node("n1", "막힘")
        r.row("D1", "decision", status="끝남", blocks=["n1"])
        _, n, rows = r.board()
        self.assertIn("decision-done-node-blocked", self.codes(n["n1"]))
        self.assertIn("decision-done-node-blocked", self.codes(rows["D1"]))

    def test_clean_board_has_no_warnings(self):
        r = Repo(self.tmp)
        r.node("n1", "끝남")
        r.node("n2", "진행", deps=["n1"])
        r.node("n3", "막힘", deps=["n1"])
        r.row("D1", "decision", blocks=["n3"])
        t, n, _ = r.board()
        self.assertEqual([w for x in n.values() for w in x["warnings"]], [])
        self.assertEqual(t["warnings"], [])


# ── 읽기 실패·결정 ID·섞인 형식 ────────────────────────────────

class RobustTest(Tmp):
    def test_broken_brief_is_a_card_not_a_crash(self):
        r = Repo(self.tmp)
        r.node("n1", "끝남")
        r.node("n2", "아직 안 함", deps=["n1"])
        (r.dir / "n2-demo.md").write_bytes(b"\xff\xfe\x00broken")   # 읽을 수 없다
        r.index.append(("n3", "n3-gone.md", "—", "아직 안 함"))     # 파일이 없다
        t, n, _ = r.board()
        self.assertTrue(n["n2"]["error"].startswith("읽기 실패"))
        self.assertTrue(n["n3"]["error"].startswith("읽기 실패"))
        self.assertEqual(n["n1"]["error"], "")
        self.assertEqual((n["n2"]["state"], n["n2"]["column"]), ("모름", "기다림"))   # 표 값은 안 믿는다 (D-R3) — 카드는 그리되 모름

    def test_headless_brief_flagged(self):
        r = Repo(self.tmp)
        r.node("n1", "끝남")
        (r.dir / "n1-demo.md").write_text("# n1\n\n그냥 글\n", encoding="utf-8")
        _, n, _ = r.board()
        self.assertIn("read-failed", [w["code"] for w in n["n1"]["warnings"]])

    def test_broken_row_file_and_broken_ticket_do_not_stop_board(self):
        r = Repo(self.tmp)
        r.node("n1", "끝남")
        r.row("T1")
        (r.dir / "rows" / "T2.json").write_text("{not json")
        r.write_spec()
        other = self.tmp / "spec" / "g" / "bad"
        other.mkdir()
        (other / "spec.md").write_bytes(b"\xff\xfe")
        b = sm.build_board(self.tmp)
        tickets = {t["slug"]: t for p in b["projects"] for t in p["tickets"]}
        self.assertEqual(set(tickets), {"g/t", "g/bad"})
        self.assertTrue(tickets["g/bad"]["error"].startswith("읽기 실패"))
        self.assertTrue(next(r for r in tickets["g/t"]["rows"] if r["id"] == "T2")["read_error"])

    def test_decision_display_id_and_flat_list(self):
        r = Repo(self.tmp, head="WM")
        r.node("n1", "막힘")
        r.row("D15", "decision", reversible=False, blocks=["n1"])
        r.write_spec()
        b = sm.build_board(self.tmp)
        self.assertNotIn("decisions", b)   # 복제본은 안 싣는다 — 화면이 티켓 rows에서 모은다
        d = next(r for t in b["projects"][0]["tickets"] for r in t["rows"] if r["kind"] == "decision")
        self.assertEqual(d["display_id"], "WM-D15")
        self.assertTrue(d["blocking"] and d["open"])
        self.assertEqual(d["blocked_node_ids"], ["WM-1"])
        self.assertEqual(b["summary"]["decisions_blocking"], 1)

    def test_ticket_without_stem_goes_to_empty_project(self):
        t = self.tmp / "spec" / "solo"
        t.mkdir(parents=True)
        (t / "spec.md").write_text("# 혼자\n\n| 항목 | 값 |\n|---|---|\n| 문제 | p |\n| 상태 | 진행 |\n", encoding="utf-8")
        b = sm.build_board(self.tmp)
        self.assertEqual([p["key"] for p in b["projects"]], [""])
        self.assertEqual(b["projects"][0]["title"], "줄기 없음")

    def test_project_carries_problem_and_outcome_from_readme(self):
        """프로젝트 종합 화면 머리 — 문제는 머리 표, 끝난 모습은 `## 끝난 모습 — 결론` 제목의 결론이다."""
        r = Repo(self.tmp)
        r.node("n1", "끝남")
        r.write_spec()
        readme = self.tmp / "spec" / "g" / "README.md"
        readme.write_text(readme.read_text(encoding="utf-8") +
                          "\n## 문제 — 긴 설명\n\n본문.\n\n## 끝난 모습 — 열면 벽이 서 있다\n\n벽 문단.\n", encoding="utf-8")
        p = sm.build_board(self.tmp)["projects"][0]
        self.assertEqual(p["problem"], "줄기 문제")
        self.assertEqual(p["outcome"], "열면 벽이 서 있다")

    def test_project_outcome_falls_back_to_first_body_line_and_empty(self):
        r = Repo(self.tmp)
        r.node("n1", "끝남")
        r.write_spec()
        readme = self.tmp / "spec" / "g" / "README.md"
        base = readme.read_text(encoding="utf-8")
        readme.write_text(base + "\n## 끝난 모습\n\n<!-- 주석 -->\n첫 문장이다.\n둘째 줄.\n", encoding="utf-8")
        self.assertEqual(sm.build_board(self.tmp)["projects"][0]["outcome"], "첫 문장이다.")
        readme.write_text(base, encoding="utf-8")
        self.assertEqual(sm.build_board(self.tmp)["projects"][0]["outcome"], "")

    def test_project_without_readme_has_empty_outcome(self):
        t = self.tmp / "spec" / "solo"
        t.mkdir(parents=True)
        (t / "spec.md").write_text("# 혼자\n\n| 항목 | 값 |\n|---|---|\n| 문제 | p |\n| 상태 | 진행 |\n", encoding="utf-8")
        p = sm.build_board(self.tmp)["projects"][0]
        self.assertEqual(p["outcome"], "")
        self.assertEqual(p["problem"], "")

    def test_model_does_not_carry_spec_md_but_read_spec_md_gives_it(self):
        """티켓 모달의 spec.md 읽기 전용 보기는 열 때 `/api/spec`으로 받는다 — 모델에는 싣지 않는다."""
        r = Repo(self.tmp)
        r.node("n1", "끝남")
        r.write_spec()
        bad = self.tmp / "spec" / "g" / "bad"
        bad.mkdir()
        (bad / "spec.md").write_bytes(b"\xff\xfe")
        b = sm.build_board(self.tmp)
        tickets = {t["slug"]: t for p in b["projects"] for t in p["tickets"]}
        self.assertNotIn("spec_md", tickets["g/t"])
        self.assertNotIn("spec_md", tickets["g/bad"])
        self.assertNotIn("## 노드 인덱스", json.dumps(b, ensure_ascii=False))
        self.assertEqual(sm.read_spec_md(r.dir), (r.dir / "spec.md").read_text(encoding="utf-8").rstrip("\n"))
        self.assertEqual(sm.read_spec_md(bad), "")
        self.assertEqual(sm.read_spec_md(self.tmp / "nope"), "")


# ── 사람 칸 쓰기와 HTTP ────────────────────────────────────────

class WriteTest(Tmp):
    def setUp(self):
        super().setUp()
        self.r = Repo(self.tmp)
        self.r.node("n1", "확인 대기", check="필요")
        self.r.row("T1")
        self.r.write_spec()
        self.reg = sheet.Registry([self.tmp])
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), sheet.make_handler(self.reg))
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]
        self.ws = self.tmp.name

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        super().tearDown()

    def call(self, method, path, body=None):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def node(self, user, base=None, nid="n1", sheet_slug="g/t"):
        body = {"sheet": sheet_slug, "id": nid, "user": user}
        if base is not None:
            body["base"] = base
        return self.call("POST", f"/w/{self.ws}/api/node", body)

    def test_board_endpoint_returns_model(self):
        code, j = self.call("GET", f"/api/board?w={self.ws}")
        self.assertEqual(code, 200)
        self.assertEqual(j["workspace"], self.ws)
        t = j["projects"][0]["tickets"][0]
        self.assertEqual([n["id"] for n in t["nodes"]], ["TT-1"])
        self.assertEqual(t["nodes"][0]["column"], "확인 대기")

    def test_board_unknown_workspace_404_and_all(self):
        self.assertEqual(self.call("GET", "/api/board?w=nope")[0], 404)
        code, j = self.call("GET", "/api/board")
        self.assertEqual(code, 200)
        self.assertIn(self.ws, [w["workspace"] for w in j["workspaces"]])   # ~/.config/spec-sheet/roots의 다른 레포가 같이 올 수 있다

    def test_node_verdict_roundtrip_creates_file_and_shows_on_board(self):
        code, j = self.node({"verdict": "통과"}, {"verdict": ""})
        self.assertEqual((code, j["user"]["verdict"]), (200, "통과"))
        f = sm.node_file(self.r.dir, "n1")
        self.assertEqual(json.loads(f.read_text())["user"]["verdict"], "통과")
        _, b = self.call("GET", f"/api/board?w={self.ws}")
        self.assertEqual(b["projects"][0]["tickets"][0]["nodes"][0]["verdict"], "통과")

    def test_node_write_only_touches_user_cells(self):
        self.node({"verdict": "고쳐줘", "fix": "여백", "state": "끝남", "id": "x"})
        d = json.loads((sm.node_file(self.r.dir, "n1")).read_text())
        self.assertEqual(d["id"], "n1")
        self.assertEqual(d["user"], {"verdict": "고쳐줘", "fix": "여백"})
        self.assertNotIn("state", d)
        self.assertIn("확인 대기", (self.r.dir / "n1-demo.md").read_text())   # 브리프는 그대로

    def test_new_node_file_has_full_shape(self):
        self.node({"fix": "x"})
        d = json.loads((sm.node_file(self.r.dir, "n1")).read_text())
        self.assertEqual(d["user"], {"verdict": "", "fix": "x"})

    def test_node_bad_verdict_and_unknown_node_and_unknown_ticket(self):
        self.assertEqual(self.node({"verdict": "음"})[0], 400)
        self.assertEqual(self.node({"verdict": "통과"}, nid="n99")[0], 404)
        self.assertEqual(self.node({"verdict": "통과"}, sheet_slug="g/none")[0], 404)
        self.assertEqual(self.node({"verdict": "통과"}, nid="../x")[0], 404)
        self.assertFalse((sm.local_dir(self.r.dir) / "nodes").exists() and any((sm.local_dir(self.r.dir) / "nodes").iterdir()))

    def test_t19_second_writer_gets_409_and_first_answer_survives(self):
        """폰이 A로 답한 뒤 데스크톱이 같은 base로 B를 보내면 409, 파일엔 A가 남고 응답이 A를 돌려준다."""
        code, _ = self.node({"fix": "A"}, {"fix": ""})
        self.assertEqual(code, 200)
        code, j = self.node({"fix": "B"}, {"fix": ""})
        self.assertEqual(code, 409)
        self.assertEqual(j["user"]["fix"], "A")
        d = json.loads((sm.node_file(self.r.dir, "n1")).read_text())
        self.assertEqual(d["user"]["fix"], "A")
        code, _ = self.node({"fix": "B"}, {"fix": "A"})   # 안내를 보고 다시 받은 값으로 고치면 된다
        self.assertEqual(code, 200)

    def test_ticket_json_priority_paused_and_conflict(self):
        post = lambda user, base=None: self.call("POST", f"/w/{self.ws}/api/ticket",
                                                  {"sheet": "g/t", "user": user, **({"base": base} if base else {})})
        code, j = post({"paused": True, "priority": "P0"}, {"paused": False, "priority": ""})
        self.assertEqual((code, j["user"]), (200, {"paused": True, "priority": "P0", "archived": False, "wake": True}))
        code, j = post({"paused": False}, {"paused": False})
        self.assertEqual(code, 409)
        self.assertEqual(j["user"]["paused"], True)
        self.assertEqual(post({"paused": "yes"})[0], 400)
        _, b = self.call("GET", f"/api/board?w={self.ws}")
        t = b["projects"][0]["tickets"][0]
        self.assertEqual((t["paused"], t["priority"], t["priority_user"]), (True, "P0", "P0"))
        # 머리 표 spec.md는 건드리지 않는다 (D5)
        self.assertIn("| 우선순위 | P1 |", (self.r.dir / "spec.md").read_text())

    def test_priority_falls_back_to_head_table(self):
        _, b = self.call("GET", f"/api/board?w={self.ws}")
        t = b["projects"][0]["tickets"][0]
        self.assertEqual((t["priority"], t["priority_user"], t["paused"]), ("P1", "", False))

    def test_existing_row_endpoint_still_works(self):
        self.r.row("D1", "decision")
        code, j = self.call("POST", f"/w/{self.ws}/api/user", {"sheet": "g/t", "id": "D1", "user": {"answer": "A"}, "base": {"answer": ""}})
        self.assertEqual((code, j["user"]["answer"]), (200, "A"))

    def test_version_moves_when_node_cell_written(self):
        v0 = sm.board_version(self.tmp)
        import time
        time.sleep(0.02)
        self.node({"fix": "x"})
        v1 = sm.board_version(self.tmp)
        self.assertNotEqual(v1, v0)
        self.assertEqual(sm.board_version(self.tmp), v1, "파일이 그대로면 버전도 그대로다")

    def test_version_moves_when_a_file_is_deleted(self):
        self.r.row("D9", "decision")
        v0 = sm.board_version(self.tmp)
        (self.r.dir / "rows" / "D9.json").unlink()
        self.assertNotEqual(sm.board_version(self.tmp), v0, "가장 늦은 시각만 보면 지운 파일을 놓친다")

    def test_version_endpoint_follows_the_files(self):
        code, j = self.call("GET", f"/api/version?w={self.ws}")
        self.assertEqual((code, j["v"]), (200, sm.board_version(self.tmp)))
        self.node({"verdict": "통과"})
        self.assertNotEqual(self.call("GET", f"/api/version?w={self.ws}")[1]["v"], j["v"])
        self.assertEqual(self.call("GET", "/api/version?w=nope")[0], 404)

    def test_pending_counts_input_without_human_text(self):
        from unittest import mock
        journal = self.tmp / "journal"
        with mock.patch.object(sheet, "JOURNAL", journal):
            self.assertEqual(sheet.pending(self.r.dir), {"pending": 0, "items": [], "paused": False})
            self.node({"verdict": "고쳐줘", "fix": "버튼 색이 반대다"})
            got = sheet.pending(self.r.dir)
        self.assertEqual((got["pending"], got["items"]), (1, [{"id": "n1", "kind": "node"}]))
        self.assertNotIn("버튼 색", json.dumps(got, ensure_ascii=False), "사람 글은 pending 출력에 싣지 않는다")
        self.assertFalse(journal.exists(), "pending은 확인만 한다 — apply 기록을 남기지 않는다")

    def test_wait_returns_on_input_and_times_out_otherwise(self):
        got, timed_out = sheet.wait_pending(self.r.dir, timeout=0.3, every=0.1)
        self.assertTrue(timed_out)
        self.assertEqual(got["pending"], 0)
        threading.Timer(0.2, lambda: self.node({"verdict": "통과"})).start()
        got, timed_out = sheet.wait_pending(self.r.dir, timeout=5, every=0.1)
        self.assertFalse(timed_out)
        self.assertEqual(got["items"], [{"id": "n1", "kind": "node"}])


if __name__ == "__main__":
    unittest.main()
