$ErrorActionPreference = 'Stop'

$InstallDir = if ($env:IDA_DRIVER_INSTALL_DIR) { $env:IDA_DRIVER_INSTALL_DIR } else { 'C:\Program Files\IDA Print Driver' }
$DataDir = if ($env:IDA_DRIVER_DATA_DIR) { $env:IDA_DRIVER_DATA_DIR } else { 'C:\ProgramData\IDA Print Driver' }
$SourceDir = Split-Path -Parent $PSScriptRoot

New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir, (Join-Path $DataDir 'logs_impresion') | Out-Null
Copy-Item (Join-Path $SourceDir 'agente.js') $InstallDir -Force
Copy-Item (Join-Path $SourceDir 'lib') $InstallDir -Recurse -Force
Copy-Item (Join-Path $SourceDir 'certs') $InstallDir -Recurse -Force

Push-Location $InstallDir
npm ci --omit=dev --ignore-scripts
Pop-Location

Write-Host "Archivos instalados en $InstallDir"
Write-Host "La primera ejecucion solicitara y guardara la configuracion en $DataDir."
Write-Host "El servicio requiere Node.js 20, 22 o 24 LTS."
