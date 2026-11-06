; 安装包的自定义步骤（electron-builder 会自动包含 build/installer.nsh）
;
; 文件关联只登记进「打开方式」，不改扩展名的默认打开方式（验收标准 AC-D07，2026-11-06 产品负责人决定）。
; 原因：electron-builder 的 APP_ASSOCIATE 总会把 .md 等扩展名的默认值改成本程序的 ProgID，卸载时却不还原——
; 卸载后默认值指向已删除的 ProgID，双击会弹「选择应用」；原来的默认程序（如 Obsidian）也被顶掉。
; 做法：安装前记下原来的默认值，登记完再写回去；卸载时默认值仍是本程序就删掉。
; 想让本程序双击打开，在 Windows 里选一次「始终使用此应用」（存在 UserChoice，不受这里影响）。
;
; ProgID 要和 package.json 里 fileAssociations[0].name 一致。

!define MDN_PROGID "MarkdownNotes.Document"

!ifndef BUILD_UNINSTALLER
  Var mdnMd
  Var mdnMarkdown
  Var mdnMdown
  Var mdnMkd

  ; 读出扩展名原来的默认值；覆盖安装时旧版本可能已经写成了本程序，当作原来没有
  !macro mdnRead EXT VAR
    ReadRegStr ${VAR} SHELL_CONTEXT "Software\Classes\.${EXT}" ""
    ${If} ${VAR} == "${MDN_PROGID}"
      StrCpy ${VAR} ""
    ${EndIf}
  !macroend

  ; 写回原来的默认值；原来没有就删掉（只留在「打开方式」里）
  !macro mdnRestore EXT VAR
    ${If} ${VAR} == ""
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" ""
    ${Else}
      WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "" ${VAR}
    ${EndIf}
  !macroend

  ; .onInit 里运行，在登记文件关联之前
  !macro customInit
    !insertmacro mdnRead "md" $mdnMd
    !insertmacro mdnRead "markdown" $mdnMarkdown
    !insertmacro mdnRead "mdown" $mdnMdown
    !insertmacro mdnRead "mkd" $mdnMkd
  !macroend

  ; 安装区段的最后运行，在登记文件关联之后
  !macro customInstall
    !insertmacro mdnRestore "md" $mdnMd
    !insertmacro mdnRestore "markdown" $mdnMarkdown
    !insertmacro mdnRestore "mdown" $mdnMdown
    !insertmacro mdnRestore "mkd" $mdnMkd
    System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
  !macroend
!endif

; 卸载：默认值仍是本程序就删掉，避免指向已删除的 ProgID
!macro mdnUnDefault EXT
  ReadRegStr $R0 SHELL_CONTEXT "Software\Classes\.${EXT}" ""
  ${If} $R0 == "${MDN_PROGID}"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" ""
  ${EndIf}
!macroend

!macro customUnInstall
  !insertmacro mdnUnDefault "md"
  !insertmacro mdnUnDefault "markdown"
  !insertmacro mdnUnDefault "mdown"
  !insertmacro mdnUnDefault "mkd"
!macroend
