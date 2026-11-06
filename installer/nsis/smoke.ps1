# 装机冒烟 0.3.3（无通道版）：shim 拦 opencode service + 预检 + /D= temp + temp XDG。
# 验：预检过 → 静默装 exit 0 → 载荷关键件/manifest/node_modules/runtime zip 落位 →
# 注册表两键指向 temp → shim 拦下 service、无 restart → 静默卸载清干净 → 清两键。
$ErrorActionPreference = "Continue"

$Repo     = "C:\Users\21991\repos\mem-plus"
$Exe      = Join-Path $Repo "installer\nsis\dist\mem-plus-installer-0.3.3.exe"
$TestDir  = "C:\Users\21991\AppData\Local\Temp\opencode\smoke33\inst"
$CfgRoot  = "C:\Users\21991\AppData\Local\Temp\opencode\smoke33\xdg"
$ShimDir  = "C:\Users\21991\AppData\Local\Temp\opencode\smoke33\ocshim"
$ShimLog  = "C:\Users\21991\AppData\Local\Temp\opencode\smoke33\shim.log"
$Results  = @()

function Check([string]$name, [bool]$pass, [string]$detail = "") {
  $script:Results += [pscustomobject]@{ name = $name; pass = $pass; detail = $detail }
  "{0}  {1}{2}" -f $(if ($pass) { "PASS" } else { "FAIL" }), $name, $(if ($detail) { "  | " + $detail } else { "" })
}

if (-not (Test-Path $Exe)) { Write-Output "FATAL: exe missing $Exe"; exit 1 }
Remove-Item "C:\Users\21991\AppData\Local\Temp\opencode\smoke33" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $TestDir, $CfgRoot, $ShimDir | Out-Null

