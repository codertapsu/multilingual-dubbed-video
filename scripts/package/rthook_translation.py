# PyInstaller runtime hook (Translation): bake VD_WORKER so the frozen binary
# needs no arguments. Runs BEFORE entry_worker.main().
import os

os.environ.setdefault("VD_WORKER", "translation")
