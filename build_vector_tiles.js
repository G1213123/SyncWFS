/* eslint-disable no-console */
const fs = require('fs/promises');
const path = require('path');
const geojsonvtModule = require('geojson-vt');
const vtpbfModule = require('vt-pbf');

const geojsonvt = typeof geojsonvtModule === 'function'
  ? geojsonvtModule
  : geojsonvtModule.default;
const vtpbf = vtpbfModule && typeof vtpbfModule.fromGeojsonVt === 'function'
  ? vtpbfModule
  : vtpbfModule.default;

// Optional streaming JSON parser to handle very large raw.json files without loading entire file
let parserStream = null;
let streamArray = null;
let pickFilter = null;
try {
  ({ parser: parserStream } = require('stream-json'));
  ({ streamArray } = require('stream-json/streamers/StreamArray'));
  ({ pick: pickFilter } = require('stream-json/filters/Pick'));
} catch (e) {
  parserStream = null;
  streamArray = null;
  pickFilter = null;
}


const BASE_DIR = path.resolve(process.env.APP_DIR || __dirname);
const WFS_DIR = path.join(BASE_DIR, 'public', 'data', 'wfs');
const MVT_DIR = path.join(BASE_DIR, 'public', 'data', 'mvt');
const MVT_MANIFEST_PATH = path.join(MVT_DIR, 'manifest.json');
const { spawn } = require('child_process');

const MIN_ZOOM = Number.parseInt(process.env.MVT_MIN_ZOOM || '12', 10);
const MAX_ZOOM = Number.parseInt(process.env.MVT_MAX_ZOOM || '18', 10);

// Define three detail tiers with tuned geojson-vt options:
// - low: coarse simplification for low zooms
// - mid: balanced simplification for medium zooms
// - high: minimal simplification for high zooms (preserve line detail)
const TILE_INDEX_SETS = {
  low: {
    // coarse: higher tolerance -> fewer vertices (lower zooms don't need high detail)
    tolerance: 6,
    extent: 4096,
    buffer: 64,
    lineMetrics: false,
    generateId: false,
    maxZoom: 8,
    indexMaxZoom: 6,
    indexMaxPoints: 100000,
  },
  mid: {
    // balanced simplification for medium zoom levels
    tolerance: 2,
    extent: 4096,
    buffer: 64,
    lineMetrics: false,
    generateId: false,
    maxZoom: 12,
    indexMaxZoom: 10,
    indexMaxPoints: 200000,
  },
  high: {
    // preserve detail: very small tolerance to keep all line segments at high zoom
    tolerance: 0.1,
    extent: 4096,
    buffer: 64,
    lineMetrics: false,
    generateId: false,
    maxZoom: 22,
    indexMaxZoom: 18,
    indexMaxPoints: 500000,
  },
};

function assertZoomRange(minZoom, maxZoom) {
  if (!Number.isFinite(minZoom) || !Number.isFinite(maxZoom)) {
    throw new Error('MVT zoom values must be numbers.');
  }
  if (minZoom < 0 || maxZoom > 22 || minZoom > maxZoom) {
    throw new Error(`Invalid zoom range: min=${minZoom}, max=${maxZoom}`);
  }
}

function toTileX(lon, z) {
  const n = Math.pow(2, z);
  return Math.floor(((lon + 180) / 360) * n);
}

function toTileY(lat, z) {
  const latClamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const latRad = (latClamped * Math.PI) / 180;
  const n = Math.pow(2, z);
  return Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
}

function updateBounds(bounds, lon, lat) {
  if (lon < bounds.minLon) bounds.minLon = lon;
  if (lon > bounds.maxLon) bounds.maxLon = lon;
  if (lat < bounds.minLat) bounds.minLat = lat;
  if (lat > bounds.maxLat) bounds.maxLat = lat;
}

function roundCoordValue(value) {
  return Math.round(value * 1000000) / 1000000;
}

function roundGeometryCoordinates(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return coords;
  if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    coords[0] = roundCoordValue(coords[0]);
    coords[1] = roundCoordValue(coords[1]);
    return coords;
  }
  for (const child of coords) {
    roundGeometryCoordinates(child);
  }
  return coords;
}

