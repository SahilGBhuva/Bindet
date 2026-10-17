import asyncio
import base64
import os
import tempfile
import unittest
from io import BytesIO
from unittest.mock import patch

from fastapi import HTTPException, UploadFile

os.environ.setdefault("POCKET_TUTOR_DB_PATH", tempfile.mktemp(suffix=".db"))

import images
import main
import note_store

try:
    import pillow_heif
    from PIL import Image
except ImportError:  # pragma: no cover - requirements.txt installs both
    pillow_heif = None


def ftyp(major: bytes, *compatible: bytes) -> bytes:
    body = major + b"\x00\x00\x00\x00" + b"".join(compatible)
    return (8 + len(body)).to_bytes(4, "big") + b"ftyp" + body + b"\x00" * 16


def heic_photo(size=(64, 48), colour=(200, 30, 30), exif: bytes | None = None, mode="RGB") -> bytes:
    """A real (tiny) HEIC file, encoded by pillow-heif so no binary fixture is committed."""
    pillow_heif.register_heif_opener()
    image = Image.new(mode, size, colour)
    output = BytesIO()
    extra = {"exif": exif} if exif else {}
    image.save(output, format="HEIF", quality=90, **extra)
    return output.getvalue()


def gps_exif() -> bytes:
    exif = Image.Exif()
    exif[0x010F] = "Apple"  # Make
    exif[0x0110] = "iPhone 15"  # Model
    gps = exif.get_ifd(0x8825)
    gps[1] = "N"
    gps[2] = (37.0, 46.0, 30.0)
    gps[3] = "W"
    gps[4] = (122.0, 25.0, 10.0)
    return exif.tobytes()


class HeifDetectionTests(unittest.TestCase):
    def test_every_heif_brand_is_recognised(self):
        for brand in images.HEIF_BRANDS:
            self.assertTrue(images.is_heif(ftyp(brand)), brand)
            self.assertEqual(main.sniff_image_type(ftyp(brand)), "image/heic")

    def test_heif_found_through_compatible_brands(self):
        self.assertTrue(images.is_heif(ftyp(b"XXXX", b"mif1", b"heic")))

    def test_other_iso_bmff_files_are_not_heif(self):
        for raw in (ftyp(b"isom", b"mp41"), ftyp(b"qt  "), ftyp(b"avif", b"mif1"), ftyp(b"XXXX", b"avif", b"mif1")):
            self.assertFalse(images.is_heif(raw), raw[:16])
        self.assertFalse(images.is_heif(b"\x89PNG\r\n\x1a\n" + b"0" * 32))
        self.assertFalse(images.is_heif(b"ftypheic"))
        self.assertIsNone(main.sniff_image_type(ftyp(b"isom")))


