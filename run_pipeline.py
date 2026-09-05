import os
import json
import mimetypes
import subprocess
from pathlib import Path

from google.cloud import storage


APP_DIR = Path(os.environ.get("APP_DIR", Path(__file__).resolve().parent)).resolve()
TMP_DIR = Path(os.environ.get("TMP_DIR", "/tmp")).resolve()
MANIFEST_PATH = TMP_DIR / "public" / "data" / "mvt" / "manifest.json"
BUCKET_NAME = os.environ.get("GCS_BUCKET", "road-sign-factory-asset")
OBJECT_NAME = os.environ.get("GCS_OBJECT", "public/data/mvt/manifest.json")
MVT_DIR = TMP_DIR / "public" / "data" / "mvt"


def run_stage(command):
    print(f"Running: {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=APP_DIR, check=True)


def upload_file(client, local_path, object_name):
    bucket = client.bucket(BUCKET_NAME)
    blob = bucket.blob(object_name)
    content_type = mimetypes.guess_type(local_path.name)[0] or "application/octet-stream"
    blob.upload_from_filename(local_path, content_type=content_type)
    print(f"Uploaded {local_path} to gs://{BUCKET_NAME}/{object_name}", flush=True)


def upload_outputs():
    if not MANIFEST_PATH.is_file():
        raise FileNotFoundError(f"Expected manifest was not created: {MANIFEST_PATH}")

    with MANIFEST_PATH.open("r", encoding="utf-8") as manifest_file:
        manifest = json.load(manifest_file)

    build_date = manifest.get("latestBuildDate")
    if not build_date or Path(build_date).name != build_date:
        raise ValueError("Manifest does not contain a valid latestBuildDate")

    build_dir = MVT_DIR / build_date
    if not build_dir.is_dir():
        raise FileNotFoundError(f"Expected MVT build directory was not created: {build_dir}")

    client = storage.Client()
    for local_path in sorted(path for path in build_dir.rglob("*") if path.is_file()):
        relative_path = local_path.relative_to(MVT_DIR).as_posix()
        upload_file(client, local_path, f"public/data/mvt/{relative_path}")

    upload_file(client, MANIFEST_PATH, OBJECT_NAME)


def main():
    run_stage([os.environ.get("PYTHON_BIN", "python3"), str(APP_DIR / "sync_wfs_layers.py")])
    run_stage([os.environ.get("NODE_BIN", "node"), str(APP_DIR / "build_vector_tiles.js")])
    upload_outputs()


if __name__ == "__main__":
    main()