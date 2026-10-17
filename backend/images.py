"""iPhone photos (HEIC/HEIF) turned into plain JPEGs before anything else sees them.

Chrome and Firefox can't decode HEIC, so the browser often sends the original file. It is
recognised by its ISO-BMFF ``ftyp`` brand, decoded with pillow-heif inside fixed limits,
shrunk, and re-encoded as a JPEG with no metadata at all: an iPhone photo carries EXIF
with GPS coordinates, and these are students' photos. Every failure (a corrupt file, a
too-large image, pillow-heif not installed) becomes one friendly ImageConversionError.
"""
from __future__ import annotations

import io
import logging
import threading
import warnings

log = logging.getLogger("bindet.images")

# Major or compatible brands of HEIF still images (HEVC-coded and generic MIAF/HEIF).
HEIF_BRANDS = frozenset({b"heic", b"heix", b"hevc", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"msf1"})
# Other formats in the same container that also list mif1 (AVIF); they are not HEIC.
NOT_HEIF_BRANDS = frozenset({b"avif", b"avis"})
HEIF_MIME = "image/heic"
HEIF_CONTENT_TYPES = frozenset({"image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"})

MAX_PIXELS = 24_000_000  # about 24 MP: the largest HEIC an iPhone saves (48 MP shots are stored at 12 or 24)
MAX_EDGE = 2000
JPEG_QUALITY = 85
HEIC_UNREADABLE = "That photo couldn’t be read. Try a JPG or PNG."
PHOTOS_BUSY = "bindet is busy reading other photos. Try again in a moment."
# A decoded photo can take a few hundred MB; at most this many are decoded at once per server
# instance, so a burst of large photos can't run it out of memory.
_decode_slots = threading.BoundedSemaphore(2)
DECODE_WAIT_SECONDS = 15


class ImageConversionError(ValueError):
    """A photo that couldn't be turned into a JPEG; str() is safe to show a student."""

    def __init__(self, message: str = HEIC_UNREADABLE):
        super().__init__(message)


def is_heif(raw: bytes) -> bool:
    """True when the bytes start with an ISO-BMFF ftyp box naming a HEIF image brand."""
    if len(raw) < 12 or raw[4:8] != b"ftyp":
        return False
    major = raw[8:12]
    if major in HEIF_BRANDS:
        return True
    if major in NOT_HEIF_BRANDS:
        return False
    # Compatible brands follow the major brand and minor version, to the end of the box.
    box_size = int.from_bytes(raw[0:4], "big")
    end = min(box_size if box_size >= 16 else 16, len(raw), 256)
    brands = {raw[offset:offset + 4] for offset in range(16, end - 3, 4)}
    return bool(brands & HEIF_BRANDS) and not brands & NOT_HEIF_BRANDS


def _heif_opener():
    """pillow-heif's Pillow plugin, or None when it isn't installed (fail closed)."""
    try:
        from PIL import Image
        import pillow_heif
    except ImportError:
        return None
    pillow_heif.register_heif_opener()
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    return Image


def heif_to_jpeg(raw: bytes) -> bytes:
    """A HEIC/HEIF photo as a JPEG, right way up, long edge at most MAX_EDGE, no metadata."""
    Image = _heif_opener()
    if Image is None:
        log.warning("heic_unavailable pillow-heif is not installed")
        raise ImageConversionError()
    if not _decode_slots.acquire(timeout=DECODE_WAIT_SECONDS):
        raise ImageConversionError(PHOTOS_BUSY)
    try:
        return _heif_to_jpeg(Image, raw)
    finally:
        _decode_slots.release()


def _heif_to_jpeg(Image, raw: bytes) -> bytes:
    from PIL import ImageOps

    try:
        with warnings.catch_warnings():
            # Pillow only warns between MAX_IMAGE_PIXELS and twice that; treat it as an error.
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                if source.format != "HEIF":
                    raise ImageConversionError()
                width, height = source.size
                # Checked from the header, before a single pixel is decoded.
                if width < 1 or height < 1 or width * height > MAX_PIXELS:
                    raise ImageConversionError()
                source.load()
                ImageOps.exif_transpose(source, in_place=True)  # no second full-size copy
                upright = source
                upright.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)
                # A brand-new image carries no info dict: no EXIF, GPS, XMP or maker notes.
                clean = Image.new("RGB", upright.size, (255, 255, 255))
                if upright.mode in {"RGBA", "LA"} or (upright.mode == "P" and "transparency" in upright.info):
                    rgba = upright.convert("RGBA")
                    clean.paste(rgba, mask=rgba.getchannel("A"))
                else:
                    clean.paste(upright.convert("RGB"))
        output = io.BytesIO()
        clean.save(output, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return output.getvalue()
    except ImageConversionError:
        raise
    except Exception as error:  # noqa: BLE001 - any decoder failure is the same answer for a student
        log.info("heic_unreadable %s", type(error).__name__)
        raise ImageConversionError() from error


_REENCODE = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}


def without_metadata(raw: bytes, content_type: str) -> bytes:
    """A JPEG, PNG or WebP re-saved right way up with no EXIF/GPS/XMP, same format.

    Used for every photo before it goes to the vision model. GIFs, and any image Pillow
    can't open (or no Pillow installed), are passed through unchanged: this only removes
    metadata, it never blocks a photo that the rest of the checks already accepted.
    """
    format_name = _REENCODE.get(content_type)
    if format_name is None:
        return raw
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return raw
    if not _decode_slots.acquire(timeout=DECODE_WAIT_SECONDS):
        raise ImageConversionError(PHOTOS_BUSY)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                width, height = source.size
                if width < 1 or height < 1 or width * height > MAX_PIXELS:
                    raise ImageConversionError()
                source.load()
                ImageOps.exif_transpose(source, in_place=True)  # no second full-size copy
                upright = source
                mode = "RGBA" if upright.mode in {"RGBA", "LA", "P"} and format_name != "JPEG" else "RGB"
                clean = Image.new(mode, upright.size)
                clean.paste(upright.convert(mode))
        output = io.BytesIO()
        clean.save(output, format=format_name, **({"quality": JPEG_QUALITY} if format_name in {"JPEG", "WEBP"} else {}))
        return output.getvalue()
    except ImageConversionError:
        raise
    except Exception as error:  # noqa: BLE001 - keep the photo rather than fail on a metadata pass
        log.info("strip_metadata_skipped %s", type(error).__name__)
        return raw
    finally:
        _decode_slots.release()