# ---- shim：service 子命令恒失败（装机会重启机主 service 的实害防线），其余转发 ----
$RealOcCmd = (Get-Command opencode.cmd -ErrorAction Stop).Source
$ShimBody = "@echo off`r`necho %* >> `"$ShimLog`"`r`nif /I `"%~1`"==`"service`" exit /b 1`r`n`"$RealOcCmd`" %*`r`n"
Set-Content (Join-Path $ShimDir "opencode.cmd") -Value $ShimBody -Encoding ascii
$OldPath = $env:PATH
$env:PATH = $ShimDir + ";" + $OldPath
$env:XDG_CONFIG_HOME = $CfgRoot

# ---- 预检（failing control）：不过就不许跑安装 ----
cmd /c "opencode service status" | Out-Null
$PreStatus = $LASTEXITCODE
$PrePaths = (cmd /c "opencode debug paths config" | Out-String).Trim()
$ExpectCfg = Join-Path $CfgRoot "opencode"
$PreOk = ($PreStatus -ne 0) -and ($PrePaths -eq $ExpectCfg)
Check "预检：service status 被 shim 拦（exit!=0）" ($PreStatus -ne 0) "exit=$PreStatus"
Check "预检：debug paths config 转发且走 temp XDG" ($PrePaths -eq $ExpectCfg) "got=$PrePaths expect=$ExpectCfg"
if (-not $PreOk) {
  Write-Output "PRECHECK FAILED - install not run."
  $env:PATH = $OldPath; Remove-Item Env:\XDG_CONFIG_HOME
  exit 1
}

# ---- 静默安装 ----
$p = Start-Process -FilePath $Exe -ArgumentList "/S", "/D=$TestDir" -PassThru -Wait
Check "静默安装 exit 0" ($p.ExitCode -eq 0) "exit=$($p.ExitCode)"

# ---- 载荷 ----
$RtJson = Get-Content (Join-Path $Repo "plugin\serve\runtime.json") -Raw | ConvertFrom-Json
$RtName = "llama-$($RtJson.tag)-bin-win-vulkan-x64.zip"
Check "Uninstall.exe 在位" (Test-Path (Join-Path $TestDir "Uninstall.exe"))
Check "server.mjs 在位" (Test-Path (Join-Path $TestDir "plugin\serve\server.mjs"))
Check "runtime.json 在位" (Test-Path (Join-Path $TestDir "plugin\serve\runtime.json"))
$ManifestPath = Join-Path $TestDir ".mem-plus-payload-files.txt"
Check "payload 清单在位（.mem-plus-payload-files.txt）" (Test-Path $ManifestPath)
$lines = @(Get-Content $ManifestPath -ErrorAction SilentlyContinue)
# Compare against the build manifest rather than a number counted by hand: the
# payload grows by a file whenever a source file is added, and a hardcoded
# expectation then fails on a build that is actually correct.
$Expected = @(Get-Content (Join-Path $Repo "installer\nsis\payload-files.txt") -ErrorAction SilentlyContinue)
Check "清单行数与打包一致" ($lines.Count -eq $Expected.Count -and $Expected.Count -gt 0) "count=$($lines.Count) expected=$($Expected.Count)"
Check "node_modules 落位（npm install 跑过）" (Test-Path (Join-Path $TestDir "node_modules"))
$RtZip = Join-Path $CfgRoot "opencode\mem-plus\runtime\$RtName"
Check "runtime zip 预下载落 StateRoot" (Test-Path $RtZip) $RtZip

# ---- 注册表 ----
$InstDirReg = (Get-ItemProperty "HKCU:\Software\mem-plus" -Name InstallDir -ErrorAction SilentlyContinue).InstallDir
Check "HKCU InstallDir = temp 路径" ($InstDirReg -eq $TestDir) "got=$InstDirReg"
$Uninst = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\mem-plus" -ErrorAction SilentlyContinue
Check "Uninstall 键在且指向 temp" ($null -ne $Uninst -and $Uninst.InstallLocation -eq $TestDir) "loc=$($Uninst.InstallLocation)"

# ---- shim 实害防线：status 拦下、无 restart ----
$ShimLines = @(Get-Content $ShimLog -ErrorAction SilentlyContinue)
Check "shim 拦到 service status" (@($ShimLines | Where-Object { $_ -match "^service status" }).Count -ge 1) ($ShimLines -join " / ")
Check "无 service restart（机主 service 未被碰）" (@($ShimLines | Where-Object { $_ -match "service restart" }).Count -eq 0)

# ---- 静默卸载 ----
$Un = Start-Process -FilePath (Join-Path $TestDir "Uninstall.exe") -ArgumentList "/S" -PassThru -Wait
Check "静默卸载 exit 0" ($Un.ExitCode -eq 0) "exit=$($Un.ExitCode)"
Start-Sleep -Seconds 2
Check "卸载后 Uninstall.exe 已删" (-not (Test-Path (Join-Path $TestDir "Uninstall.exe")))
$LeftFiles = @(Get-ChildItem $TestDir -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne "payload-files.txt" -and $_.Name -ne "payload-dirs.txt" -and $_.Name -ne "Uninstall.exe" })
Check "载荷基本清空（残留<=2 清单件）" ($LeftFiles.Count -le 2) "left=$($LeftFiles.Count)"
$RegLeft = @()
if (Test-Path "HKCU:\Software\mem-plus") { $RegLeft += "Software\mem-plus" }
if (Test-Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\mem-plus") { $RegLeft += "Uninstall\mem-plus" }
Check "卸载后两注册表键已清" ($RegLeft.Count -eq 0) ($RegLeft -join ", ")

# ---- 收尾：强制清两键 + 还原 env + 删 temp ----
Remove-Item "HKCU:\Software\mem-plus" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\mem-plus" -Recurse -Force -ErrorAction SilentlyContinue
$env:PATH = $OldPath
Remove-Item Env:\XDG_CONFIG_HOME -ErrorAction SilentlyContinue

$Failed = @($Results | Where-Object { -not $_.pass })
Write-Output ""
Write-Output ("==== {0}/{1} PASS ====" -f ($Results.Count - $Failed.Count), $Results.Count)
foreach ($f in $Failed) { Write-Output ("FAIL: {0} | {1}" -f $f.name, $f.detail) }
Remove-Item "C:\Users\21991\AppData\Local\Temp\opencode\smoke33" -Recurse -Force -ErrorAction SilentlyContinue
if ($Failed.Count -gt 0) { exit 1 }
