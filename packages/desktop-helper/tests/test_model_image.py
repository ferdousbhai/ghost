"""The model's copy of a capture: logical size, capped edge, file untouched."""

from __future__ import annotations

import base64
import io
from pathlib import Path

import pytest
from PIL import Image

from ghost_desktop_helper.model_image import (
    MODEL_IMAGE_MAX_EDGE,
    model_image,
    model_scale,
)


def _png(path: Path, width: int, height: int) -> None:
    Image.new("RGB", (width, height), "white").save(path, format="PNG")


def test_scale_is_the_monitor_scale_then_the_provider_edge_cap():
    assert model_scale(1920, 1200, 1.6) == 1 / 1.6
    assert model_scale(1200, 750, 1.0) == 1.0
    # A scale-1 display wider than the cap is brought under it, nothing more.
    assert model_scale(1920, 1200, 1.0) == MODEL_IMAGE_MAX_EDGE / 1920
    assert model_scale(3840, 2160, 1.0) == MODEL_IMAGE_MAX_EDGE / 3840
    # A scaled display whose logical size still exceeds the cap gets both.
    assert model_scale(5120, 2880, 1.5) == pytest.approx(MODEL_IMAGE_MAX_EDGE / 5120)


def test_a_capture_at_logical_size_needs_no_copy(tmp_path: Path):
    path = tmp_path / "shot.png"
    _png(path, 200, 100)
    assert model_image(path, 200, 100, 1.0) is None


def test_the_copy_is_logical_size_and_the_file_is_untouched(tmp_path: Path):
    path = tmp_path / "shot.png"
    _png(path, 200, 100)
    before = path.read_bytes()
    copy = model_image(path, 200, 100, 2.0)
    assert copy is not None
    assert (copy["model_width"], copy["model_height"], copy["model_scale"]) == (100, 50, 0.5)
    with Image.open(io.BytesIO(base64.b64decode(copy["model_png_base64"]))) as scaled:
        assert scaled.size == (100, 50)
    assert path.read_bytes() == before
