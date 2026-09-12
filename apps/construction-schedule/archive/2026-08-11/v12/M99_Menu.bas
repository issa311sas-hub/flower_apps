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

'---------------------------------------------------------------------
' 1. 表の上で計算する（工程表には触らない）
'
' M_工程データ に 契約番号 と 基礎開始日 を入れて実行すると、
' 工期の計算 → 終了日の確定 → 業者の割り当て までを行い、
' 結果を M_工程データ に書き込む。
'---------------------------------------------------------------------
Public Sub ボタン_工程を計算する()
    CalculatePlan
End Sub

'---------------------------------------------------------------------
' 2. 工程表に色を塗る（計算はしない）
'
' M_工程データ の 開始日・終了日・色名 をそのまま塗る。
' 日祝の塗りつぶしもこのなかで一緒に行われる。
'---------------------------------------------------------------------
Public Sub ボタン_工程表に色を塗る()
    PaintPlan
End Sub

'---------------------------------------------------------------------
' 計算結果をクリアする
'
' 日程を計算し直したい行を選んで「選択行」の方を実行し、
' 開始日を直してから「工程を作る」を実行する。
'---------------------------------------------------------------------
Public Sub ボタン_選択行の計算結果をクリア()
    ClearPlanResultsForSelection
End Sub

Public Sub ボタン_工程の計算結果をクリア()
    ClearPlanResults
End Sub

'---------------------------------------------------------------------
' 工程表から工程の色だけを消す
'
' M_工程データ の日付は残るので、「工程を作る」で塗り直せる。
'---------------------------------------------------------------------
Public Sub ボタン_工程の色をクリア()
    ClearTaskColors
End Sub

' 日祝の塗りつぶしは単独のボタンにしていない。
' 「工程表に色を塗る」と「初期セットアップ」のなかで一緒に実行される。

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

    msg = msg & vbCrLf & "■ シートの形式" & vbCrLf
    If TermSheetIsCurrent() Then
        msg = msg & "  OK  " & SH_TERM & " : 計算式ベース" & vbCrLf
    Else
        msg = msg & "  NG  " & SH_TERM & " : 古い形式。「ボタン_初期セットアップ」を実行してください" & vbCrLf
        ng = ng + 1
    End If
    If TaskSheetIsCurrent() Then
        msg = msg & "  OK  " & SH_TASK & " : 1物件1行の横並び" & vbCrLf
    Else
        msg = msg & "  NG  " & SH_TASK & " : 古い形式。「ボタン_初期セットアップ」を実行してください" & vbCrLf
        ng = ng + 1
    End If
    If ExceptionSheetIsCurrent() Then
        msg = msg & "  OK  " & SH_EXCEPT & " : 契約番号・日付・詳細の3列" & vbCrLf
    Else
        msg = msg & "  NG  " & SH_EXCEPT & " : 古い形式。「ボタン_初期セットアップ」を実行してください" & vbCrLf
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
