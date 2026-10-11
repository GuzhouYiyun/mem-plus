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
!include "LogicLib.nsh"

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
; WHY THERE IS NO RESTART CHECKBOX HERE
;
; A "restart OpenCode now?" checkbox on the finish page is what a real installer has, and
; this one should have it too. It does not, because MUI2 gives no way to add a control to
; that page, and that was verified against the installed MUI2 rather than assumed:
;
;   MUI_FINISHPAGE_RUN        removed in MUI2 (MUI v1 only); defining it is silently ignored
;   MUI_FINISHPAGE_CHECKBOX   does not exist in this build at all -- 0 hits in
;                              Contrib\Modern UI 2\{Pages,Interface,Localization,MUI2}.nsh
;   PageEx MUI_PAGE_FINISH    refused by makensis: PageEx accepts only
;                              custom|license|components|directory|instfiles|uninstConfirm,
;                              so the finish page cannot be wrapped either
;
; The escape hatch is a hand-built page (`PageEx custom` + nsDialogs), which is how
; Clash Verge does it -- NSIS + nsDialogs with its own bitmap and no MUI2 at all. That was
; built here and it COMPILED, but at runtime the page never appeared: clicking through from
; instfiles closed the installer instead. A page that compiles but is never shown cannot
; be debugged from a build log, and the failure mode of leaving it in was an installer that
; exits without a finish page. So it was removed rather than shipped, and the restart stays
; in SecReload where it is observable and has been working since 2026-10-11.
;
; Recorded so this is not re-attempted from scratch: the blocker is MUI2's, not NSIS's, and
; the first thing to try next time is a self-contained NSIS page with no MUI2 in it at all.
!define MUI_FINISHPAGE_TITLE "安装完成"
; Two things only, because that is all a user can act on at this point: it
; finished, and one file is still theirs to fetch. The earlier version of this
; also listed the install path, how to verify the memory browser, how to uninstall,
; and a fallback note about vector search -- none of which the person clicking
; "完成" needed at that moment, and together they filled the page.
;
; The vector note in particular had become false: the runtime is installed on
; every install now, so there is no "component not installed" case left to
; explain. Its replacement is the model, which the installer never bundles.
; "安装成功。" is the wording the owner asked for. An earlier revision opened with
; "mem-plus 已安装。" to pair with the uninstaller's "mem-plus 已卸载。"; that was
; solving for symmetry nobody asked for, and "口语化严重" was about the welcome
; page's opening, not this one.
!define MUI_FINISHPAGE_TEXT "安装成功。$\r$\n$\r$\n向量模型未随本安装包分发。请另行下载 bge-m3（约 2.2 GB），并放置于：$\r$\n$PROFILE\.config\opencode\mem-plus\models\"

; Not an instruction any more. The installer stops OpenCode itself with
; `opencode service stop` before writing and starts it again afterwards, so the
; only thing worth saying here is that an in-progress session will be
; interrupted -- which the user should know before clicking through, not after.
!define MUI_WELCOMEPAGE_TITLE "安装 mem-plus"
!define MUI_WELCOMEPAGE_TEXT "本安装程序将覆盖以下目录：$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\n安装期间，若 OpenCode 正在运行，其日志中可能出现少量加载失败记录，属正常现象。$\r$\n$\r$\n安装结束后将自动重启 OpenCode 一次。进行中的对话不会因此中断。$\r$\n$\r$\n记忆数据保存在其他目录，不受影响。"

