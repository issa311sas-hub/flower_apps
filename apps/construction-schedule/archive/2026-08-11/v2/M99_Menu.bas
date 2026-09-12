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

Public Sub ボタン_色を塗り直す()
    RepaintTasks
End Sub

Public Sub ボタン_業者の重複を確認()
    CheckVendorConflicts
End Sub

'--- 補助 -------------------------------------------------------------
Public Sub ボタン_このセルは何()
    WhatIsThisCell
End Sub

Public Sub ボタン_物件を取り込む()
    ImportPropertiesToTaskSheet
End Sub

Public Sub ボタン_祝日を一覧表示()
    DebugListHolidays
End Sub

'--- 保守 -------------------------------------------------------------
Public Sub ボタン_日祝の塗りを全部消す()
    ClearAllHolidayFill
End Sub

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

    msg = "■ 日付エリア" & vbCrLf & _
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
