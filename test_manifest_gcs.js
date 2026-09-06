/* eslint-disable no-console */
const fs = require('fs/promises');
const path = require('path');
const { Storage } = require('@google-cloud/storage');

const bucketName = process.env.GCS_BUCKET || 'road-sign-factory-asset';
const objectName = process.env.GCS_OBJECT || 'public/data/mvt/manifest.json';
const tmpDir = path.resolve(process.env.TMP_DIR || '/tmp');
const localManifestPath = path.join(tmpDir, 'public', 'data', 'mvt', 'manifest.json');
const storage = new Storage();

async function readManifest() {
  const [contents] = await storage.bucket(bucketName).file(objectName).download();
  return JSON.parse(contents.toString('utf8'));
}

async function main() {
  const uri = `gs://${bucketName}/${objectName}`;
  const manifest = await readManifest();
  const now = new Date();
  const buildDate = now.toISOString().slice(0, 10);
  const mockEntry = {
    buildDate,
    generatedAt: now.toISOString(),
    outputRoot: `public/data/mvt/${buildDate}-mock`,
    layers: [],
    mock: true,
  };

  console.log(`Read manifest from ${uri}`);
  console.log(`Existing builds: ${Array.isArray(manifest.builds) ? manifest.builds.length : 0}`);

  const builds = Array.isArray(manifest.builds) ? manifest.builds : [];
  builds.push(mockEntry);
  manifest.builds = builds.slice(-10);
  await fs.mkdir(path.dirname(localManifestPath), { recursive: true });
  await fs.writeFile(localManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Saved mock manifest entry for ${buildDate} to ${localManifestPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
