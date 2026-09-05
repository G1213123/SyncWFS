import json
import os
import traceback
from datetime import datetime, timezone
import requests

from collections import defaultdict
import math

APP_DIR = os.path.abspath(os.environ.get("APP_DIR", os.path.dirname(os.path.abspath(__file__))))
TMP_DIR = os.path.abspath(os.environ.get("TMP_DIR", "/tmp"))
BASE_DIR = APP_DIR
OUTPUT_DIR = os.path.join(TMP_DIR, "public", "data", "wfs")
METADATA_PATH = os.path.join(OUTPUT_DIR, "metadata.json")
WFS_BASE_URL = "https://portal.csdi.gov.hk/server/services/common/td_rcd_1638928986276_39755/MapServer/WFSServer"

# Approximate full Hong Kong extent in EPSG:4326
HONG_KONG_BBOX = "22.13,113.82,22.58,114.52,urn:ogc:def:crs:EPSG::4326"
ZOOM_LEVEL = 16

REQUEST_TIMEOUT = 40000
MAX_RETRIES = 3
RETRY_BASE_SECONDS = 1.0

LAYERS = [
    "csdi:DTAD_PS_ANNO",
    "csdi:DTAD_TS_ABV_ANNO",
    "csdi:DTAD_RD_MARK_ANNO",
    "csdi:DTAD_DS_POLE_PT",
    "csdi:DTAD_PS_POLE_PT",
    "csdi:DTAD_TRAFFIC_LIGHT_PT",
    "csdi:DTAD_RD_MARK_SYM_PT",
    "csdi:DTAD_TS_ABV_PT",
    "csdi:DTAD_TS_POLE_PT",
    "csdi:DTAD_GIPOLE_PT",
    "csdi:DTAD_MISC_PT",
    "csdi:DTAD_CYC_PT",
    "csdi:UNKNOWN_LINE",
    "csdi:DTAD_DS_POLE_LINE",
    "csdi:DTAD_LV38_LINE",
    "csdi:DTAD_DS_PLATE_LINE",
    "csdi:DTAD_DS_MISC_LINE",
    "csdi:DTAD_DS_POLE_LINE_C",
    "csdi:DTAD_PS_POLE_LINE",
    "csdi:DTAD_LV30_LINE",
    "csdi:DTAD_PS_PLATE_LINE",
    "csdi:DTAD_PS_MISC_LINE",
    "csdi:DTAD_LV24_LINE",
    "csdi:DTAD_RST_ZONE_LINE",
    "csdi:DTAD_LV23_LINE",
    "csdi:DTAD_TRAFFIC_LIGHT_LINE",
    "csdi:DTAD_LV22_LINE",
    "csdi:DTAD_RD_MARK_SYM_LINE",
    "csdi:DTAD_RD_MARK_LINE_C",
    "csdi:DTAD_RD_MARK_LINE",
    "csdi:DTAD_CROSSING_LINE",
    "csdi:DTAD_YL_BOX_LINE",
    "csdi:DTAD_RAILING_LINE",
    "csdi:DTAD_TG_PATH_LINE",
    "csdi:DTAD_TS_PLATE_LINE",
    "csdi:DTAD_TS_MISC_LINE",
    "csdi:DTAD_TS_ABV_LINE",
    "csdi:DTAD_TS_POLE_LINE",
    "csdi:DTAD_TW_STRIP_LINE",
    "csdi:DTAD_TY_BAR_LINE",
    "csdi:DTAD_LV21_LINE",
    "csdi:DTAD_PED_REFUGE_LINE",
    "csdi:DTAD_RUN_IN_OUT_LINE",
    "csdi:DTAD_DROP_KERB_LINE",
    "csdi:DTAD_RD_AL_LINE",
    "csdi:DTAD_DS_FILLED",
    "csdi:DTAD_PS_FILLED",
    "csdi:DTAD_TRAFFIC_LIGHT_FILLED",
    "csdi:DTAD_LV22_FILLED",
    "csdi:DTAD_YL_BOX_POLY",
    "csdi:DTAD_TS_FILLED",
]


def ensure_output_dir():
    os.makedirs(OUTPUT_DIR, exist_ok=True)


def layer_dirname(layer_name):
    return layer_name.replace(":", "_")


def get_tile(lon, lat, zoom):
    try:
        lat_rad = math.radians(lat)
        n = 2.0 ** zoom
        x_tile = int((lon + 180.0) / 360.0 * n)
        y_tile = int((1.0 - (math.asinh(math.tan(lat_rad)) / math.pi)) / 2.0 * n)
        return x_tile, y_tile
    except Exception:
        return None, None

def get_feature_bounds(geom):
    if not geom or not geom.get("coordinates"):
        return None
    coords = geom["coordinates"]
    bounds = [float("inf"), float("inf"), float("-inf"), float("-inf")]
    
    def process_coords(c):
        if not c:
            return
        if isinstance(c[0], (int, float)):
            x, y = c[0], c[1]
            bounds[0] = min(bounds[0], x)
            bounds[1] = min(bounds[1], y)
            bounds[2] = max(bounds[2], x)
            bounds[3] = max(bounds[3], y)
            return
        for child in c:
            process_coords(child)
            
    process_coords(coords)
    if bounds[0] == float("inf"):
        return None
    return bounds