function collectBoundsFromCoords(coords, bounds) {
  if (!Array.isArray(coords) || coords.length === 0) return;
  if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    updateBounds(bounds, coords[0], coords[1]);
    return;
  }
  for (const child of coords) {
    collectBoundsFromCoords(child, bounds);
  }
}

function getFeatureCollectionBounds(featureCollection) {
  const bounds = {
    minLon: Number.POSITIVE_INFINITY,
    minLat: Number.POSITIVE_INFINITY,
    maxLon: Number.NEGATIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY,
  };

  const features = Array.isArray(featureCollection.features)
    ? featureCollection.features
    : [];

  for (const feature of features) {
    const geom = feature && feature.geometry;
    if (!geom || !geom.coordinates) continue;
    collectBoundsFromCoords(geom.coordinates, bounds);
  }

  if (!Number.isFinite(bounds.minLon) || !Number.isFinite(bounds.minLat)) {
    return null;
  }

  return bounds;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeMvtLayerName(typeName) {
  return typeName.replace(/[^A-Za-z0-9_]/g, '_');
}

function formatBuildDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function typeNameFromDirName(dirName) {
  const sep = dirName.indexOf('_');
  if (sep === -1) return dirName;
  return `${dirName.slice(0, sep)}:${dirName.slice(sep + 1)}`;
}

async function listLayerDirs() {
  const entries = await fs.readdir(WFS_DIR, { withFileTypes: true });
  return entries
    .filter((d) => d.isDirectory() && d.name.startsWith('csdi_'))
    .map((d) => d.name)
    .sort();
}

async function removeDirContents(dirPath) {
  const exists = await fileExists(dirPath);
  if (!exists) return;
  await fs.rm(dirPath, { recursive: true, force: true });
}

async function buildLayerTiles(layerDirName, minZoom, maxZoom) {
  const rawPath = path.join(WFS_DIR, layerDirName, 'raw.json');
  const hasRaw = await fileExists(rawPath);
  if (!hasRaw) {
    return { skipped: true, reason: 'missing raw.json', layerDirName };
  }

  // Stream or parse the GeoJSON depending on availability and file size
  const stats = { featureCount: 0, featureTypes: {} };
  const typeName = typeNameFromDirName(layerDirName);
  const mvtLayerName = normalizeMvtLayerName(typeName);
  let bounds = null;
  // prepare index input placeholder (streaming path will leave features empty)
  let indexInput = { type: 'FeatureCollection', features: [] };

  const rawStat = await fs.stat(rawPath).catch(() => null);
  const useStream = parserStream && streamArray && pickFilter && rawStat && rawStat.size > 50 * 1024 * 1024;

  // Prepare output directories early so streaming branch can write tmp files
  const buildDate = process.env.MVT_BUILD_DATE || formatBuildDate();
  const buildRootDir = path.join(MVT_DIR, buildDate);
  const outLayerDir = path.join(buildRootDir, layerDirName);
  await removeDirContents(outLayerDir);
  const zTarget = 18;
  const tmpLayerDir = path.join(outLayerDir, 'tmp', String(zTarget));
  await ensureDir(tmpLayerDir);

  if (useStream) {
    // Stream features and write per-tile NDJSON files directly
    const zTarget = 18;
    const tmpLayerDir = path.join(outLayerDir, 'tmp', String(zTarget));
    await ensureDir(tmpLayerDir);

    const boundsCandidate = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };

    await new Promise((resolve, reject) => {
      const fsSync = require('fs');
      const rs = fsSync.createReadStream(rawPath, { encoding: 'utf8' });
      const pipeline = rs.pipe(parserStream()).pipe(pickFilter({ filter: 'features' })).pipe(streamArray());
      pipeline.on('data', async ({ value }) => {
        const feature = value;
        stats.featureCount += 1;
        const geomType = feature && feature.geometry && feature.geometry.type ? feature.geometry.type : 'unknown';
        stats.featureTypes[geomType] = (stats.featureTypes[geomType] || 0) + 1;

        const fb = (function getFeatureBoundsLocal(feature) {
          const geom = feature && feature.geometry;
          if (!geom || !geom.coordinates) return null;
          const b = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
          function collect(c) {
            if (!Array.isArray(c)) return;
            if (typeof c[0] === 'number' && typeof c[1] === 'number') {
              const lon = c[0]; const lat = c[1];
              if (lon < b.minLon) b.minLon = lon;
              if (lon > b.maxLon) b.maxLon = lon;
              if (lat < b.minLat) b.minLat = lat;
              if (lat > b.maxLat) b.maxLat = lat;
              return;
            }
            for (const ch of c) collect(ch);
          }
          collect(geom.coordinates);
          if (!isFinite(b.minLon)) return null;
          return b;
        })(feature);

        if (!fb) return;
        if (fb.minLon < boundsCandidate.minLon) boundsCandidate.minLon = fb.minLon;
        if (fb.maxLon > boundsCandidate.maxLon) boundsCandidate.maxLon = fb.maxLon;
        if (fb.minLat < boundsCandidate.minLat) boundsCandidate.minLat = fb.minLat;
        if (fb.maxLat > boundsCandidate.maxLat) boundsCandidate.maxLat = fb.maxLat;

        const minX = toTileX(fb.minLon, zTarget);
        const maxX = toTileX(fb.maxLon, zTarget);
        const minY = toTileY(fb.maxLat, zTarget);
        const maxY = toTileY(fb.minLat, zTarget);

        for (let x = minX; x <= maxX; x += 1) {
          for (let y = minY; y <= maxY; y += 1) {
            const filePath = path.join(tmpLayerDir, `${x}_${y}.ndjson`);
            try { await fs.appendFile(filePath, `${JSON.stringify(feature)}\n`, 'utf8'); } catch (e) { }
          }
        }
      });
      pipeline.on('end', () => resolve());
      pipeline.on('error', (err) => reject(err));
    });

    bounds = Number.isFinite(boundsCandidate.minLon) ? boundsCandidate : null;
    console.log(`  Feature types: ${JSON.stringify(stats.featureTypes)}`);
    // signal that tmp per-tile files were produced; indexInput remains empty
  } else {
    // Small file fallback: read & parse whole JSON
    let rawText = await fs.readFile(rawPath, 'utf8');
    let featureCollection = JSON.parse(rawText);
    rawText = null; // Clear memory after parsing
    let features = Array.isArray(featureCollection.features) ? featureCollection.features : [];
    const featureCount = features.length;

    if (featureCount === 0) {
      featureCollection = null;
      features = null;
      return { skipped: true, reason: 'empty features', layerDirName };
    }

    // Log feature types for debugging line loss issues
    const featureTypes = {};
    features.forEach((f) => {
      const geomType = f && f.geometry && f.geometry.type ? f.geometry.type : 'unknown';
      featureTypes[geomType] = (featureTypes[geomType] || 0) + 1;
    });
    console.log(`  Feature types: ${JSON.stringify(featureTypes)}`);

    bounds = getFeatureCollectionBounds(featureCollection);
    if (!bounds) {
      console.log(`  ERROR: No valid geometry bounds found for ${layerDirName}. Feature details:`, featureTypes);
      featureCollection = null;
      features = null;
      return { skipped: true, reason: 'no valid geometry bounds', layerDirName };
    }

    indexInput.features = featureCollection.features;
    featureCollection = null;
    features = null;
  }

  const nByZoom = {};
  let tilesWritten = 0;

  // Build a single high-detail index once and reuse for all zooms to reduce memory spikes
  const indexOptions = Object.assign({}, TILE_INDEX_SETS.high);

  // Only build tiles at zoom 18 to reduce processing and memory usage

  function getFeatureBounds(feature) {
    const geom = feature && feature.geometry;
    if (!geom || !geom.coordinates) return null;
    const bounds = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };

    function collect(coords) {
      if (!Array.isArray(coords)) return;
      if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
        const lon = coords[0];
        const lat = coords[1];
        if (lon < bounds.minLon) bounds.minLon = lon;
        if (lon > bounds.maxLon) bounds.maxLon = lon;
        if (lat < bounds.minLat) bounds.minLat = lat;
        if (lat > bounds.maxLat) bounds.maxLat = lat;
        return;
      }
      for (const c of coords) collect(c);
    }

    collect(geom.coordinates);
    if (!isFinite(bounds.minLon)) return null;
    return bounds;
  }

  // Stream features into per-tile NDJSON files at zTarget
  for (const feature of indexInput.features) {
    const fb = getFeatureBounds(feature);
    if (!fb) continue;
    //if (feature && feature.geometry && feature.geometry.coordinates) {
    //  roundGeometryCoordinates(feature.geometry.coordinates);
    //}
    const minX = toTileX(fb.minLon, zTarget);
    const maxX = toTileX(fb.maxLon, zTarget);
    const minY = toTileY(fb.maxLat, zTarget);
    const maxY = toTileY(fb.minLat, zTarget);

    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const filePath = path.join(tmpLayerDir, `${x}_${y}.ndjson`);
        // Append feature as one JSON line
        try {
          await fs.appendFile(filePath, `${JSON.stringify(feature)}\n`, 'utf8');
        } catch (e) {
          // ignore write errors per tile to keep going
        }
      }
    }
  }

  // Free the large feature array to help GC
  try { indexInput.features = null; } catch (e) {}

  // Read each per-tile NDJSON file, build a tiny index, and emit the pbf
  const tmpFiles = await fs.readdir(tmpLayerDir).catch(() => []);
  for (const fname of tmpFiles) {
    if (!fname.endsWith('.ndjson')) continue;
    const [xStr, yWithExt] = fname.split('_');
    const yStr = (yWithExt || '').replace('.ndjson', '');
    const x = Number(xStr);
    const y = Number(yStr);
    const filePath = path.join(tmpLayerDir, fname);
    const fileText = await fs.readFile(filePath, 'utf8').catch(() => '');
    const lines = fileText.split('\n').filter(Boolean);
    const tileFeatures = lines.map((l) => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);

    if (tileFeatures.length === 0) {
      await fs.unlink(filePath).catch(() => {});
      continue;
    }

    const smallCollection = { type: 'FeatureCollection', features: tileFeatures };
    const smallIndex = geojsonvt(smallCollection, { tolerance: indexOptions.tolerance, extent: indexOptions.extent, buffer: indexOptions.buffer, maxZoom: zTarget, indexMaxZoom: zTarget });
    const tile = smallIndex.getTile(zTarget, x, y);
    if (!tile || !tile.features || tile.features.length === 0) {
      await fs.unlink(filePath).catch(() => {});
      continue;
    }

    const tileBuffer = vtpbf.fromGeojsonVt({ [mvtLayerName]: tile });
    const tilePath = path.join(outLayerDir, String(zTarget), String(x), `${y}.pbf`);
    await ensureDir(path.dirname(tilePath));
    await fs.writeFile(tilePath, tileBuffer);
    tilesWritten += 1;
    nByZoom[zTarget] = (nByZoom[zTarget] || 0) + 1;

    // delete the temp file to free disk and reduce later reads
    await fs.unlink(filePath).catch(() => {});
  }

  // remove tmp dir if empty
  try { await fs.rmdir(tmpLayerDir); } catch (e) {}

  // Determine final feature count and types depending on whether we streamed or parsed
  const finalFeatureCount = (typeof stats !== 'undefined' && stats.featureCount) ? stats.featureCount : (Array.isArray(indexInput.features) ? indexInput.features.length : 0);
  const finalFeatureTypes = (typeof stats !== 'undefined' && stats.featureTypes && Object.keys(stats.featureTypes).length > 0)
    ? stats.featureTypes
    : (typeof featureTypes !== 'undefined' ? featureTypes : {});

  console.log(`  Zoom ${zTarget}: wrote ${nByZoom[zTarget] || 0} tiles from ${finalFeatureCount} features`);

  return {
    skipped: false,
    layerDirName,
    typeName,
    mvtLayerName,
    buildDate,
    featureCount: finalFeatureCount,
    featureTypes: finalFeatureTypes,
    bounds,
    minZoom,
    maxZoom,
    tilesWritten,
    tilesByZoom: nByZoom,
    outputDir: path.relative(BASE_DIR, outLayerDir).replace(/\\/g, '/'),
  };
}

