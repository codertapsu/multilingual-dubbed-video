"""Reading burned-in subtitles: where the text lines are in a band crop, and what they say.

The orchestrator sends grey crops of the subtitle band, one per subtitle on
screen (the media worker cut each from a frame inside it). A crop holds one or
two lines of text across the middle of the picture. The rows and columns that
hold text strokes (bright pixels on a sharp horizontal step, the measure the
media worker's presence scan uses) give each line's box, and only that box is
read, by the PP-OCRv4 recogniser alone. Measured on the development PC
(2026-11-25): the recogniser on a line's box took about 30 ms and read eight
Chinese subtitles right; the full pipeline (text detector first) took 1-2.4 s
a subtitle; and the recogniser on the whole strip read its empty margins as
letters ("廣大家小点声后面有东西！").

Pure numpy here; the recogniser is passed in, so the tests run without a model.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Sequence

import numpy as np

# The media worker's stroke measure (workers/media-worker/src/subtitlePresence.ts).
TEXT_BRIGHT = 200
TEXT_STEP = 90
# A row is part of a text line when it holds this many stroke pixels…
MIN_ROW_STROKES = 3
# …and at least this share of the busiest row's.
ROW_SHARE = 0.12
# Rows of a line may be this far apart (the gap inside a 二 or 三).
ROW_GAP = 2
# A line is at least this tall, as a share of the crop (smaller: noise).
MIN_LINE_SHARE = 0.18
# The recogniser's input height (PP-OCR rec_img_shape).
REC_HEIGHT = 48
# Margin around a line's box, as a share of its height.
MARGIN = 0.35

Recognise = Callable[[Sequence[np.ndarray]], Sequence[tuple[str, float]]]


def stroke_mask(gray: np.ndarray) -> np.ndarray:
    """Text-stroke pixels of a grey image: bright, and much brighter than the pixel two to the left or right."""
    g = gray.astype(np.int16)
    bright = g >= TEXT_BRIGHT
    left = np.zeros_like(bright)
    right = np.zeros_like(bright)
    left[:, 2:] = (g[:, 2:] - g[:, :-2]) >= TEXT_STEP
    right[:, :-2] = (g[:, :-2] - g[:, 2:]) >= TEXT_STEP
    return bright & (left | right)


def _runs(on: np.ndarray, gap: int) -> list[tuple[int, int]]:
    """Runs of True (start, end exclusive), joining runs at most `gap` apart."""
    runs: list[tuple[int, int]] = []
    start = None
    for i, v in enumerate(on.tolist() + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if runs and start - runs[-1][1] <= gap:
                runs[-1] = (runs[-1][0], i)
            else:
                runs.append((start, i))
            start = None
    return runs


def text_lines(gray: np.ndarray) -> list[tuple[int, int, int, int]]:
    """The boxes (x0, y0, x1, y1; end exclusive) of the lines of text in a band crop, top to bottom; [] when none."""
    if gray.ndim != 2 or gray.size == 0:
        return []
    mask = stroke_mask(gray)
    rows = mask.sum(axis=1)
    peak = int(rows.max(initial=0))
    if peak < MIN_ROW_STROKES:
        return []
    on = rows >= max(MIN_ROW_STROKES, ROW_SHARE * peak)
    height, width = gray.shape
    boxes: list[tuple[int, int, int, int]] = []
    for y0, y1 in _runs(on, ROW_GAP):
        if y1 - y0 < max(3, MIN_LINE_SHARE * height):
            continue
        cols = np.nonzero(mask[y0:y1].any(axis=0))[0]
        if cols.size == 0:
            continue
        m = max(2, int(round(MARGIN * (y1 - y0))))
        boxes.append((max(0, int(cols[0]) - m), max(0, y0 - m), min(width, int(cols[-1]) + 1 + m), min(height, y1 + m)))
    return boxes


def rec_input(gray: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    """A line's box at the recogniser's height, as a 3-channel image (what PP-OCR takes)."""
    x0, y0, x1, y1 = box
    crop = gray[y0:y1, x0:x1]
    h, w = crop.shape
    new_w = max(8, int(round(w * REC_HEIGHT / max(1, h))))
    # Nearest-neighbour sampling in numpy: the strokes are big enough, and no
    # OpenCV call is needed for a test to run.
    ys = np.minimum(h - 1, (np.arange(REC_HEIGHT) * h / REC_HEIGHT).astype(np.int64))
    xs = np.minimum(w - 1, (np.arange(new_w) * w / new_w).astype(np.int64))
    small = crop[ys][:, xs]
    return np.repeat(small[:, :, None], 3, axis=2)


@dataclass
class FrameText:
    index: int
    text: str
    confidence: float
    lines: int


def read_frames(frames: np.ndarray, recognise: Recognise, first_index: int = 0) -> list[FrameText]:
    """What each frame (N×H×W grey) says: its lines read top to bottom, joined by a space."""
    items: list[tuple[int, np.ndarray]] = []
    for i in range(frames.shape[0]):
        for box in text_lines(frames[i]):
            items.append((i, rec_input(frames[i], box)))
    read = list(recognise([img for _, img in items])) if items else []
    texts: dict[int, list[tuple[str, float]]] = {}
    for (i, _), (text, score) in zip(items, read):
        cleaned = " ".join(str(text).split())
        if cleaned:
            texts.setdefault(i, []).append((cleaned, float(score)))
    out: list[FrameText] = []
    for i in range(frames.shape[0]):
        got = texts.get(i, [])
        confidence = sum(s for _, s in got) / len(got) if got else 0.0
        out.append(FrameText(index=first_index + i, text=" ".join(t for t, _ in got), confidence=round(confidence, 4), lines=len(got)))
    return out