@unittest.skipIf(pillow_heif is None, "pillow-heif is not installed")
class HeifConversionTests(unittest.TestCase):
    def test_tiny_heic_becomes_a_jpeg_of_the_same_size(self):
        jpeg = images.heif_to_jpeg(heic_photo())
        self.assertTrue(jpeg.startswith(b"\xff\xd8\xff"))
        with Image.open(BytesIO(jpeg)) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertEqual(image.size, (64, 48))
            red, green, blue = image.convert("RGB").getpixel((32, 24))
            self.assertGreater(red, 150)
            self.assertLess(green, 80)

    def test_exif_and_gps_are_stripped(self):
        raw = heic_photo(exif=gps_exif())
        pillow_heif.register_heif_opener()
        with Image.open(BytesIO(raw)) as original:
            self.assertIn(0x8825, original.getexif())  # the fixture really carries GPS
        jpeg = images.heif_to_jpeg(raw)
        with Image.open(BytesIO(jpeg)) as image:
            self.assertEqual(dict(image.getexif()), {})
            self.assertNotIn("exif", image.info)
            self.assertNotIn("xmp", image.info)
        self.assertNotIn(b"Exif", jpeg)
        self.assertNotIn(b"iPhone", jpeg)

    def test_large_photos_are_downscaled(self):
        jpeg = images.heif_to_jpeg(heic_photo(size=(2600, 1300)))
        with Image.open(BytesIO(jpeg)) as image:
            self.assertEqual(image.size, (2000, 1000))

    def test_transparency_is_flattened_onto_white(self):
        jpeg = images.heif_to_jpeg(heic_photo(mode="RGBA", colour=(0, 0, 0, 0)))
        with Image.open(BytesIO(jpeg)) as image:
            self.assertGreater(min(image.convert("RGB").getpixel((10, 10))), 230)

    def test_too_many_pixels_is_refused_before_decoding(self):
        raw = heic_photo(size=(400, 300))
        with patch.object(images, "MAX_PIXELS", 100_000), self.assertRaises(images.ImageConversionError) as caught:
            images.heif_to_jpeg(raw)
        self.assertEqual(str(caught.exception), images.HEIC_UNREADABLE)

    def test_corrupt_heic_gives_the_friendly_error(self):
        raw = heic_photo()
        for broken in (raw[: len(raw) // 2], ftyp(b"heic") + b"garbage" * 20, raw[:40] + b"\x00" * (len(raw) - 40)):
            with self.assertRaises(images.ImageConversionError) as caught:
                images.heif_to_jpeg(broken)
            self.assertEqual(str(caught.exception), "That photo couldn’t be read. Try a JPG or PNG.")

    def test_fails_closed_without_pillow_heif(self):
        with patch.object(images, "_heif_opener", return_value=None), self.assertRaises(images.ImageConversionError):
            images.heif_to_jpeg(heic_photo())
        with patch.dict("sys.modules", {"pillow_heif": None}):
            self.assertIsNone(images._heif_opener())


def data_url(content_type: str, raw: bytes) -> str:
    return f"data:{content_type};base64," + base64.b64encode(raw).decode()


@unittest.skipIf(pillow_heif is None, "pillow-heif is not installed")
class OttoHeicTests(unittest.TestCase):
    def test_heic_attachment_reaches_the_model_as_jpeg(self):
        raw = heic_photo(exif=gps_exif())
        for label in ("image/heic", "image/heif", "image/jpeg"):
            parts = main.tutor_image_parts([main.TutorImage(data_url=data_url(label, raw))])
            url = parts[0]["image_url"]["url"]
            self.assertTrue(url.startswith("data:image/jpeg;base64,"), label)
            sent = base64.b64decode(url.split(",", 1)[1])
            self.assertTrue(sent.startswith(b"\xff\xd8\xff"))
            self.assertNotIn(b"iPhone", sent)

    def test_unreadable_heic_attachment_is_a_friendly_415(self):
        with self.assertRaises(HTTPException) as caught:
            main.tutor_image_parts([main.TutorImage(data_url=data_url("image/heic", ftyp(b"heic") + b"x" * 40))])
        self.assertEqual(caught.exception.status_code, 415)
        self.assertEqual(caught.exception.detail, images.HEIC_UNREADABLE)
        with patch.object(images, "_heif_opener", return_value=None), self.assertRaises(HTTPException) as caught:
            main.tutor_image_parts([main.TutorImage(data_url=data_url("image/heic", heic_photo()))])
        self.assertEqual(caught.exception.status_code, 415)

    def test_oversized_heic_keeps_the_byte_cap(self):
        big = ftyp(b"heic") + b"0" * main.TUTOR_IMAGE_MAX_BYTES
        with patch.object(images, "heif_to_jpeg") as convert, self.assertRaises(HTTPException) as caught:
            main.tutor_image_parts([main.TutorImage(data_url=data_url("image/heic", big))])
        self.assertEqual(caught.exception.status_code, 413)
        convert.assert_not_called()

    def test_heic_message_is_sent_end_to_end_with_a_fake_model(self):
        import json

        import database
        import tutor

        database.reset_db()
        tutor.reset_tutor()
        captured = {}

        def fake_stream(*, messages, route, session_id=None):
            captured.update(messages=messages, route=route)
            yield "A plant cell."

        raw = heic_photo(exif=gps_exif())
        user = {"id": "heic-otto-student", "email_confirmed_at": "2026-01-01T00:00:00Z"}
        request = main.TutorMessageRequest(content="What is this?", images=[main.TutorImage(name="IMG_0001.HEIC", data_url=data_url("image/heic", raw))])
        with patch.object(main.auth, "authenticated_user", return_value=user), \
                patch.object(main.ai_tutor, "stream_tutor_reply", side_effect=fake_stream):
            response = main.send_tutor_message(request, "Bearer t")

            async def drain():
                return "".join([chunk if isinstance(chunk, str) else chunk.decode() async for chunk in response.body_iterator])

            body = asyncio.run(drain())
        self.assertIn("A plant cell.", body)
        self.assertEqual(captured["route"]["tier"], "vision")
        image = captured["messages"][-1]["content"][1]
        self.assertTrue(image["image_url"]["url"].startswith("data:image/jpeg;base64,"))
        self.assertNotIn("image/heic", json.dumps(captured["messages"]))


@unittest.skipIf(pillow_heif is None, "pillow-heif is not installed")
class NoteHeicTests(unittest.TestCase):
    user = {"id": "heic-note-student", "email_confirmed_at": "2026-01-01T00:00:00Z"}

    def upload(self, name, raw, claimed="image/heic"):
        upload = UploadFile(filename=name, file=BytesIO(raw), headers={"content-type": claimed})
        return asyncio.run(main.upload_note("Biology", "Cells", upload, "Bearer test"))

    def test_heic_note_photo_is_read_as_jpeg(self):
        raw = heic_photo(exif=gps_exif())
        with patch.object(main.auth, "authenticated_user", return_value=self.user), \
                patch.object(main.ai_tutor, "extract_image_notes", return_value="Mitochondria make ATP.") as vision:
            result = self.upload("IMG_0042.HEIC", raw)
            heif = self.upload("scan.heif", heic_photo(colour=(10, 120, 200)), claimed="")
        self.assertEqual(result.status, "ready")
        self.assertEqual(result.content_type, "image/jpeg")
        self.assertEqual(heif.content_type, "image/jpeg")
        sent = vision.call_args_list[0].kwargs
        self.assertEqual(sent["content_type"], "image/jpeg")
        self.assertTrue(sent["image_bytes"].startswith(b"\xff\xd8\xff"))
        self.assertNotIn(b"iPhone", sent["image_bytes"])
        _, context = note_store.context_for(self.user["id"], "Biology", "Cells")
        self.assertIn("Mitochondria make ATP", context)

    def test_bad_heic_notes_get_the_friendly_error_before_any_ocr(self):
        cases = {
            "broken.heic": ftyp(b"heic") + b"x" * 64,  # says HEIC, isn't decodable
            "fake.heic": b"\x89PNG\r\n\x1a\n" + b"0" * 32,  # not HEIC at all
        }
        with patch.object(main.auth, "authenticated_user", return_value=self.user), \
                patch.object(main.ai_tutor, "extract_image_notes", return_value="text") as vision, \
                patch.object(main, "limit_action") as limits:
            for name, raw in cases.items():
                with self.assertRaises(HTTPException) as caught:
                    self.upload(name, raw)
                self.assertEqual(caught.exception.status_code, 415, name)
            vision.assert_not_called()
            self.assertEqual({call.args[1] for call in limits.call_args_list}, {"note_upload"})
        self.assertEqual(caught.exception.detail, main.NOTE_IMAGE_MISMATCH)

    def test_unreadable_heic_note_says_try_jpg_or_png(self):
        with patch.object(main.auth, "authenticated_user", return_value=self.user), \
                patch.object(main.ai_tutor, "extract_image_notes") as vision, \
                self.assertRaises(HTTPException) as caught:
            self.upload("broken.heic", ftyp(b"heic") + b"x" * 64)
        self.assertEqual(caught.exception.detail, images.HEIC_UNREADABLE)
        vision.assert_not_called()

    def test_oversized_heic_note_keeps_the_4mb_cap(self):
        big = ftyp(b"heic") + b"0" * main.note_ingestion.MAX_NOTE_BYTES
        with patch.object(main.auth, "authenticated_user", return_value=self.user), \
                patch.object(images, "heif_to_jpeg") as convert, self.assertRaises(HTTPException) as caught:
            self.upload("huge.heic", big)
        self.assertEqual(caught.exception.status_code, 413)
        convert.assert_not_called()


if __name__ == "__main__":
    unittest.main()


class StripMetadataTests(unittest.TestCase):
    def test_jpeg_gps_is_removed_and_format_kept(self):
        from PIL import Image
        exif = Image.Exif()
        exif[0x8825] = {1: 'N', 2: (40.0, 0.0, 0.0)}  # GPSInfo
        buffer = BytesIO()
        Image.new('RGB', (40, 30), (200, 10, 10)).save(buffer, format='JPEG', exif=exif)
        raw = buffer.getvalue()
        self.assertIn(b'Exif', raw)
        cleaned = images.without_metadata(raw, 'image/jpeg')
        self.assertNotIn(b'Exif', cleaned)
        with Image.open(BytesIO(cleaned)) as result:
            self.assertEqual(result.format, 'JPEG')
            self.assertEqual(result.size, (40, 30))

    def test_unreadable_or_gif_passes_through(self):
        self.assertEqual(images.without_metadata(b'not an image', 'image/png'), b'not an image')
        self.assertEqual(images.without_metadata(b'GIF89a...', 'image/gif'), b'GIF89a...')

    def test_busy_when_decode_slots_are_taken(self):
        held = [images._decode_slots.acquire(timeout=1) for _ in range(2)]
        try:
            with patch.object(images, "DECODE_WAIT_SECONDS", 0.05):
                with self.assertRaises(images.ImageConversionError) as caught:
                    images.without_metadata(b'x', 'image/png')
            self.assertEqual(str(caught.exception), images.PHOTOS_BUSY)
        finally:
            for ok in held:
                if ok:
                    images._decode_slots.release()
