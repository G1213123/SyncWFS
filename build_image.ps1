param(
    [string]$ProjectId,
    [string]$ImageName,
    [string]$ImageTag,
    [string]$Region,
    [string]$ArtifactRepository
)

$ErrorActionPreference = "Stop"

$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $name, $value = $line.Split("=", 2)
            [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim())
        }
    }
}

if (-not $ProjectId) { $ProjectId = $env:GOOGLE_CLOUD_PROJECT }
if (-not $ImageName) { $ImageName = if ($env:CLOUD_RUN_IMAGE_NAME) { $env:CLOUD_RUN_IMAGE_NAME } else { "sync-wfs-vector-tiles" } }
if (-not $ImageTag) { $ImageTag = if ($env:IMAGE_TAG) { $env:IMAGE_TAG } else { "latest" } }
if (-not $Region) { $Region = if ($env:CLOUD_RUN_REGION) { $env:CLOUD_RUN_REGION } else { "asia-east2" } }
if (-not $ArtifactRepository) { $ArtifactRepository = if ($env:ARTIFACT_REPOSITORY) { $env:ARTIFACT_REPOSITORY } else { "cloud-run-source-deploy" } }

if (-not $ProjectId) {
    throw "Set GOOGLE_CLOUD_PROJECT to your Google Cloud project ID in .env or pass -ProjectId."
}

$image = "$Region-docker.pkg.dev/$ProjectId/$ArtifactRepository/${ImageName}:$ImageTag"
gcloud builds submit --tag $image $PSScriptRoot
Write-Output "Container image: $image"