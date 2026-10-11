; mem-plus installer -- NSIS.
;
; Why NSIS: the target is a wizard, not a script. MUI2 supplies the page flow, the
; component picker, the directory browser, the progress display and a working
; uninstaller, all of it battle-tested on every Windows. The payload is embedded,
; so the exe installs with no network and no helper tools.
;
; Build: build.ps1 runs `npm pack` first, unpacks the tarball into payload\, then
; calls makensis on this file. Nothing here unpacks a .tar.gz at install time --
; that would mean shelling out to tar.exe or PowerShell, and an installer that can
; fail because a helper tool is missing is not worth the few hundred KB.
;
; ORDER MATTERS IN THIS FILE. Sections come before functions, because a section id
; becomes a macro only at the point makensis reaches its declaration, and .onInit
; refers to ${SecVectors}. Move the sections down and the build fails at that line.

Unicode true

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "version.nsh"
!include "nsis-paths.nsh"

Name        "mem-plus"
OutFile     "dist/mem-plus-installer-${MEMPLUS_VERSION}.exe"
; Placeholder only. .onInit replaces $INSTDIR with the path OpenCode actually
; scans, because this literal is wrong for anyone who has set either of the two
; environment variables below -- see ResolveInstallDir.
InstallDir  "$PROFILE\.config\opencode\plugins\mem-plus"
InstallDirRegKey HKCU "Software\mem-plus" "InstallDir"

; A plugin lives in the user's own profile. Asking for elevation would put a UAC
; prompt in front of every install for something that does not need one.
RequestExecutionLevel user

; LZMA in solid mode: the vendored openclaw tree is ~2550 small files, and they
; compress far better as one block than one by one.
SetCompressor /SOLID lzma
SetCompressorDictSize 32

VIProductVersion "${MEMPLUS_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName"     "mem-plus"
VIAddVersionKey /LANG=2052 "ProductVersion"  "${MEMPLUS_VERSION}"
VIAddVersionKey /LANG=2052 "FileDescription" "mem-plus 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion"     "${MEMPLUS_VERSION}"
VIAddVersionKey /LANG=2052 "CompanyName"     "mem-plus"
VIAddVersionKey /LANG=2052 "LegalCopyright"  "MIT"

!define MUI_ABORTWARNING

; Component page layout. MUI2 ships three dialog templates for this page and this
; picks one of them:
;
;   default    components list and description side by side, each half the
;              available height. Measured on this build: list at x=179 w=147,
;              description at x=341 w=134. The list is half as wide as it could be
;              and the text truncates mid-character.
;   SMALLDESC  list on top spanning the full width, description as a banner
;              underneath -- the layout shipping installers use. Measured: list at
;              x=179 w=293 (twice the default) h=98, description at x=179 y=252
;              w=293.
;   NODESC     full-width list, no description at all. Not usable here: the
;              description is how "what is this component" gets said.
;
; Sizes above are from enumerating the real controls of both builds, not from the
; template source -- MUI2 bakes them into modern*.exe and offers no width define,
; so the template choice is the only lever there is.
!define MUI_COMPONENTSPAGE_SMALLDESC
; MUI2 has no MUI_FINISHPAGE_RUN -- that was MUI v1, and defining it here is
; silently ignored (the function it names compiles out with a 6010 warning). MUI2's
; finish page also has no hook for adding a control, so nothing extra can live
; there. The "reload OpenCode" step is a section instead, so it runs while the
; installer is still in front of the user rather than after they close it.
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "mem-plus ${MEMPLUS_VERSION} 已安装到：$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nOpenCode 已经重新加载，记忆功能现在就可以用了。$\r$\n$\r$\n验证：浏览器打开 http://127.0.0.1:4747/ ，能看到记忆浏览器即为正常。$\r$\n$\r$\n要卸载：Windows 设置 → 应用 → 已安装的应用 → mem-plus → 卸载。记忆数据不受影响。$\r$\n$\r$\n提示：没有装向量检索组件，搜索按全文检索工作（这是没有可用 GPU 时的正常回退方式）。"

