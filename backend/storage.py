from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

import httpx
from fastapi import HTTPException, UploadFile


ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
MAX_IMAGE_BYTES = 5 * 1024 * 1024


def public_settings() -> tuple[str, str]:
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    anon_key = os.getenv("SUPABASE_ANON_KEY", "")
    if not url or not anon_key:
        raise HTTPException(status_code=503, detail="Accounts are not configured yet")
    return url, anon_key


def _settings() -> tuple[str, str, str, str]:
    url, anon_key = public_settings()
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    bucket = os.getenv("SUPABASE_STORAGE_BUCKET", "student-images")
    if not service_key:
        raise HTTPException(status_code=503, detail="Image storage is not configured yet")
    return url, anon_key, service_key, bucket


def authenticated_user(authorization: str | None) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sign in to continue")
    url, anon_key = public_settings()
    try:
        response = httpx.get(
            f"{url}/auth/v1/user",
            headers={"apikey": anon_key, "Authorization": authorization},
            timeout=10,
        )
    except httpx.RequestError as error:
        raise HTTPException(status_code=503, detail="Could not verify the account") from error
    if response.status_code != 200:
        raise HTTPException(status_code=401, detail="Your sign-in has expired")
    return response.json()


async def upload_private_image(owner_id: str, upload: UploadFile) -> dict:
    content_type = upload.content_type or ""
    extension = ALLOWED_IMAGE_TYPES.get(content_type)
    if extension is None:
        raise HTTPException(status_code=415, detail="Use a JPG, PNG, WebP, or GIF image")

    content = await upload.read(MAX_IMAGE_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail="The image is empty")
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Images must be 5 MB or smaller")

    url, _, service_key, bucket = _settings()
    image_id = str(uuid4())
    storage_path = _safe_storage_path(f"{owner_id}/{image_id}{extension}")
    safe_name = Path(upload.filename or f"image{extension}").name[:255]
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": content_type,
        "x-upsert": "false",
    }
    try:
        response = httpx.post(
            f"{url}/storage/v1/object/{bucket}/{storage_path}",
            headers=headers,
            content=content,
            timeout=20,
        )
    except httpx.RequestError as error:
        raise HTTPException(status_code=503, detail="Could not reach image storage") from error
    if response.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail="Supabase rejected the image upload")
    return {
        "id": image_id,
        "storage_path": storage_path,
        "original_name": safe_name,
        "content_type": content_type,
        "size_bytes": len(content),
    }


def _safe_storage_path(storage_path: str) -> str:
    """Object paths are built as owner/uuid.ext; refuse anything that could climb out of the bucket."""
    if not storage_path or storage_path.startswith("/") or "\\" in storage_path or ".." in storage_path:
        raise HTTPException(status_code=400, detail="Invalid image path")
    return storage_path


def signed_image_url(storage_path: str) -> str:
    storage_path = _safe_storage_path(storage_path)
    url, _, service_key, bucket = _settings()
    response = httpx.post(
        f"{url}/storage/v1/object/sign/{bucket}/{storage_path}",
        headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"},
        json={"expiresIn": 3600},
        timeout=10,
    )
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="Could not create a private image link")
    signed = response.json().get("signedURL") or response.json().get("signedUrl")
    if not signed:
        raise HTTPException(status_code=502, detail="Supabase did not return an image link")
    return signed if signed.startswith("http") else f"{url}/storage/v1{signed}"
