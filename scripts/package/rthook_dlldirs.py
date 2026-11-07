# PyInstaller runtime hook (every frozen worker and vd-piper): make the DLLs that
# delvewheel renamed findable, whichever bundled `.libs` folder they ended up in.
#
# Windows wheels repaired by delvewheel ship their DLL dependencies under mangled
# names (msvcp140-a4c2229b....dll) in a sibling `<package>.libs` folder, and the
# package's __init__ adds THAT folder to the DLL search path. PyInstaller keeps
# one copy per file name, so when two wheels ship the same runtime, the copy lands
# in only one of the folders. numpy and sentencepiece 0.2.3 both carry
# msvcp140-a4c2229b...: the bundle kept numpy's, and `import sentencepiece` failed
# with "DLL load failed while importing _sentencepiece" unless numpy happened to
# be imported first. Offline translation was dead in the 0.11.0 installer while
# every test passed, against a dev venv still on 0.2.1, which has no .libs at all.
#
# Registering every bundled .libs folder before any app code runs makes each
# mangled name resolvable regardless of which folder holds it or import order.
import os
import sys

if sys.platform == "win32" and getattr(sys, "frozen", False):
    _vd_root = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    _vd_dll_dirs = []
    try:
        for _vd_name in sorted(os.listdir(_vd_root)):
            _vd_path = os.path.join(_vd_root, _vd_name)
            if _vd_name.endswith(".libs") and os.path.isdir(_vd_path):
                _vd_dll_dirs.append(os.add_dll_directory(_vd_path))
    except OSError:
        pass  # an unreadable bundle fails later, with the real import error
    # Keep the handles: closing one removes its folder from the search path again.
    sys._vd_dll_dirs = _vd_dll_dirs  # type: ignore[attr-defined]