async function main() {
  assertZoomRange(MIN_ZOOM, MAX_ZOOM);
  await ensureDir(MVT_DIR);

  const startedAt = new Date().toISOString();
  const buildDate = formatBuildDate(new Date(startedAt));
  const buildRootDir = path.join(MVT_DIR, buildDate);
  await ensureDir(buildRootDir);
  const layerDirs = await listLayerDirs();
  console.log(`Building vector tiles for ${layerDirs.length} layer directories...`);
  console.log(`Zoom range: ${MIN_ZOOM}-${MAX_ZOOM}`);
  console.log(`Build date: ${buildDate}`);

  // CLI single-layer mode: if script called with `--single <layerDir>` process just that layer
  const singleArgIndex = process.argv.indexOf('--single');
  if (singleArgIndex !== -1 && process.argv.length > singleArgIndex + 1) {
    const singleLayer = process.argv[singleArgIndex + 1];
    console.log(`Running single-layer build for ${singleLayer}`);
    const res = await buildLayerTiles(singleLayer, MIN_ZOOM, MAX_ZOOM);
    console.log(res.skipped ? `skipped: ${res.reason}` : `wrote ${res.tilesWritten} tiles from ${res.featureCount} features`);
    return;
  }

  const results = [];

  // Process each layer in a fresh Node process to bound memory per-layer
  for (const layerDirName of layerDirs) {
    console.log(`- ${layerDirName}`);
    // Spawn a child process that runs this script in single-layer mode
    const args = [
      `--max-old-space-size=${Math.max(2048, Number(process.env.BUILD_MVT_MEM) || 7168)}`,
      path.join('jobs', 'build_vector_tiles.js'),
      '--single',
      layerDirName,
    ];

    const node = process.execPath; // path to node
    await new Promise((resolve) => {
      const child = spawn(node, args, { cwd: BASE_DIR, stdio: 'inherit', env: { ...process.env, MVT_BUILD_DATE: buildDate } });
      child.on('close', (code) => {
        if (code !== 0) {
          console.error(`  child process for ${layerDirName} exited with ${code}`);
          results.push({ skipped: true, layerDirName, reason: `child exit ${code}` });
        } else {
          // Success - the child already printed summary
          results.push({ skipped: false, layerDirName });
        }
        resolve();
      });
    });
  }

  const metadata = {
    generatedAt: new Date().toISOString(),
    startedAt,
    buildDate,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    sourceRoot: path.relative(BASE_DIR, WFS_DIR).replace(/\\/g, '/'),
    outputRoot: path.relative(BASE_DIR, buildRootDir).replace(/\\/g, '/'),
    layers: results,
  };

  const buildMetadataPath = path.join(buildRootDir, 'metadata.json');
  await fs.writeFile(buildMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  let manifest = {
    generatedAt: metadata.generatedAt,
    latestBuildDate: buildDate,
    latestData: metadata,
    builds: [],
  };

  try {
    const manifestText = await fs.readFile(MVT_MANIFEST_PATH, 'utf8');
    const existingManifest = JSON.parse(manifestText);
    if (Array.isArray(existingManifest.builds)) {
      manifest.builds = existingManifest.builds;
    }
  } catch (e) {
    // Manifest doesn't exist or is invalid, start with empty builds list
  }

  // Add current build to history
  manifest.builds.push({
    buildDate: buildDate,
    generatedAt: metadata.generatedAt,
    outputRoot: metadata.outputRoot,
    layers: metadata.layers,
  });

  // Keep history manageable (e.g., last 10 builds)
  if (manifest.builds.length > 10) {
    manifest.builds = manifest.builds.slice(-10);
  }

  await fs.writeFile(MVT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Metadata written: ${path.relative(BASE_DIR, buildMetadataPath)}`);
  console.log(`Manifest written: ${path.relative(BASE_DIR, MVT_MANIFEST_PATH)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
