FROM node:22-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    APP_DIR=/app

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY sync_wfs_layers.py build_vector_tiles.js run_pipeline.py ./

CMD ["python3", "run_pipeline.py"]