def request_layer(layer_name):
    start_index = 0
    all_features = []
    first_payload = None
    consecutive_failures = 0

    if "PLATE" in layer_name:
        PAGE_SIZE = 100
    else:
        PAGE_SIZE = 10000

    while True:
        current_page_size = PAGE_SIZE
        chunk_success = False
        features_fetched_count = 0
        
        for attempt in range(1, 6):
            if attempt == 3:
                print(f"    - Downsizing page size to 10% for this chunk...")
                current_page_size = max(1, int(PAGE_SIZE * 0.1))
                
            params = {
                "service": "WFS",
                "version": "2.0.0",
                "request": "GetFeature",
                "typeNames": layer_name,
                "outputFormat": "GEOJSON",
                "bbox": HONG_KONG_BBOX,
                "count": current_page_size,
                "startIndex": start_index,
            }
            
            # Construct url string for logging purposes
            req = requests.Request('GET', WFS_BASE_URL, params=params)
            prepared = req.prepare()
            if attempt == 1 or attempt == 3:
                print(f"  - Requesting startIndex={start_index}, count={current_page_size} -> {prepared.url}")
            
            try:
                response = requests.get(WFS_BASE_URL, params=params, timeout=REQUEST_TIMEOUT)
                response.raise_for_status()
                payload = response.json()
                
                if first_payload is None:
                    first_payload = payload
                    
                features = payload.get("features", [])
                features_fetched_count = len(features)
                all_features.extend(features)
                
                consecutive_failures = 0
                chunk_success = True
                break  # successfully fetched, break attempt loop
            except Exception as e:
                print(f"    - Attempt {attempt}/5 failed for startIndex={start_index}. Error: {e}")
                if attempt < 5:
                    import time
                    time.sleep(2)
        
        if chunk_success:
            if features_fetched_count < current_page_size:
                break
        else:
            print(f"  - WARNING: All 5 attempts failed for startIndex={start_index}. Skipping chunk.")
            consecutive_failures += 1
            if consecutive_failures >= 5:
                print(f"  - WARNING: Aborting layer pagination due to {consecutive_failures} consecutive skipping failures.")
                break
            
        start_index += current_page_size
        
    if first_payload:
        first_payload["features"] = all_features
    return first_payload or {"type": "FeatureCollection", "features": all_features}


def download_layer(layer_name):
    print(f"Syncing {layer_name}...")
    
    layer_dir = os.path.join(OUTPUT_DIR, layer_dirname(layer_name))
    os.makedirs(layer_dir, exist_ok=True)
    
    payload = request_layer(layer_name)
    features = payload.get("features", [])
    total_seen = len(features)
    print(f"  - Downloaded {total_seen} features")

    # Save full raw data
    raw_path = os.path.join(layer_dir, "raw.json")
    with open(raw_path, "w", encoding="utf-8") as raw_file:
        json.dump(payload, raw_file, ensure_ascii=False)
    
    # Store features per tile
    tiles = defaultdict(list)
    
    for feature in features:
        geom = feature.get("geometry")
        bounds = get_feature_bounds(geom)
        if not bounds:
            continue
            
        min_lon, min_lat, max_lon, max_lat = bounds
        
        # calculate tiles that this bounds overlaps
        # SW corner
        min_x, max_y = get_tile(min_lon, min_lat, ZOOM_LEVEL)
        # NE corner
        max_x, min_y = get_tile(max_lon, max_lat, ZOOM_LEVEL)
        
        if min_x is None or min_y is None:
            continue
            
        for x in range(min_x, max_x + 1):
            for y in range(min_y, max_y + 1):
                tiles[(x, y)].append(feature)

    crs = payload.get("crs")
    
    saved_chunks = 0
    for (x, y), tile_features in tiles.items():
        collection = {
            "type": "FeatureCollection",
            "features": tile_features,
        }
        if crs:
            collection["crs"] = crs
            
        output_path = os.path.join(layer_dir, f"{x}_{y}.json")
        with open(output_path, "w", encoding="utf-8") as out_file:
            json.dump(collection, out_file, ensure_ascii=False)
        saved_chunks += 1

    return {
        "layer": layer_name,
        "featureCount": total_seen,
        "chunks": saved_chunks,
        "dir": os.path.relpath(layer_dir, BASE_DIR).replace("\\", "/"),
    }


def main():
    ensure_output_dir()

    started_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat() + "Z"
    print(f"WFS sync started at {started_at}")

    results = []
    failures = []

    for layer_name in LAYERS:
        try:
            result = download_layer(layer_name)
            results.append(result)
        except Exception as err:
            print(f"\n[!] ERROR in {layer_name} [!]")
            traceback.print_exc()
            failures.append({"layer": layer_name, "error": str(err)})

    finished_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat() + "Z"
    metadata = {
        "generatedAt": finished_at,
        "source": WFS_BASE_URL,
        "bbox": HONG_KONG_BBOX,
        "layers": results,
        "failures": failures,
    }

    with open(METADATA_PATH, "w", encoding="utf-8") as meta_file:
        json.dump(metadata, meta_file, ensure_ascii=False, indent=2)

    print(f"WFS sync finished at {finished_at}")
    print(f"Layers succeeded: {len(results)}")
    print(f"Layers failed: {len(failures)}")

    if failures:
        print("\n--- FAILED LAYERS SUMMARY ---")
        for f in failures:
            print(f"- {f['layer']}: {f['error']}")
        print("-----------------------------\n")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
