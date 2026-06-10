# PyInstaller runtime hook (STT): bake VD_WORKER so the frozen binary needs no
# arguments. Runs BEFORE entry_worker.main(). A caller-provided VD_WORKER wins so
# the binary stays debuggable.
import os

os.environ.setdefault("VD_WORKER", "stt")