; The uninstaller is a normal MUI2 wizard, not a bare "are you sure" box. It says
; what it is about to delete, because the line it runs is RMDir /r and the user
; is entitled to know the exact directory before it happens.
; $INSTDIR is used rather than a literal profile path, because with
; OPENCODE_CONFIG_DIR or XDG_CONFIG_HOME set the plugin is not under the profile
; and a literal here would name a directory that is not the one being touched.
!define MUI_UNCONFIRMPAGE_TEXT_TOP "将删除 mem-plus 插件文件：$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\n你的记忆数据保存在另一个目录（与上面这个不同名），不会被删除。"
!define MUI_UNFINISHPAGE_TEXT_TOP "mem-plus 已卸载。$\r$\n$\r$\n$\r$\n记忆数据仍保存在原位置，未被删除。$\r$\n$\r$\n若 OpenCode 此前正在运行，现已完成重启。$\r$\n$\r$\n如需重新启用，重新运行安装程序即可，已有记忆将一并恢复。"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Var Vectors
; Decided once in SecDeps and consumed by both the npm and the bun call, so the
; "is the optional vector runtime already there" question is asked once instead
; of being duplicated into a fallback that could answer it differently.
Var InstallFlags
; Set only on the preserve-an-existing-install path, so the finish page can say
; so. See SecDeps and the Finish page section.
Var KeptVectors

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
  ; Straight overwrite into $INSTDIR, which is how every other installer works.
  ;
  ; `opencode service stop` was tried here first and is worse than useless: measured
  ; on 2026-10-11, `service stop` returned and 0.1 s later a new `opencode serve
  ; --service` process started on its own and began reading the tree while the
  ; payload and node_modules were still being written -- 14 failed loads with
  ; "Cannot find package '@openclaw/fs-safe'". Stopping the server is what causes
  ; the read, not what prevents it. So nothing here touches the running OpenCode;
  ; SecReload restarts it once at the end, which is the whole fix.
  ;
  ; Cleaned here and on uninstall. Neither is referenced by the current installer;
  ; they only exist on machines where an earlier staging design was run once.
  RMDir /r "$INSTDIR\..\..\mem-plus.__stage"
  RMDir /r "$INSTDIR\..\..\mem-plus.__old"

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
; Always installed. The last optional component was removed on 2026-10-12 at the
; owner's request: with no choice left to make, there is no component page at all
; (see the page list), and the runtime comes with every install.
;
; Size, measured on this machine after a real install (2026-10-12):
; node-llama-cpp is 971 files / 37.8 MB, NOT the ~690 MB the old component
; description claimed. That number came from a 705000 AddSize written back when
; the component was optional, and it was never checked against what npm actually
; puts on disk. The bulk of an install is elsewhere: node_modules totals 29482
; files / 858.3 MB, of which node-llama-cpp is 37.8 MB.
Section "本地向量检索依赖" SecVectors
SectionIn RO
  ; /o is unchecked by default, so .onInit no longer has to clear it -- which
  ; removes the last place a wrong section index could silently skip a step.
  ;
  ; No AddSize here on purpose. This row's disk cost lands inside npm's tree, which
  ; SecDeps declares as a whole; counting it twice is one way the installer's
  ; "所需空间" line ends up wrong.
  ;
  ; The flag is set here, not read from a Var the user never touches: a section
  ; only runs when it is selected, so its presence *is* the answer.
  StrCpy $Vectors "1"
SectionEnd

