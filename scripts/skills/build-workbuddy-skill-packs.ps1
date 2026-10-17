param([string] $NodePath = 'node', [string] $OutputDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskSkillsRoot = Join-Path $taskRepo 'integrations\workbuddy\standalone-skills'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $taskRepo 'artifacts\workbuddy-skills' }
$taskOutput = [IO.Path]::GetFullPath($OutputDirectory)
$taskValidation = @(& $NodePath (Join-Path $PSScriptRoot 'validate-workbuddy-skills.mjs'))
if ($LASTEXITCODE -ne 0) { throw 'Skill source validation failed; nothing packaged.' }
$taskReport = ($taskValidation -join "`n") | ConvertFrom-Json
foreach ($taskSkill in $taskReport.skills) {
  $taskZipPath = Join-Path $taskOutput ($taskSkill.name + '-' + $taskSkill.version + '.zip')
  if (Test-Path -LiteralPath $taskZipPath) { throw 'An output package already exists; choose a new output directory. Existing artifacts were preserved.' }
}
if (Test-Path -LiteralPath (Join-Path $taskOutput 'manifest.json')) { throw 'Existing manifest was preserved; choose a new output directory.' }
[void] [IO.Directory]::CreateDirectory($taskOutput)
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskPackages = @()
foreach ($taskSkill in $taskReport.skills) {
  $taskZipPath = Join-Path $taskOutput ($taskSkill.name + '-' + $taskSkill.version + '.zip')
  $taskZipStream = [IO.File]::Open($taskZipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $taskZip = [IO.Compression.ZipArchive]::new($taskZipStream, [IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($taskFile in $taskSkill.files) {
      $taskSource = Join-Path (Join-Path $taskSkillsRoot $taskSkill.name) $taskFile.path
      [void] [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskZip, $taskSource, ($taskSkill.name + '/' + $taskFile.path), [IO.Compression.CompressionLevel]::Optimal)
    }
  } finally { $taskZip.Dispose() }
  $taskCheck = [IO.Compression.ZipFile]::OpenRead($taskZipPath)
  try {
    $taskExpected = @($taskSkill.files | ForEach-Object { $taskSkill.name + '/' + $_.path } | Sort-Object)
    $taskActual = @($taskCheck.Entries | ForEach-Object FullName | Sort-Object)
    if (($taskExpected -join "`n") -ne ($taskActual -join "`n")) { throw 'Archive structure differs from validated source.' }
    foreach ($taskFile in $taskSkill.files) {
      $taskEntry = $taskCheck.GetEntry($taskSkill.name + '/' + $taskFile.path)
      $taskStream = $taskEntry.Open()
      $taskHashAlgorithm = [Security.Cryptography.SHA256]::Create()
      try { $taskHash = [BitConverter]::ToString($taskHashAlgorithm.ComputeHash($taskStream)).Replace('-','').ToLowerInvariant() }
      finally { $taskStream.Dispose(); $taskHashAlgorithm.Dispose() }
      if ($taskHash -ne $taskFile.sha256) { throw 'Archive contents differ from validated source.' }
    }
  } finally { $taskCheck.Dispose() }
  $taskPackages += [pscustomobject]@{ name=$taskSkill.name; version=$taskSkill.version; file=[IO.Path]::GetFileName($taskZipPath); sha256=(Get-FileHash -LiteralPath $taskZipPath -Algorithm SHA256).Hash.ToLowerInvariant(); archiveVerified=$true }
}
$taskManifest = [pscustomobject]@{ platform='workbuddy'; stage='local-import-candidate'; clientImportVerified=$false; marketplaceApproved=$false; packages=$taskPackages }
[IO.File]::WriteAllText((Join-Path $taskOutput 'manifest.json'), ($taskManifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
$taskPackages | Select-Object name,version,file,archiveVerified | ConvertTo-Json -Depth 3
