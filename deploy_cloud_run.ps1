param(
    [string]$ProjectId = $env:GOOGLE_CLOUD_PROJECT,
    [string]$Region = $(if ($env:CLOUD_RUN_REGION) { $env:CLOUD_RUN_REGION } else { "asia-east2" }),
    [string]$JobName = $(if ($env:CLOUD_RUN_JOB) { $env:CLOUD_RUN_JOB } else { "sync-wfs-vector-tiles" }),
    [string]$Bucket = $(if ($env:GCS_BUCKET) { $env:GCS_BUCKET } else { "road-sign-factory-asset" })
)

$ErrorActionPreference = "Stop"

if (-not $ProjectId) {
    throw "Set GOOGLE_CLOUD_PROJECT or pass -ProjectId."
}

gcloud config set project $ProjectId
gcloud run jobs deploy $JobName `
    --source . `
    --region $Region `
    --tasks 1 `
    --cpu 4 `
    --memory 16Gi `
    --max-retries 1 `
    --task-timeout 24h `
    --set-env-vars "GCS_BUCKET=$Bucket"

gcloud run jobs execute $JobName --region $Region --wait