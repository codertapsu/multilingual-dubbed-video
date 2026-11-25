"""Where the text lines are in a band crop, and what the frames say (with a fake recogniser)."""

import numpy as np

from vd_ocr.core import REC_HEIGHT, read_frames, rec_input, stroke_mask, text_lines


def band(lines: list[tuple[int, int, int, int]], w: int = 600, h: int = 60, ground: int = 50) -> np.ndarray:
    """A grey crop with white "glyphs" (6-px-wide bars, 4 px apart) filling each (x0, y0, x1, y1)."""
    a = np.full((h, w), ground, dtype=np.uint8)
    for x0, y0, x1, y1 in lines:
        for x in range(x0, x1, 10):
            a[y0:y1, x : min(x + 6, x1)] = 250
    return a


def test_one_line_its_box_with_a_margin():
    boxes = text_lines(band([(200, 20, 400, 44)]))
    assert len(boxes) == 1
    x0, y0, x1, y1 = boxes[0]
    assert x0 < 200 and x0 > 180 and x1 > 396 and x1 < 420
    assert y0 < 20 and y1 > 44


def test_two_lines_top_to_bottom():
    boxes = text_lines(band([(150, 6, 450, 26), (220, 34, 380, 54)]))
    assert len(boxes) == 2
    assert boxes[0][1] < boxes[1][1]
    assert boxes[1][0] > boxes[0][0]


def test_nothing_on_a_dark_band_or_a_bright_wall():
    assert text_lines(np.full((60, 600), 40, dtype=np.uint8)) == []
    # A bright background has no sharp steps: no strokes.
    assert text_lines(np.full((60, 600), 235, dtype=np.uint8)) == []
    assert not stroke_mask(np.full((10, 10), 255, dtype=np.uint8)).any()


def test_a_thin_scratch_is_no_line():
    a = band([])
    a[30:32, 100:500] = 255
    assert text_lines(a) == []


def test_the_recogniser_gets_its_own_height_in_three_channels():
    a = band([(200, 20, 400, 44)])
    img = rec_input(a, text_lines(a)[0])
    assert img.shape[0] == REC_HEIGHT and img.shape[2] == 3
    assert img.shape[1] > img.shape[0]


def test_frames_read_line_by_line_and_joined():
    frames = np.stack([band([(150, 6, 450, 26), (220, 34, 380, 54)]), band([]), band([(200, 20, 400, 44)])])
    asked: list[int] = []

    def recognise(images):
        asked.append(len(images))
        return [("快 快跑", 0.99), ("别松 ", 0.9), ("这到底是什么地方啊", 0.97)]

    out = read_frames(frames, recognise, first_index=10)
    assert asked == [3]  # one batch for every line of every frame
    assert [(r.index, r.text, r.lines) for r in out] == [(10, "快 快跑 别松", 2), (11, "", 0), (12, "这到底是什么地方啊", 1)]
    assert out[0].confidence == 0.945 and out[1].confidence == 0.0
