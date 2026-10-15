#!/usr/bin/env python3
"""상태 어휘 테스트 — states.json 한 벌이 모든 읽는 쪽에서 같은 값으로 정규화되는지 본다.

  python3 -m unittest discover -s tests -p 'test_vocab.py'
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spec_board"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _store  # noqa: F401  사람 칸 저장소를 임시 폴더로

import migrate_format
import node_state
import spec_model

SIX = ["아직 안 함", "진행", "확인 대기", "막힘", "보류", "끝남"]
LEGACY = {
    "done": "끝남",
    "completed": "끝남",
    "pending": "아직 안 함",
    "parked": "보류",
    "blocked": "막힘",
}
STATES_JSON = Path(__file__).resolve().parents[1] / "spec_board" / "states.json"


class SingleSourceTest(unittest.TestCase):
    """여섯 값과 동의어는 states.json 한 곳이다 — spec_model·node_state·migrate_format이 그걸 읽는다."""

    def setUp(self):
        self.d = json.loads(STATES_JSON.read_text(encoding="utf-8"))

    def test_six_come_from_the_file_in_every_reader(self):
        self.assertEqual(self.d["six"], SIX)
        self.assertEqual(spec_model.SIX, self.d["six"])
        self.assertEqual(node_state.SIX, self.d["six"])
        self.assertEqual(migrate_format.SIX, self.d["six"])

    def test_every_synonym_of_the_file_maps_to_its_state(self):
        for state, syns in self.d["synonyms"].items():
            self.assertIn(state, self.d["six"])
            for s in syns:
                self.assertEqual(spec_model.norm_state(s), state, s)
                self.assertEqual(spec_model.norm_state(f"  {s.upper()} (메모)  "), state, s)

    def test_cases_table_matches_python(self):
        """다른 도구가 같은 입력표로 대조한다 — 여기서 깨지면 두 쪽 어휘가 갈라진 것이다."""
        for raw, want in self.d["cases"]:
            self.assertEqual(spec_model.norm_state(raw), want, repr(raw))

    def test_unknown_stays_unknown(self):
        self.assertEqual(spec_model.UNKNOWN, "모름")
        self.assertEqual(spec_model.norm_state("running"), "모름")   # 표에 없는 값은 짐작하지 않는다

    def test_file_has_all_six_and_nothing_else(self):
        self.assertEqual(set(self.d["synonyms"]), set(SIX))
        for s in SIX:
            self.assertIn(s, self.d["synonyms"][s])   # 각 값은 자기 이름을 동의어로 갖는다


class VocabTest(unittest.TestCase):
    def test_six_values_are_states(self):
        for s in SIX:
            self.assertIn(s, spec_model.STATES, s)

    def test_new_values_keep_their_name(self):
        for s in SIX:
            self.assertEqual(spec_model.norm_state(s), s)

    def test_legacy_english_maps_to_same(self):
        for raw, want in LEGACY.items():
            self.assertEqual(spec_model.norm_state(raw), want, raw)

    def test_blocked_moved_off_parked(self):
        self.assertEqual(spec_model.norm_state("blocked"), "막힘")
        self.assertNotEqual(spec_model.norm_state("blocked"), "보류")

    def test_review_maps_to_확인_대기(self):
        for raw in ("review", "verifying", "확인 대기"):
            self.assertEqual(spec_model.norm_state(raw), "확인 대기", raw)

    def test_re확인_not_confused_with_확인(self):
        for raw in ("재확인", "재확인 필요"):
            self.assertEqual(spec_model.norm_state(raw), "재확인 필요", raw)

    def test_unknown_falls_to_모름(self):
        for raw in ("nonsense", "", "  "):
            self.assertEqual(spec_model.norm_state(raw), "모름", repr(raw))


if __name__ == "__main__":
    unittest.main()
