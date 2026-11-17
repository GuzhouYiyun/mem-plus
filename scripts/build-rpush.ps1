# Build rpush.mjs for scripts/probe-recall-push.mjs: esbuild bundle, adding --external only for specifiers whose target file is verified absent (docs/port-plan.md 直驱配方 rule: never blind-add).
# Rebuild whenever plugin/src or its closure changes; the bundle lives in %TEMP%\opencode\rpush-build and does not survive temp cleanup.
$root = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $PSScriptRoot "probe-recall-push.entry.ts"
$out = Join-Path $env:TEMP "opencode\rpush-build"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Set-Content -Path (Join-Path $out "package.json") -Value '{"type":"module"}'
# The two schema .sql files are read relative to the bundle at module init.
foreach ($f in @("openclaw-agent-schema.sql", "openclaw-state-schema.sql")) {
  Copy-Item (Join-Path $root "src\state\$f") (Join-Path $out $f) -Force
}

$externals = [System.Collections.Generic.List[string]]::new()

$banner = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
for ($round = 1; $round -le 20; $round++) {
  $esbArgs = @($entry, "--bundle", "--format=esm", "--platform=node", "--main-fields=module,main",
            "--outfile=$out\rpush.mjs", "--banner:js=$banner")
  foreach ($e in $externals) { $esbArgs += "--external:$e" }
  $errs = & npx esbuild @esbArgs 2>&1 | Where-Object { $_ -match 'Could not resolve' }
  if (-not $errs) { "round ${round}: clean build ($($externals.Count) externals)"; break }
  # esbuild prints: X [ERROR] Could not resolve "<spec>" ... then the source file line.
  $verbose = (& npx esbuild @esbArgs 2>&1 | Out-String) -replace "`e\[[0-9;]*m", ""
  $pairs = [regex]::Matches($verbose, 'Could not resolve "([^"]+)"[\s\S]{0,400}?\n\s{4}(\S+):\d+:\d+:')
  $new = 0
  foreach ($m in $pairs) {
    $spec = $m.Groups[1].Value
    $file = $m.Groups[2].Value
    if ($externals -contains $spec) { continue }
    $from = Join-Path $root ($file -replace '/', '\')
    $target = Join-Path (Split-Path -Parent $from) $spec
    $real = [IO.Path]::GetFullPath($target)
    if (Test-Path $real) { throw "target EXISTS, refusing external: $spec -> $real (from $file)" }
    $externals.Add($spec); $new++
    "  + external $spec (absent: $real)"
  }
  if ($new -eq 0) { throw "round ${round}: errors but no new externals; stuck on: $($errs -join ' | ')" }
}
if (-not (Test-Path (Join-Path $out "rpush.mjs"))) { throw "bundle missing" }
"bundle: $((Get-Item (Join-Path $out 'rpush.mjs')).Length) bytes"
