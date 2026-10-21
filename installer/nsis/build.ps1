# Build the Windows x64 installer with NSIS.
#
# Order matters: `npm pack` runs prepack (audit + web build), the tarball is
# unpacked into payload\, and only then does makensis run. The payload is embedded
# rather than unpacked at install time -- an installer that depends on tar.exe or
# PowerShell being present is not worth the few hundred KB it would save. The
# hash-aware update helper is a Node script instead, because Node is already
# required for `npm install`; installer.nsi falls back to the old full-replace
# path when Node/bun is unavailable.
#
#   .\build.ps1
#     -> installer\nsis\dist\mem-plus-installer-<version>.exe
#
# Single self-contained exe, works offline. It installs into
# %USERPROFILE%\.config\opencode\plugins\mem-plus and writes an uninstaller.

$ErrorActionPreference = "Stop"

$root      = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$nsisDir   = $PSScriptRoot
$payload   = Join-Path $nsisDir "payload"
$dist      = Join-Path $nsisDir "dist"
$makensis  = @(
  "C:\Program Files (x86)\NSIS\makensis.exe",
  "C:\Program Files\NSIS\makensis.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $makensis) {
  throw "makensis not found. Install NSIS: winget install NSIS.NSIS"
}

Write-Output "==> 1/4  read the version"
$version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
Write-Output "    mem-plus $version"

Write-Output "==> 2/4  pack (runs prepack: packaging audit + web build)"
Push-Location $root
try {
  Remove-Item "mem-plus-$version.tgz" -Force -ErrorAction SilentlyContinue
  # npm pack writes its manifest to stdout, which would drown this log; capture it
  # and check the exit code rather than trusting that the tarball appeared.
  $packOut = & npm pack 2>&1
  if ($LASTEXITCODE -ne 0) {
    $packOut | ForEach-Object { Write-Output ("    " + $_) }
    throw "npm pack failed ($LASTEXITCODE)"
  }
} finally { Pop-Location }
$tarball = Join-Path $root "mem-plus-$version.tgz"
if (-not (Test-Path $tarball)) { throw "npm pack produced no tarball at $tarball" }
Write-Output ("    tarball {0:N2} MB" -f ((Get-Item $tarball).Length / 1MB))