; The uninstaller is a normal MUI2 wizard, not a bare "are you sure" box. It says
; what it is about to delete, because the line it runs is RMDir /r and the user
; is entitled to know the exact directory before it happens.
; $INSTDIR is used rather than a literal profile path, because with
; OPENCODE_CONFIG_DIR or XDG_CONFIG_HOME set the plugin is not under the profile
; and a literal here would name a directory that is not the one being touched.
!define MUI_UNCONFIRMPAGE_TEXT_TOP "将删除 mem-plus 插件文件：$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\n你的记忆数据保存在另一个目录（与上面这个不同名），不会被删除。"
!define MUI_UNFINISHPAGE_TEXT_TOP "mem-plus 已卸载。$\r$\n$\r$\n$\r$\n你的记忆数据仍然保存在原来的位置，不会被删除。$\r$\n$\r$\n如果之后还想用，重新运行安装程序即可；记忆会立刻回来。"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Var Vectors

; ------------------------------------------------------------------- where --
; OpenCode discovers plugins by scanning <config>/plugins/*, and "config" is not
; always ~/.config/opencode. Measured on this machine with `opencode debug paths`
; (2026-10-11), which is the authoritative answer because it is OpenCode itself
; reporting, not a guess about its layout:
;
;   nothing set                     -> C:\Users\<you>\.config\opencode
;   OPENCODE_CONFIG_DIR=C:\ocd1      -> C:\ocd1                  (wins, no "opencode" appended)
;   XDG_CONFIG_HOME=C:\xdg1          -> C:\xdg1\opencode
;   both set                         -> C:\ocd1                  (OPENCODE_CONFIG_DIR wins)
;
; Note the asymmetry in the second row: OPENCODE_CONFIG_DIR *is* the config
; directory, while XDG_CONFIG_HOME is its parent. Getting that wrong puts the
; plugin one level above where OpenCode looks, which is a silent failure -- the
; install succeeds, the plugin never loads, and nothing anywhere says why.
;
; The plugin's own paths.ts resolves configHome() the same way (XDG_CONFIG_HOME
; else ~/.config), so it was already correct and the installer was the odd one out.
;
; An env var is read at install time, not compile time, so this has to be runtime
; code: `!ifenv` would test the build machine, which is the wrong machine.
Function ResolveInstallDir
  ; The compile-time default, spelled out again so the comparison below has
  ; something to compare against. Keep the two byte-identical or every install
  ; re-resolves and throws away the directory the user picked.
  StrCpy $3 "$PROFILE\.config\opencode\plugins\mem-plus"
  ${If} $INSTDIR != $3
    Return          ; /D= or InstallDirRegKey already supplied one; leave it alone
  ${EndIf}

  ; Ask OpenCode rather than reimplementing its resolution rules. `debug paths`
  ; already knows about OPENCODE_CONFIG_DIR and XDG_CONFIG_HOME, including the
  ; asymmetry between them -- which is exactly the part worth not reimplementing.
  ; Measured on this machine, 2026-10-11:
  ;
  ;   nothing set                -> C:\Users\<you>\.config\opencode
  ;   OPENCODE_CONFIG_DIR=C:\ocd1 -> C:\ocd1             (it IS the config dir)
  ;   XDG_CONFIG_HOME=C:\xdg1     -> C:\xdg1\opencode    (parent, plus "opencode")
  ;   both                       -> C:\ocd1             (the former wins)
  ;
  ; Getting that asymmetry wrong puts the plugin one level off, and it fails
  ; silently: the install reports success and the plugin is simply never loaded.
  ;
  ; The cmd pipeline does the parsing rather than the script: `findstr /b` keeps
  ; only the line whose first characters are "config" (so `OPENCODE_CONFIG` style
  ; labels elsewhere in the output cannot match), and `tokens=*` drops the leading
  ; whitespace while keeping the rest of the line intact -- which matters because
  ; a Windows path can contain spaces ("C:\Users\Jane Doe\...").
  nsExec::ExecToStack 'cmd /c for /f "tokens=*" %a in (''opencode debug paths ^| findstr /b config'') do @echo %a > "$TEMP\mp-oc-config.txt"'
  Pop $0

  FileOpen $1 "$TEMP\mp-oc-config.txt" r
  ${If} $1 == ""
    DetailPrint "未能向 OpenCode 询问配置目录，使用默认路径。"
    Return
  ${EndIf}
  FileRead $1 $2      ; one line; FileRead strips the newline, no trimming needed
  FileClose $1

  ${If} $2 == ""
    DetailPrint "OpenCode 未报告配置目录，使用默认路径：$INSTDIR"
    Return
  ${EndIf}

  StrCpy $INSTDIR "$2\plugins\mem-plus"
  DetailPrint "OpenCode 配置目录：$2"
FunctionEnd

; ------------------------------------------------------------------ sections --
; Component presentation, the way shipping installers do it -- all three of these
; are NSIS features, none of them is a workaround:
;
;   SectionIn RO   the row is greyed and cannot be toggled (NSIS Reference:
;                  "the section will be read-only, meaning the user won't be able
;                  to change its state"). Necessary, not cosmetic: while these
;                  were plain sections, "mem-plus（必需）" and "安装依赖" were
;                  tickable, and unticking either yields an install with no
;                  node_modules -- a plugin that cannot run, exit code 0, nothing
;                  in any log.
;   Section /o     unchecked by default, so the optional component does not need
;                  .onInit to clear it. Verified: under /S an /o section does not
;                  run, which is what the silent install relies on.
;
; NSIS also has `Section "!name"` for a bold row. Deliberately not used: with every
; row the same weight, the one optional component is the only thing that stands out
; by not being greyed, which is the distinction that matters here. Bold would add a
; second, weaker signal pointing at the wrong row.
;
; Earlier revisions hid the mandatory sections entirely (no name at all). That was
; also correct but wrong-looking: a real setup lists what it is doing, and an empty
; list box with one lone row reads as a broken page.
; NO NAME, no id -- that is the whole mechanism. An unnamed section is a "required"
; section: makensis counts it in the "N sections (1 required)" build line, it is
; not listed on the component page, and there is no checkbox to untick. A trailing
; comment does not do this; the name must be absent. Verified 2026-10-10, after a
; version that kept the names and a trailing "; unnamed" comment still showed four
; tickable rows.
Section "mem-plus 记忆插件" SecMain
SectionIn RO
  SetOutPath "$INSTDIR"
  ; Recursive: the package is ~2550 files (the vendored openclaw tree) and every
  ; one of them is loaded at runtime.
  File /r "payload\*"

  WriteRegStr HKCU "Software\mem-plus" "InstallDir" "$INSTDIR"

  ; After `File /r`, because $INSTDIR does not exist until then -- WriteUninstaller
  ; into a missing directory is a silent no-op here, not an error.
  ;
  ; The backslash is load-bearing. "$INSTDIR/Uninstall.exe" compiles cleanly,
  ; raises no error flag, and produces no file on this NSIS; "$INSTDIR\Uninstall.exe"
  ; works. Verified by a byte-level diff of two otherwise identical scripts (0x2F vs
  ; 0x5C for the separator, same 43-char line). So the usual NSIS advice to prefer
  ; forward slashes has a real exception on this build, and getting it wrong looks
  ; exactly like "uninstallers are broken here". The same applies to $SMPROGRAMS
  ; below: "$SMPROGRAMS/mem-plus" created nothing.
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Add/Remove Programs, per user. This is the whole point of the uninstaller:
  ; a per-user plugin has no business claiming a machine-wide entry or asking
  ; for elevation, but it should still be findable where Windows users look.
  ; HKCU (not HKLM) is what makes that true without a UAC prompt.
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\mem-plus" "DisplayName"     "mem-plus ${MEMPLUS_VERSION}"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\mem-plus" "Publisher"        "mem-plus"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\mem-plus" "DisplayVersion"   "${MEMPLUS_VERSION}"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\mem-plus" "DisplayIcon"      "$INSTDIR\Uninstall.exe"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\mem-plus" "InstallLocation"  "$INSTDIR"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\mem-plus" "UninstallString"  '"$INSTDIR\Uninstall.exe"'
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\mem-plus" "HelpLink"         "https://github.com/mem-plus/mem-plus"
  ; NoModify/NoRepair: there is no repair path, and offering one that cannot
  ; work is worse than not offering it.
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\mem-plus" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\mem-plus" "NoRepair" 1
  ; A silent install (/S) runs no component page, so the vector section is never
  ; selected and this stays 0: full-text search. Same default either way.
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\mem-plus" "EstimatedSize" 0

  CreateDirectory "$SMPROGRAMS\mem-plus"
  CreateShortCut "$SMPROGRAMS\mem-plus\打开插件文件夹.lnk" "$INSTDIR"
  CreateShortCut "$SMPROGRAMS\mem-plus\卸载 mem-plus.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

; Named "依赖" on purpose. What this row installs is node-llama-cpp -- the GPU
; runtime -- and NOT the embedding model: bge-m3-FP16.gguf lives in models/, which
; is gitignored and never packed, and nothing in the plugin fetches it (there is
; no download path in plugin/src/model at all). Ticking this row alone does not
; turn on vector search; it removes one of two prerequisites. Calling it
; "本地向量检索" promised a feature the box does not deliver.
;
; The model is not bundled because it is ~2.2 GB against a 3 MB installer, and
; most installs never need it -- full-text search is a complete mode, not a
; degraded one. See the description below for where to put it.
Section /o "本地向量检索依赖" SecVectors
  ; /o is unchecked by default, so .onInit no longer has to clear it -- which
  ; removes the last place a wrong section index could silently skip a step.
  ;
  ; AddSize is what makes the page's "所需空间" line honest. Without it the page
  ; reports only the ~19 MB payload and never mentions the 690 MB this row adds,
  ; so the one number a user is judging the choice by is the one number missing.
  AddSize 705000
  ; The flag is set here, not read from a Var the user never touches: a section
  ; only runs when it is selected, so its presence *is* the answer.
  StrCpy $Vectors "1"
SectionEnd

Section "安装依赖" SecDeps
SectionIn RO
  DetailPrint "正在安装依赖，请稍候……"
  ; `--omit=optional` is the whole 690 MB: node-llama-cpp pulls per-platform GPU
  ; binaries (win-x64, win-arm64, cuda, vulkan, cuda-ext all at once).
  ${If} $Vectors == "1"
    DetailPrint "安装全部依赖（含向量检索组件）……"
    ClearErrors
    nsExec::ExecToLog 'cmd /c npm install --prefix "$INSTDIR" --no-audit --no-fund'
  ${Else}
    DetailPrint "安装依赖（不含向量检索组件）……"
    ClearErrors
    nsExec::ExecToLog 'cmd /c npm install --prefix "$INSTDIR" --omit=optional --no-audit --no-fund'
  ${EndIf}
  ${If} ${Errors}
    ; npm can be missing from this process's PATH even when `where` found it --
    ; common when OpenCode was launched from a shortcut. bun is the documented
    ; fallback and produces an equivalent tree.
    DetailPrint "npm 不可用，改用 bun……"
    ClearErrors
    ${If} $Vectors == "1"
      nsExec::ExecToLog 'cmd /c bun install --cwd "$INSTDIR"'
    ${Else}
      nsExec::ExecToLog 'cmd /c bun install --omit=optional --cwd "$INSTDIR"'
    ${EndIf}
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION \
        "依赖安装失败：既没有可用的 npm，也没有可用的 bun。$\r$\n$\r$\n\
         $INSTDIR 已经有文件了，但还不能运行。$\r$\n\
         请安装 Node.js 或 bun 后，在该目录里手动执行 npm install。"
      Abort
    ${EndIf}
  ${EndIf}
  DetailPrint "依赖安装完成。"
SectionEnd

Section "重新加载 OpenCode" SecReload
SectionIn RO   ; the one step the user could reasonably want to skip, so it is
                ; listed rather than hidden -- just not changeable
  ; The last step of "download, double-click, use it". OpenCode is a running Bun
  ; process, so this installer cannot restart it -- but it does not have to:
  ; `opencode reload` re-runs every plugin's setup against the files on disk,
  ; which is exactly what a freshly installed plugin needs. Verified on
  ; 2026-10-10: the log's "plugin loaded" count goes up and the command exits 0
  ; with "Configuration reloaded".
  ;
  ; Failures are not fatal. If OpenCode is not on PATH, or is not running, or the
  ; reload does not reach the server, the install is still complete and the user
  ; can start OpenCode themselves -- the finish page says so.
  nsExec::ExecToStack 'cmd /c opencode reload'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "没有找到正在运行的 OpenCode，请手动启动它（安装已完成）。"
  ${Else}
    DetailPrint "OpenCode 已重新加载，记忆功能现在可用。"
  ${EndIf}
SectionEnd

; ---------------------------------------------------------------- uninstall --
; Not on the component page: NSIS special-cases a section named "Uninstall" and
; never lists it, so it adds nothing the user can deselect.
Section "Uninstall"
  ; Guard before the recursive delete. $INSTDIR is read back from the registry
  ; key this installer wrote, and a hand-edited or stale value would otherwise
  ; point RMDir /r at an arbitrary directory. package.json ships in the payload
  ; and is unique enough to be a real check -- no other mem-plus file is, since
  ; the tree is the upstream one.
  IfFileExists "$INSTDIR\package.json" 0 not_mem_plus
  DetailPrint "删除插件文件……"

  ; One line, and the reason it is safe: $INSTDIR is
  ; %USERPROFILE%\.config\opencode\plugins\mem-plus -- the *plugin*. The user's
  ; memory lives in a different directory one level up, at
  ; %USERPROFILE%\.config\opencode\mem-plus\ (the diaries, the SQLite index and
  ; DREAMS.md). OpenCode keeps them separate, so no path expression below can
  ; reach them: $INSTDIR is never a parent of it, and nothing walks up.
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"

  Delete "$SMPROGRAMS\mem-plus\打开插件文件夹.lnk"
  Delete "$SMPROGRAMS\mem-plus\卸载 mem-plus.lnk"
  RMDir "$SMPROGRAMS\mem-plus"
  DeleteRegKey HKCU "Software\mem-plus"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\mem-plus"
  DetailPrint "已从 Windows 应用列表中移除。"
  Goto done

not_mem_plus:
  ; Say why, and stop. A silent no-op here would look like a successful
  ; uninstall while leaving a stray folder behind.
  MessageBox MB_OK|MB_ICONEXCLAMATION \
    "这个路径下没有找到 mem-plus：$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\n\
     已经停止，没有删除任何东西。$\r$\n$\r$\n\
     你的记忆数据（$PROFILE\.config\opencode\mem-plus）没有被触碰。"
  Abort

done:
SectionEnd

; What each component IS, not why you might want it. The previous wording was
; answering objections nobody had asked yet -- "不勾选也能正常使用…不是故障" is a
; reply to a worried user, and reading like one while deciding. A description
; pane on a component page is a label, not a reassurance.
;
; Short names on purpose: the list is a fixed-width control baked into MUI2's
; modern_nodesc.exe dialog template, with no define to widen it and no custom-page
; hook to replace it. Long names truncate mid-character, they do not wrap.
; All of these are one line for the same reason as DESC_SecVectors below.
LangString DESC_SecMain    ${LANG_SIMPCHINESE} \
  "记忆插件本体：记住你的项目、偏好和你们一起做过的事。"
LangString DESC_SecDeps    ${LANG_SIMPCHINESE} \
  "安装插件运行所需的依赖库。"
LangString DESC_SecReload  ${LANG_SIMPCHINESE} \
  "让正在运行的 OpenCode 重新加载配置，装完即可用。"
; ONE sentence. The SMALLDESC layout gives the description a 53px banner (two lines
; at this font) -- it is a label, not a place for paragraphs. An earlier four-
; paragraph version rendered its first line and silently clipped the rest, which
; is how the "you also need the model" warning ended up invisible: it was the
; fourth paragraph. If this ever needs to grow, MUI2's default template has a
; full-height description pane on the right (see the layout comment above).
LangString DESC_SecVectors ${LANG_SIMPCHINESE} \
  "GPU 运行库。还需要另行下载 bge-m3 模型（约 2.2 GB）才能开启向量检索。"

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} $(DESC_SecMain)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDeps} $(DESC_SecDeps)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecReload} $(DESC_SecReload)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecVectors} $(DESC_SecVectors)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ------------------------------------------------------------------ functions --
; Everything below references ${SecVectors}, which is why the sections above
; could not simply live at the bottom of the file.

; Check the one thing that makes an install impossible before writing a file:
; is there a package manager at all.
;
; npm first, because the postinstall hook is a node script and the README
; documents npm. bun second, because OpenCode ships as a Bun binary -- a machine
; can easily have that and no Node, and there `npm install` is not an option.
Function DetectPackageManager
  nsExec::ExecToStack 'cmd /c where npm'
  Pop $0
  Pop $1
  ${If} $0 == 0
    StrCpy $0 "npm"
  ${Else}
    nsExec::ExecToStack 'cmd /c where bun'
    Pop $0
    Pop $1
    ${If} $0 == 0
      StrCpy $0 "bun"
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION \
        "这台机器上找不到 npm 或 bun。$\r$\n$\r$\n\
         请先安装 Node.js（https://nodejs.org）或 bun（https://bun.sh），然后重新运行本安装程序。$\r$\n$\r$\n\
         你也可以手动安装：把 mem-plus 的 tarball 解压到$\r$\n$PROFILE\.config\opencode\plugins\mem-plus$\r$\n\
         然后在该目录里执行 npm install。"
      Abort
    ${EndIf}
  ${EndIf}
  DetailPrint "包管理器：$0"
FunctionEnd

Function .onInit
  ; NOTE: there is deliberately no logging here, and nothing that calls a plugin
  ; before the install sections run. This NSIS install (winget's 3.13) does not
  ; implement WriteFile/LogSet/ExecWait, and adding one here made the installer
  ; abort silently under /S: payload written, no node_modules, no clue why.
  ; Anything added to this function has to be verified against a real silent
  ; install before it goes in.
  Call DetectPackageManager

  ; Where to install. The guard is a comparison against the compile-time default
  ; rather than a scan of $CMDLINE for "/D=", because it does not depend on
  ; whether NSIS applies /D= before or after .onInit -- which is not documented and
  ; is not worth guessing at. All three cases fall out correctly:
  ;
  ;   $INSTDIR is the default   -> nobody has an opinion yet, resolve it
  ;   $INSTDIR is something else -> either /D= or InstallDirRegKey already
  ;                                 supplied it, and both mean "use this"
  Call ResolveInstallDir
  ; No SectionSetFlags here any more. The vector component is `/o` (unchecked by
  ; default) in its own declaration, which is where NSIS wants that decision --
  ; and it is what a silent install reads too, verified 2026-10-10.
  ;
  ; It used to be cleared from here by index, and that cost a real bug: index 2 was
  ; cleared believing it was SecReload, when index 2 is SecDeps, so every install
  ; skipped `npm install` -- payload written, no node_modules, plugin unrunnable,
  ; exit code 0, nothing in any log. The declaration is the single source of truth
  ; now, so there is no index left to get wrong.
  ;
  ; The sections still sit above this function on purpose: ${SecMain} and friends
  ; must be declared before any use, so `.onInit` is below them.
  StrCpy $Vectors "0"
FunctionEnd

Function .onInstFailed
  ; Fires when a File/WriteRegKey step failed. Say plainly that $INSTDIR may be
  ; partial, rather than letting the user find out later.
  MessageBox MB_OK|MB_ICONEXCLAMATION \
    "安装过程中出错。$\r$\n$\r$\n$INSTDIR 可能是不完整的。请重新运行本安装程序覆盖它。$\r$\n\
     你的记忆数据保存在另一个目录，不受影响。"
FunctionEnd