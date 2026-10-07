from __future__ import annotations

import logging
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
# Private bucket for study-group chat images (supabase/migrations/20260920_chat_image_attachments.sql).
# Object paths are <group_id>/<sender_id>/<file>, uploaded straight from the browser.
CHAT_IMAGE_BUCKET = "study-group-images"
LIST_PAGE = 1000

logger = logging.getLogger("bindit.storage")


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


# --- Deleting objects (account deletion) --------------------------------------------
#
# These use the service-role key, which only ever lives on the server; it is sent to
# Supabase in headers and never logged. Without the key nothing can be deleted, and the
# callers log a warning and carry on (see account_deletion.py).

class StorageUnavailable(Exception):
    """Storage could not be reached, or refused a list or delete."""


def service_settings() -> tuple[str, str] | None:
    """(Supabase URL, service-role key), or None when either is not configured."""
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not service_key:
        return None
    return url, service_key


def private_image_bucket() -> str:
    return os.getenv("SUPABASE_STORAGE_BUCKET", "student-images")


def _service_headers(service_key: str) -> dict[str, str]:
    return {"apikey": service_key, "Authorization": f"Bearer {service_key}"}


def _list_folder(url: str, service_key: str, bucket: str, folder: str) -> list[dict]:
    entries: list[dict] = []
    offset = 0
    while True:
        try:
            response = httpx.post(
                f"{url}/storage/v1/object/list/{bucket}",
                headers=_service_headers(service_key),
                json={"prefix": folder, "limit": LIST_PAGE, "offset": offset, "sortBy": {"column": "name", "order": "asc"}},
                timeout=10,
            )
        except httpx.RequestError as error:
            raise StorageUnavailable("list failed") from error
        if response.status_code != 200:
            raise StorageUnavailable(f"list returned {response.status_code}")
        page = response.json()
        if not isinstance(page, list):
            raise StorageUnavailable("list returned an unexpected body")
        entries.extend(item for item in page if isinstance(item, dict) and item.get("name"))
        if len(page) < LIST_PAGE:
            return entries
        offset += LIST_PAGE


def object_paths(bucket: str, folder: str, depth: int = 2) -> list[str]:
    """Every object path under folder (e.g. "<group_id>/<user_id>"), descending into
    sub-folders up to depth levels. Raises StorageUnavailable."""
    settings = service_settings()
    if settings is None:
        raise StorageUnavailable("service role key not configured")
    folder = _safe_storage_path(folder.strip("/"))
    paths: list[str] = []
    for entry in _list_folder(*settings, bucket, folder):
        path = f"{folder}/{entry['name']}"
        if entry.get("id") is None:  # a folder: Supabase lists those without an id
            if depth > 0:
                paths.extend(object_paths(bucket, path, depth - 1))
        else:
            paths.append(path)
    return paths


def delete_objects(bucket: str, paths: list[str]) -> int:
    """Delete these object paths (missing ones are ignored). Raises StorageUnavailable."""
    paths = sorted({_safe_storage_path(path) for path in paths if path})
    if not paths:
        return 0
    settings = service_settings()
    if settings is None:
        raise StorageUnavailable("service role key not configured")
    url, service_key = settings
    deleted = 0
    for start in range(0, len(paths), LIST_PAGE):
        batch = paths[start:start + LIST_PAGE]
        try:
            response = httpx.request(
                "DELETE", f"{url}/storage/v1/object/{bucket}",
                headers=_service_headers(service_key), json={"prefixes": batch}, timeout=20,
            )
        except httpx.RequestError as error:
            raise StorageUnavailable("delete failed") from error
        if response.status_code not in (200, 204):
            raise StorageUnavailable(f"delete returned {response.status_code}")
        deleted += len(batch)
    return deleted


def delete_folder(bucket: str, folder: str) -> int:
    """Delete every object under folder. Raises StorageUnavailable."""
    return delete_objects(bucket, object_paths(bucket, folder))
