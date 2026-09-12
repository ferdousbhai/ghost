"""The image a model sees is not the file the owner keeps.

A capture is physical pixels. The model pays per pixel, and it reasons in the
desktop's logical coordinates (what Hyprland calls a screen point and what
``ghost_desktop`` clicks), so the model-facing copy is scaled to the logical
size, physical divided by the monitor scale, and then kept within
``MODEL_IMAGE_MAX_EDGE`` on its long edge, which is where providers downsample
anyway. The saved file stays full resolution.
"""

from __future__ import annotations

import base64
import io
from pathlib import Path
from typing import Any

#: The long edge past which vision providers downsample an image themselves.
MODEL_IMAGE_MAX_EDGE = 1568


def model_scale(width: int, height: int, monitor_scale: float) -> float:
    """The factor that takes a capture to what the model should see, 1.0 for none."""
    factor = 1.0 / monitor_scale if monitor_scale > 1.0 else 1.0
    long_edge = max(width, height) * factor
    if long_edge > MODEL_IMAGE_MAX_EDGE:
        factor *= MODEL_IMAGE_MAX_EDGE / long_edge
    return 1.0 if factor >= 0.999 else factor


def model_image(
    path: Path, width: int, height: int, monitor_scale: float
) -> dict[str, Any] | None:
    """A scaled PNG for the model as ``model_png_base64`` plus its size and
    scale, or None when the capture is already the right size or Pillow is
    missing (the caller then sends the original)."""
    factor = model_scale(width, height, monitor_scale)
    if factor == 1.0:
        return None
    try:
        from PIL import Image
    except ImportError:
        return None
    target = (max(1, round(width * factor)), max(1, round(height * factor)))
    with Image.open(path) as source:
        resized = source.resize(target, Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    resized.save(buffer, format="PNG")
    return {
        "model_png_base64": base64.b64encode(buffer.getvalue()).decode("ascii"),
        "model_width": target[0],
        "model_height": target[1],
        "model_scale": target[0] / width,
    }
