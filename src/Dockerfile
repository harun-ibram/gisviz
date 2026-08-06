# Railway build for the FastAPI backend.
#
# Sits next to the code because the service's root directory is src/ — the
# deployed tree has gis_worker.py and .venv directly under /app, not /app/src.
# Railway prefers a Dockerfile over Nixpacks autodetection, so this file is what
# builds the image once it exists.
#
# It exists because Nixpacks could not be made to provide libexpat.so.1.
# rasterio's wheel vendors GDAL, but that GDAL still dynamic-links a handful of
# ordinary system libraries, and importing rasterio died with
#
#     ImportError: libexpat.so.1: cannot open shared object file
#
# Because rasterio is imported lazily (process_lidar.rasterize_laz, and
# gis_common's helpers) that surfaced only once a GIS job touched a raster —
# never at boot, and never on any other endpoint.
#
# The Debian base already carries libexpat1, since CPython's own pyexpat links
# it; installing it explicitly documents the dependency and survives a future
# base-image change that might drop it.
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends libexpat1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a code change does not reinstall the GDAL stack.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Fail the build rather than a user's first GIS job if the native stack is
# broken: these are the imports that were silently deferred until runtime.
RUN python -c "import rasterio, pyogrio, laspy, geopandas; print('native GIS stack OK')"

# Railway injects PORT.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