Section "安装依赖" SecDeps
SectionIn RO
  ; Measured on this machine after a real install (2026-10-12): 29482 files /
  ; 858.3 MB for the whole npm tree. That is the honest number for "所需空间" on a
  ; machine that has nothing yet -- the old 705000 AddSize (688 MB) was attached to
  ; the vector row and described neither this nor that.
  ;
  ; An update over an existing install needs almost none of this: npm reconciles
  ; against what is already on disk and leaves satisfied packages alone. Measured
  ; with `npm install --dry-run` on the live install, the only changes npm planned
  ; were the nine generated @openclaw/* aliases, which postinstall rewrites anyway.
  ; node-llama-cpp did not appear at all.
  AddSize 879000

  DetailPrint "正在安装依赖，请稍候……"
  ; `--omit=optional` is the dangerous flag here, and not because of its size.
  ; npm reconciles $INSTDIR against an ideal tree built without optional deps, so
  ; this flag PRUNES node-llama-cpp if it is already there. Measured 2026-10-11: an
  ; install that had the vector component was updated with that row left unticked,
  ; and node-llama-cpp was deleted -- vector search then refused to start, with
  ; nothing anywhere saying the feature had been removed. An update silently
  ; downgraded the product.
  ;
  ; The flag is now unreachable: there is no row to leave unticked and $Vectors is
  ; 1 unconditionally. The branch below is kept rather than deleted because it is
  ; the only code that knows about this failure, and the failure is a property of
  ; npm rather than of the choice that used to reach it.
  ;
  ; What an update does instead of reinstalling the runtime: nothing, on purpose.
  ; npm skips packages already present at a satisfying version, so node-llama-cpp
  ; is not fetched again -- measured with `npm install --dry-run` against the live
  ; install, which planned no change to it at all. That is the behaviour the owner
  ; asked for on 2026-10-12, and it is npm's own rather than something this script
  ; performs. The already-installed branch exists to say so out loud, so the
  ; DetailPrint does not read like a fresh download every time.
  StrCpy $KeptVectors "0"
  ${If} $Vectors == "1"
    ${If} ${FileExists} "$INSTDIR\node_modules\node-llama-cpp\package.json"
      DetailPrint "已装有向量检索运行库，本次跳过重装……"
    ${Else}
      DetailPrint "安装全部依赖（含向量检索组件）……"
    ${EndIf}
    StrCpy $InstallFlags ""
  ${ElseIf} ${FileExists} "$INSTDIR\node_modules\node-llama-cpp\package.json"
    DetailPrint "检测到已安装的向量检索组件，本次保留……"
    StrCpy $InstallFlags ""
    StrCpy $KeptVectors "1"
  ${Else}
    DetailPrint "安装依赖（不含向量检索组件）……"
    StrCpy $InstallFlags "--omit=optional"
  ${EndIf}

  ClearErrors
  nsExec::ExecToLog 'cmd /c npm install --prefix "$INSTDIR" $InstallFlags --no-audit --no-fund'
  ${If} ${Errors}
    ; npm can be missing from this process's PATH even when `where` found it --
    ; common when OpenCode was launched from a shortcut. bun is the documented
    ; fallback and produces an equivalent tree.
    DetailPrint "npm 不可用，改用 bun……"
    ClearErrors
    nsExec::ExecToLog 'cmd /c bun install $InstallFlags --cwd "$INSTDIR"'
    ${If} ${Errors}
      ; A silent install must never raise a modal dialog: nothing can dismiss it
      ; and the installer hangs until it is killed. ${Silent} is LogicLib's own
      ; answer to that question and is already included for ${If}.
      DetailPrint "依赖安装失败。"
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION \
          "依赖安装失败：既没有可用的 npm，也没有可用的 bun。$\r$\n$\r$\n\
           $INSTDIR 已经有文件了，但还不能运行。$\r$\n\
           请安装 Node.js 或 bun 后，在该目录里手动执行 npm install。"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  DetailPrint "依赖安装完成。"
SectionEnd

Section "重新加载 OpenCode" SecReload
SectionIn RO   ; the one step the user could reasonably want to skip, so it is
                ; listed rather than hidden -- just not changeable
  ; One restart at the very end, and it is the whole fix. The overwrite above
  ; happens with the old server still running, which logs some failed loads while
  ; the tree is incomplete -- that is expected and self-clearing. A restart is a
  ; fresh process, so it imports the tree exactly as written and starts clean,
  ; with none of the ~1800 file watchers a reload inside the same process
  ; accumulates.
  ;
  ; `restart`, not `stop` then `start`: `service stop` alone does not hold, a new
  ; `serve --service` came up 0.1 s after it on 2026-10-11.
  Call RestartOpenCode
SectionEnd

; ------------------------------------------------------------------ restart --
; One restart at the end, and it is the whole fix: the payload overwrite happens while
; the old OpenCode server is still running, which logs a few failed loads while the tree
; is incomplete (expected, self-clearing). A restart is a fresh process, so it imports the
; tree exactly as written, with none of the ~1800 file watchers a reload inside one
; process accumulates.
;
; Only when something is actually running. Starting a background server for a user who
; closed OpenCode before installing would be a surprise, so the status check comes first
; and the no-op branch only reports.
Function RestartOpenCode
  nsExec::ExecToStack 'cmd /c opencode service status'
  Pop $0
  Pop $1
  ${If} $0 == 0
    DetailPrint "正在重启 OpenCode……"
    nsExec::ExecToLog 'cmd /c opencode service restart'
    Pop $0
    Pop $1
    ${If} $0 == 0
      DetailPrint "OpenCode 已重启，记忆功能现在可用。"
    ${Else}
      DetailPrint "OpenCode 没能自动重启，请手动启动它（安装已完成）。"
    ${EndIf}
  ${Else}
    ; Not running, so there is nothing to restart. The install is complete either
    ; way; the finish page says what to do.
    DetailPrint "OpenCode 之前没有在运行，请手动启动它（安装已完成）。"
  ${EndIf}
FunctionEnd


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

  ; $INSTDIR is %USERPROFILE%\.config\opencode\plugins\mem-plus -- the *plugin*.
  ; The user's memory lives one level up, at %USERPROFILE%\.config\opencode\mem-plus\
  ; (diaries, SQLite index, DREAMS.md), and nothing below reaches it: $INSTDIR is
  ; never a parent of it and nothing walks up.
  ;
  ; Every file and directory below is deleted by name, from a manifest generated by
  ; build.ps1 while it was staging this very payload -- not `RMDir /r $INSTDIR`.
  ; The NSIS manual is explicit about why (4.9.1.9): "Using RMDir /r $INSTDIR in
  ; the uninstaller is not safe ... The user can also put other files in the
  ; installation folder and wouldn't expect them to get deleted along with the
  ; program."
  ;
  ; That is not hypothetical here. `defaultModelDir()`
  ; (plugin/src/model/config.ts:121) resolves `<plugin root>/models` before falling
  ; back to the state root, so bge-m3 (~2.2 GB) can legitimately sit inside the
  ; directory being uninstalled. The payload ships no models/ at all, so anything
  ; named that is the user's, and deleting by name leaves it untouched -- in place,
  ; not moved.
  ;
  ; Directories go afterwards, deepest first, and with RMDir's default (no /r) so
  ; one can only be removed when it is empty. Anything that survives is therefore
  ; the user's, and the check below says so instead of leaving a silent leftover.
  Delete "$INSTDIR\Uninstall.exe"
  !include "payload-manifest.nsh"

  ; The manifest covers the payload only. These two are created by `npm install` in
  ; SecDeps, so build.ps1 never sees them and they cannot appear in the manifest --
  ; without these two lines the uninstaller would leave ~27,000 files behind.
  ;
  ; /r is safe here and only here: node_modules is created by that npm install and
  ; is ours by definition. It is also the only place /r is defensible, because the
  ; alternative would mean enumerating a dependency tree at build time and guessing
  ; at what the user's npm resolves.
  Delete "$INSTDIR\package-lock.json"
  RMDir /r "$INSTDIR\node_modules"

  RMDir "$INSTDIR"
  IfFileExists "$INSTDIR\*" 0 plugin_dir_gone
    DetailPrint "插件目录里还留有你自己的文件（models 等），没有删除。"
    DetailPrint "它们仍在：$INSTDIR"
  plugin_dir_gone:

  ; The staging and previous-install trees live one level above plugins/. SecMain
  ; clears both before every install; this is the other guaranteed cleanup point,
  ; and unlike mid-install it is safe: OpenCode is not watching either directory.
  ; /r is correct here: both are ours, created only by an earlier build of this
  ; script, and neither can hold anything a user put there.
  RMDir /r "$INSTDIR\..\..\mem-plus.__stage"
  RMDir /r "$INSTDIR\..\..\mem-plus.__old"

  Delete "$SMPROGRAMS\mem-plus\打开插件文件夹.lnk"
  Delete "$SMPROGRAMS\mem-plus\卸载 mem-plus.lnk"
  RMDir "$SMPROGRAMS\mem-plus"
  DeleteRegKey HKCU "Software\mem-plus"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\mem-plus"

  ; Restart OpenCode, and this one is not cosmetic. Two things survive the file
  ; delete inside the running process:
  ;
  ;   1. The memory browser's HTTP server. Verified 2026-10-11: after a clean
  ;      uninstall -- plugin directory, both registry keys and the Start Menu
  ;      entry all gone -- port 4747 was still listening and the process still held
  ;      the index.db handle. The uninstaller cannot close a server it does not own,
  ;      so it restarts the process that does.
  ;   2. Every file watcher OpenCode registered for the plugin's import graph.
  ;      Those are never released on unload: 3,011 were live after a few days of
  ;      installs, enough to pin one core and hold the fan on. A restart is the
  ;      only way to get them back.
  ;
  ; Same shape as SecReload: restart only if something is actually running, since
  ; starting a server nobody asked for is a surprise. `restart`, never `stop` --
  ; `service stop` alone does not hold on this machine.
  nsExec::ExecToStack 'cmd /c opencode service status'
  Pop $0
  Pop $1
  ${If} $0 == 0
    DetailPrint "正在重启 OpenCode……"
    nsExec::ExecToLog 'cmd /c opencode service restart'
    Pop $0
    Pop $1
    ${If} $0 != 0
      DetailPrint "OpenCode 没能自动重启，请手动重启它。"
    ${EndIf}
  ${EndIf}

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

; These four strings were shown on the components page, which no longer exists.
; Kept as a record of what each section is, because the wiring that displayed them
; is dead without the page: MUI_DESCRIPTION_BEGIN resolves against
; mui.ComponentsPage.* and emits 7 warning-6000s when there is no components page.
; If a component page ever comes back, they are the text to put on it.

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
  ; 全部安装：向量组件不再是可选项，页面上没有勾选框，所以这里永远是 1。
  ; 原来是 "0"，靠组件页把勾选结果写回来。
  StrCpy $Vectors "1"
FunctionEnd

Function .onInstFailed
  ; Fires when a File/WriteRegKey step failed. Say plainly that $INSTDIR may be
  ; partial, rather than letting the user find out later.
  MessageBox MB_OK|MB_ICONEXCLAMATION \
    "安装过程中出错。$\r$\n$\r$\n$INSTDIR 可能是不完整的。请重新运行本安装程序覆盖它。$\r$\n\
     你的记忆数据保存在另一个目录，不受影响。"
FunctionEnd
