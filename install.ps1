# Installs oh-my-herdr's files-search mod and main-search layout into the Herdr app folder.
#   irm https://raw.githubusercontent.com/m16khb-org/oh-my-herdr/main/install.ps1 | iex
#   powershell -ExecutionPolicy Bypass -File install.ps1             (from a clone)
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
param([switch]$Uninstall)

# Its own scope: piped into iex, the script must not change the caller's session.
& {
  param([bool]$Uninstall)
  $ErrorActionPreference = 'Stop'

  $Repo = 'm16khb-org/oh-my-herdr'
  $App = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME '.config\herdr-app' }
  $HerdrApp = Get-Command herdr-app -ErrorAction SilentlyContinue

  # herdr-app.exe is a GUI program: PowerShell neither waits for it nor sets $LASTEXITCODE,
  # so run it through Start-Process and read its output from files.
  function Invoke-HerdrApp([string[]]$Arguments) {
    $out = [IO.Path]::GetTempFileName(); $err = [IO.Path]::GetTempFileName()
    try {
      $p = Start-Process -FilePath $HerdrApp.Source -ArgumentList ($Arguments | ForEach-Object { '"' + $_ + '"' }) `
        -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
      return [pscustomobject]@{ Code = $p.ExitCode; Out = (Get-Content -Raw $out); Err = (Get-Content -Raw $err) }
    } finally { Remove-Item -Force -ErrorAction SilentlyContinue $out, $err }
  }

  # Herdr answers `status` only while its window is open.
  function Get-HerdrStatus {
    if (-not $HerdrApp) { return $null }
    $r = Invoke-HerdrApp @('status')
    if ($r.Code -ne 0 -or -not $r.Out) { return $null }
    try { return $r.Out | ConvertFrom-Json } catch { return $null }
  }

  if ($Uninstall) {
    $status = Get-HerdrStatus
    if ($status -and $status.layout -eq 'main-search') {
      Invoke-HerdrApp @('do', 'layout.switch', '--name', 'main') | Out-Null
      Write-Host 'Switched Herdr back to the main layout.'
    }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $App 'mods\files-search'), (Join-Path $App 'layouts\main-search.json')
    Write-Host "Removed files-search and main-search from $App."
    return
  }

  # Files come from the clone this script sits in, or from GitHub when piped into iex.
  $Src = $null
  if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'mods\files-search'))) { $Src = $PSScriptRoot }
  $Tmp = $null
  try {
    if (-not $Src) {
      $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("oh-my-herdr-" + [guid]::NewGuid())
      New-Item -ItemType Directory $Tmp | Out-Null
      $zip = Join-Path $Tmp 'repo.zip'
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -UseBasicParsing "https://codeload.github.com/$Repo/zip/refs/heads/main" -OutFile $zip
      Expand-Archive $zip -DestinationPath $Tmp
      $Src = Join-Path $Tmp 'oh-my-herdr-main'
      if (-not (Test-Path (Join-Path $Src 'mods\files-search'))) { throw 'the download has no mods\files-search' }
    }

    $mod = Join-Path $App 'mods\files-search'
    New-Item -ItemType Directory -Force $mod, (Join-Path $App 'layouts') | Out-Null
    Copy-Item -Recurse -Force (Join-Path $Src 'mods\files-search\*') $mod
    Copy-Item -Force (Join-Path $Src 'layouts\main-search.json') (Join-Path $App 'layouts\main-search.json')
    Write-Host "Installed files-search and main-search into $App."
  } finally {
    if ($Tmp) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Tmp }
  }

  if ($HerdrApp) {
    $r = Invoke-HerdrApp @('check', $mod)
    if ($r.Code -ne 0) { throw "herdr-app check failed: $($r.Err)$($r.Out)" }
    if ($r.Out) { Write-Host $r.Out.Trim() }
  } else {
    Write-Host 'herdr-app not found: skipped the mod check.'
  }

  if (Get-HerdrStatus) {
    Invoke-HerdrApp @('do', 'layout.switch', '--name', 'main-search') | Out-Null
    Write-Host 'Switched Herdr to the main-search layout. Open the Files panel to search.'
  } else {
    Write-Host "Herdr isn't running. Start it, then run: herdr-app do layout.switch --name main-search"
  }

  if (-not (Get-Command rg -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host 'ripgrep (rg) is missing. Search needs it on every machine you search:'
    Write-Host '  winget install BurntSushi.ripgrep.MSVC'
    Write-Host 'Then restart Herdr so it sees the new PATH.'
  }
} $Uninstall.IsPresent
