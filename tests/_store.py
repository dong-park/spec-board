"""테스트가 진짜 사람 칸 저장소(~/.local/share/spec-board)를 건드리지 않게 임시 폴더로 돌린다. 테스트 파일마다 맨 처음 import한다."""
import atexit
import os
import shutil
import tempfile

if not os.environ.get("SPEC_BOARD_TEST_STORE"):
    _d = tempfile.mkdtemp(prefix="spec-board-store-")
    os.environ["SPEC_BOARD_STORE"] = os.environ["SPEC_BOARD_TEST_STORE"] = _d
    atexit.register(shutil.rmtree, _d, True)
