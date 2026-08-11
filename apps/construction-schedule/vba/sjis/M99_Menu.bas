Attribute VB_Name = "M99_Menu"
Option Explicit

'=====================================================================
' M99_Menu : ボタンから呼び出すエントリポイント
'
' 図形やフォームボタンにマクロを登録するときは、このモジュールの
' Sub を指定する。中身の実装が変わっても登録し直さずに済む。
'=====================================================================

'--- 初回セットアップ -------------------------------------------------
Public Sub ボタン_初期セットアップ()
    SetupMasters
    ImportPropertiesToTaskSheet
End Sub

'--- 日常操作 ---------------------------------------------------------
Public Sub ボタン_日祝を塗る()
    PaintHolidays
End Sub

'---------------------------------------------------------------------
' 基礎工事の工程を作る
'
' M_工程データ に 契約番号・工程「基礎」・開始日 を入れて実行すると、
' 工期の計算 → 終了日の確定 → 業者の割り当て → 色塗り まで行う。
'---------------------------------------------------------------------
Public Sub ボタン_基礎の工程を作る()
    GenerateKisoPlan
End Sub

Public Sub ボタン_基礎の業者割当をクリア()
    ClearKisoVendorAssignment
End Sub

Public Sub ボタン_色を塗り直す()
    RepaintTasks
End Sub

Public Sub ボタン_業者の重複を確認()
    CheckVendorConflicts
End Sub

'--- 補助 -------------------------------------------------------------

'---------------------------------------------------------------------
' いま開いているシートを、色を塗る対象として登録する
'---------------------------------------------------------------------
Public Sub ボタン_このシートを工程表に設定()
    Dim ws As Worksheet, nm As String

    If TypeName(ActiveSheet) <> "Worksheet" Then
        MsgBox "ワークシートを開いた状態で実行してください。", vbExclamation
        Exit Sub
    End If

    nm = ActiveSheet.Name
    If IsMasterSheet(nm) Then
        MsgBox "「" & nm & "」はマクロが使うマスタシートです。" & vbCrLf & _
               "工程表のシートを開いてから実行してください。", vbExclamation
        Exit Sub
    End If

    Set ws = GetOrCreateSheet(SH_SETTING)
    ws.Range("A1").Value = "工程表シート名"
    ws.Range("B1").Value = nm

    MsgBox "工程表シートを「" & nm & "」に設定しました。" & vbCrLf & vbCrLf & _
           "続けて「ボタン_レイアウトを検証」で座標を確認してください。", _
           vbInformation, "工程表シートの設定"
End Sub

Public Sub ボタン_このセルは何()
    WhatIsThisCell
End Sub

Public Sub ボタン_物件を取り込む()
    ImportPropertiesToTaskSheet
End Sub

Public Sub ボタン_祝日を一覧表示()
    DebugListHolidays
End Sub

Public Sub ボタン_工期の計算を確認()
    DebugTermDays
End Sub

'--- 保守 -------------------------------------------------------------
Public Sub ボタン_日祝の塗りを全部消す()
    ClearAllHolidayFill
End Sub

'=====================================================================
' 導入チェック
'
' マスタシートの不足・古い形式を検出する。
' うまく動かないときは、まずこれを実行する。
'
' モジュールの入れ忘れはここでは検出できない。VBA はプロジェクト全体を
' コンパイルするため、1つでも欠けていると実行時に
' 「Sub または Function が定義されていません」で止まる。
' そのエラーが出たら、7モジュールすべてを入れ直すこと。
'=====================================================================
Public Sub ボタン_導入状態を確認()
    Dim msg As String, ng As Long

    msg = "■ マスタシート" & vbCrLf
    msg = msg & CheckSheet(SH_SETTING, ng)
    msg = msg & CheckSheet(SH_VENDOR, ng)
    msg = msg & CheckSheet(SH_EXCEPT, ng)
    msg = msg & CheckSheet(SH_TERM, ng)
    msg = msg & CheckSheet(SH_TASK, ng)

    msg = msg & vbCrLf & "■ " & SH_TERM & " の形式" & vbCrLf
    If TermSheetIsCurrent() Then
        msg = msg & "  OK  計算式ベース（新形式）" & vbCrLf
    Else
        msg = msg & "  NG  古い形式です。「ボタン_初期セットアップ」を実行してください" & vbCrLf
        ng = ng + 1
    End If

    msg = msg & vbCrLf & "■ 工程表シート" & vbCrLf
    If Len(ChartSheetName()) > 0 Then
        msg = msg & "  OK  " & ChartSheetName() & vbCrLf
    Else
        msg = msg & "  NG  未設定。「ボタン_このシートを工程表に設定」を実行してください" & vbCrLf
        ng = ng + 1
    End If

    If ng = 0 Then
        msg = msg & vbCrLf & "すべて揃っています。"
    Else
        msg = msg & vbCrLf & ng & " 件の問題があります。上の NG を解消してください。"
    End If

    MsgBox msg, IIf(ng = 0, vbInformation, vbExclamation), "導入状態の確認"
End Sub

Private Function CheckSheet(nm As String, ByRef ng As Long) As String
    If SheetExists(nm) Then
        CheckSheet = "  OK  " & nm & vbCrLf
    Else
        CheckSheet = "  NG  " & nm & " がありません" & vbCrLf
        ng = ng + 1
    End If
End Function

'=====================================================================
' レイアウト検証
'
' M00_Config の座標定数が、実際のシートと合っているかを確認する。
' 別バージョンの工程表に入れ替えたときは、まずこれを実行する。
'=====================================================================
Public Sub ボタン_レイアウトを検証()
    Dim ws As Worksheet
    Dim colMap As Object, blocks As Collection
    Dim msg As String
    Dim firstDate As Variant, lastDate As Variant
    Dim c As Variant, minC As Long, maxC As Long
    Dim b As Variant, i As Long

    On Error GoTo Fail

    Set ws = ChartSheet()
    Set colMap = BuildColMap(ws)
    Set blocks = FindBlocks(ws)

    minC = 999999: maxC = 0
    For Each c In colMap.Keys
        If CLng(c) < minC Then minC = CLng(c): firstDate = colMap(c)
        If CLng(c) > maxC Then maxC = CLng(c): lastDate = colMap(c)
    Next c

    msg = "■ 対象シート : " & ws.Name & vbCrLf & vbCrLf & _
          "■ 日付エリア" & vbCrLf & _
          "  日付の行     : " & ROW_DATE & " 行目" & vbCrLf & _
          "  日付の列数   : " & colMap.Count & " 列" & vbCrLf & _
          "  先頭         : " & minC & " 列目 = " & firstDate & vbCrLf & _
          "  末尾         : " & maxC & " 列目 = " & lastDate & vbCrLf & vbCrLf & _
          "■ 物件ブロック" & vbCrLf & _
          "  検出件数     : " & blocks.Count & " 件" & vbCrLf & vbCrLf & _
          "  先頭5件:" & vbCrLf

    i = 0
    For Each b In blocks
        i = i + 1
        If i > 5 Then Exit For
        msg = msg & "    " & b(0) & "行目  " & b(1) & "  [" & b(2) & "]  " & b(3) & vbCrLf
    Next b

    msg = msg & vbCrLf & "この内容が実際のシートと合っていれば、座標設定は正しいです。"
    MsgBox msg, vbInformation, "レイアウト検証"
    Exit Sub

Fail:
    MsgBox "レイアウトの検証に失敗しました。" & vbCrLf & vbCrLf & _
           Err.Description & vbCrLf & vbCrLf & _
           "M00_Config の定数を実際のシートに合わせてください。", vbCritical
End Sub