Write-Output "==> 3/4  stage the payload (unpacked, with the package/ layer removed)"
if (Test-Path $payload) { Remove-Item $payload -Recurse -Force }
New-Item -ItemType Directory -Force -Path $payload | Out-Null
$unpack = Join-Path $env:TEMP ("mem-plus-payload-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $unpack | Out-Null
try {
  # tar writes its own diagnostics to stderr; capturing them turns a failure into a
  # readable message instead of the next line's "path not found".
  $tarOut = & tar -xzf $tarball -C $unpack 2>&1
  if ($LASTEXITCODE -ne 0) {
    $tarOut | ForEach-Object { Write-Output ("    " + $_) }
    throw "tar could not unpack $tarball (exit $LASTEXITCODE)"
  }
  # `npm pack` puts everything under package/. The install directory *is* the
  # package -- OpenCode scans ~/.config/opencode/plugins/* -- so the layer has to
  # come off here, not in the installer.
  $inner = Join-Path $unpack "package"
  if (-not (Test-Path $inner)) {
    throw "the tarball has no package/ directory: $(@(Get-ChildItem $unpack | ForEach-Object { $_.Name }) -join ', ')"
  }
  Get-ChildItem $inner -Force | Move-Item -Destination $payload
} finally {
  if (Test-Path $unpack) { Remove-Item $unpack -Recurse -Force -ErrorAction SilentlyContinue }
}
$files = @(Get-ChildItem $payload -Recurse -File).Count
Write-Output "    payload $files files, $([math]::Round(((Get-ChildItem $payload -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)) MB"

# payload-manifest.nsh lists every payload path as an explicit Delete/RMDir, so the
# uninstaller removes what it installed and nothing else. Generated here, from the
# tree that was just staged, so the two cannot drift.
#
# NSIS cannot enumerate a directory, and its own manual (4.9.1.9) warns that
# "RMDir /r $INSTDIR in the uninstaller is not safe ... The user can also put other
# files in the installation folder and wouldn't expect them to get deleted along
# with the program." That is exactly the situation here: users put the bge-m3 model
# (~2.2 GB) in <plugin root>/models, which defaultModelDir() looks there for before
# falling back to the state root. (An earlier version of this comment also claimed
# NSIS has no loop, which is false -- it has loop/loopend and the string functions,
# and RemoveStalePayload in installer.nsi is one. Only enumeration is missing, and
# that is the part this design turns on.)
#
# Compile-time inclusion rather than a runtime manifest read: makensis then checks
# every line, and there is no FileOpen/FileRead loop or plugin in the uninstaller.
# It also means a user file can never be "uninstalled by omission" -- if it is not
# in this list, it is not ours and nothing touches it.
#
# This list is for UNINSTALL and is deliberately not reused for upgrade, because it
# enumerates the payload as of THIS build, and an upgrade needs what the PREVIOUS
# build wrote. That is what payload-files.txt below is for.
#
# Scope limit worth knowing: this covers the PAYLOAD only. node_modules and
# package-lock.json are produced by `npm install` at install time, so they are not
# here and installer.nsi deletes them explicitly.
#
# Measured on this payload: 0 paths contain a dollar sign or a quote and 0 are
# non-ASCII, so they need no escaping and ascii output is safe. The generator
# re-checks both and fails the build rather than emitting something NSIS mis-parses.
$manifest = New-Object System.Collections.Generic.List[string]
$manifest.Add("; Generated by build.ps1 -- do not edit. One Delete per payload file, then")
$manifest.Add("; one RMDir per payload directory, deepest first. Anything not listed here")
$manifest.Add("; was not installed by us and is deliberately left alone.")
$rootLen = $payload.Length + 1

foreach ($f in (Get-ChildItem $payload -Recurse -File | Sort-Object FullName)) {
  $rel = $f.FullName.Substring($rootLen)
  if ($rel -match '[$"|]') { throw "payload path needs NSIS/hash escaping: $rel" }
  if ($rel -match '[^\x20-\x7E]') { throw "payload path is not plain ASCII: $rel" }
  $manifest.Add('Delete "$INSTDIR\' + $rel.Replace('/', '\') + '"')
}

# Deepest first, so a directory is empty by the time its RMDir runs. No /r: a
# directory that still has files in it is one the user still owns, and survives.
$dirs = @(Get-ChildItem $payload -Recurse -Directory | Sort-Object @{ Expression = { ($_.FullName -split '\\').Count } }, FullName -Descending)
foreach ($d in $dirs) {
  $rel = $d.FullName.Substring($rootLen)
  $manifest.Add('RMDir "$INSTDIR\' + $rel.Replace('/', '\') + '"')
}

Set-Content (Join-Path $nsisDir "payload-manifest.nsh") -Value ($manifest -join "`r`n") -Encoding ascii -NoNewline
Write-Output "    manifest $($manifest.Count - 3) paths ($files files, $($dirs.Count) dirs)"

# payload-files.txt / payload-dirs.txt are the RUNTIME counterpart of that manifest, and they
# exist for one reason: an overwrite install leaves behind anything the OLD release wrote that
# the NEW release no longer contains. Measured on this repo: 20 of the 66 files the read-side
# switch deleted were payload files (memory-parse.ts, three transitive dependencies, ...), and
# a stale copy of any of them is loaded by Node's resolver exactly as if it were current --
# silent, and only visible as behaviour that does not match the version you installed.
#
# The upgrade path now compares content instead of deleting the whole tree first:
# sync-payload.mjs reads these two lists as the previous install's ownership record, hashes the
# file currently on disk against payload-hashes.txt, leaves identical files untouched, deletes
# changed files for installer.nsi's SetOverwrite-off pass to rewrite, deletes paths this payload
# no longer ships, and writes nothing that is already current. The old delete-everything-then-
# write path remains only as the fallback when Node or the helper is unavailable.
#
# Two files rather than one tagged file: at read time NSIS cannot tell a path from a directory
# without touching the disk, and a wrong guess here deletes or skips the wrong thing.
#
# Both are plain ASCII with no quotes, dollars, or pipes, same as payload-manifest.nsh. The pipe
# is also the separator in payload-hashes.txt, so a payload path containing one must fail the
# build rather than make the hash parser split in the wrong place.
$fileList = New-Object System.Collections.Generic.List[string]
foreach ($f in (Get-ChildItem $payload -Recurse -File | Sort-Object FullName)) {
  $rel = $f.FullName.Substring($rootLen)
  if ($rel -match '[$"|]') { throw "payload path needs NSIS/hash escaping: $rel" }
  if ($rel -match '[^\x20-\x7E]') { throw "payload path is not plain ASCII: $rel" }
  $fileList.Add($rel.Replace('/', '\'))
}
$dirList = New-Object System.Collections.Generic.List[string]
foreach ($d in $dirs) {
  $rel = $d.FullName.Substring($rootLen)
  $dirList.Add($rel.Replace('/', '\'))
}
# Both lists are LF-only, and that is load-bearing rather than cosmetic. NSIS's FileRead
# returns a line WITH its terminator still attached -- measured on this NSIS 3.13 build with
# an instrumented copy of the installer's read loop -- so a CRLF list would leave "\r\n"
# inside every path and a LF list still leaves "\n". The installer drops exactly one
# character (`StrCpy v v -1`), which is correct only while the terminator is one byte wide.
# So the separator is written as LF and the result is checked, rather than assumed: a CR
# reaching either file fails the build instead of producing an installer that reports
# success and deletes nothing.
$nl = "`n"
$fileList = New-Object System.Collections.Generic.List[string]
foreach ($f in (Get-ChildItem $payload -Recurse -File | Sort-Object FullName)) {
  $rel = $f.FullName.Substring($rootLen)
  if ($rel -match '[$"|]') { throw "payload path needs NSIS/hash escaping: $rel" }
  if ($rel -match '[^\x20-\x7E]') { throw "payload path is not plain ASCII: $rel" }
  $fileList.Add($rel.Replace('/', '\'))
}
$dirList = New-Object System.Collections.Generic.List[string]
foreach ($d in $dirs) {
  $rel = $d.FullName.Substring($rootLen)
  $dirList.Add($rel.Replace('/', '\'))
}
# A trailing separator is appended so the final line is not the one that trips the EOF check
# before its Delete runs.
$filesTxt = ($fileList -join $nl) + $nl
$dirsTxt = ($dirList -join $nl) + $nl
foreach ($pair in @(@("payload-files.txt", $filesTxt), @("payload-dirs.txt", $dirsTxt))) {
  if ($pair[1].Contains("`r")) { throw "$($pair[0]) must be LF-only: NSIS FileRead keeps the terminator" }
  Set-Content (Join-Path $nsisDir $pair[0]) -Value $pair[1] -Encoding ascii -NoNewline
}
Write-Output "    runtime lists $($fileList.Count) files, $($dirList.Count) dirs (LF-only, verified)"

# payload-hashes.txt is the new side of the update comparison. It is generated here, from the
# same staged tree, and embedded in the installer only -- it is never written into $INSTDIR.
# The installed tree is hashed at update time by sync-payload.mjs, not by NSIS: NSIS 3.13 has
# no SHA-256 primitive, and spawning certutil once per file (about 2,500 processes) is not an
# installer. Node is already a prerequisite for npm install, and the helper falls back to the
# old full-replace path when it is unavailable.
$hashList = New-Object System.Collections.Generic.List[string]
foreach ($rel in $fileList) {
  $abs = Join-Path $payload $rel
  $hash = (Get-FileHash -LiteralPath $abs -Algorithm SHA256).Hash.ToLowerInvariant()
  $hashList.Add($rel + '|' + $hash)
}
$hashTxt = ($hashList -join $nl) + $nl
if ($hashTxt.Contains("`r")) { throw "payload-hashes.txt must be LF-only" }
Set-Content (Join-Path $nsisDir "payload-hashes.txt") -Value $hashTxt -Encoding ascii -NoNewline
Write-Output "    hash manifest $($hashList.Count) files (LF-only, sha256)"

# version.nsh is generated rather than committed: the version lives in
# package.json and must not be duplicated by hand. Built with explicit newlines --
# a backtick escape inside this string is consumed by PowerShell before NSIS ever
# sees it, which is how an earlier revision shipped a file starting with "NSEF".
$nl = [Environment]::NewLine
$versionSh = "; Generated by build.ps1 -- do not edit. The version lives in package.json." +
            $nl + "!define MEMPLUS_VERSION `"$version`"" + $nl
Set-Content (Join-Path $nsisDir "version.nsh") -Value $versionSh -Encoding ascii -NoNewline

Write-Output "==> 4/4  makensis"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
# MUI2's language files live in Contrib, which is not on makensis's default
# include path. The absolute path is written out here (rather than guessed inside
# the script) so the build works from any shell and any working directory.
$nsisHome = Split-Path $makensis -Parent
$langDir = Join-Path $nsisHome "Contrib\Language files"
if (-not (Test-Path (Join-Path $langDir "SimpChinese.nsh"))) {
  throw "SimpChinese.nsh not found under $langDir -- is this a full NSIS install?"
}
"!addincludedir `"$langDir`"" | Set-Content (Join-Path $nsisDir "nsis-paths.nsh") -Encoding ascii

Push-Location $nsisDir
try {
  # /INPUTCHARSET UTF8 is not optional: the script is UTF-8 (it is full of Chinese
  # copy), and makensis defaults to the ANSI code page, which fails it with
  # "Bad text encoding" partway through.
  $out = & $makensis "/INPUTCHARSET" "UTF8" "installer.nsi" 2>&1
  $code = $LASTEXITCODE
} finally { Pop-Location }
$out | ForEach-Object { Write-Output ("    " + $_) }
if ($code -ne 0) { throw "makensis failed ($code)" }

$exe = Join-Path $dist "mem-plus-installer-$version.exe"
Write-Output ""
Write-Output "  $exe  ($([math]::Round((Get-Item $exe).Length / 1MB, 2)) MB)"
Write-Output ""
Write-Output "  test it somewhere harmless before shipping:"
# /S first, /D= LAST. The order is load-bearing, not style: NSIS honours /D= only
# as the final parameter, and drops it entirely if anything follows. With /S also in
# the line that is a silent install to the real default location for anyone who
# copies this hint -- which is what happened while testing on 2026-10-11, twice.
Write-Output "    & `"$exe`" /S `"/D=$env:LOCALAPPDATA\Temp\opencode\mem-plus-test`""
Write-Output "    then run the Uninstall.exe in that directory to test the uninstaller"