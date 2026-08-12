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

    SaveSetting CFG_CHART_SHEET, nm

    MsgBox "工程表シートを「" & nm & "」に設定しました。" & vbCrLf & _
           "（設定はブックの中に保存されます。設定用のシートは作りません）" & vbCrLf & vbCrLf & _
           "続けて「ボタン_レイアウトを検証」で座標を確認してください。", _
           vbInformation, "工程表シートの設定"
End Sub

'---------------------------------------------------------------------
' カレンダーの年を設定する
'
' 前年の表を作り替えて使っていると、日付セルの「年」が実際と違うことがある。
' 日付エリアの先頭列の年をここで指定すると、以降は月日だけをシートから読み、
' 年はマクロが振り直す（12月→1月で1年繰り上げ）。
'---------------------------------------------------------------------
Public Sub ボタン_カレンダーの年を設定()
    Dim ans As String, y As Long, ws As Worksheet
    Dim colMap As Object, c As Variant, minC As Long
    Dim shown As String

    On Error Resume Next
    Set ws = ChartSheet()
    On Error GoTo 0

    If Not ws Is Nothing Then
        Set colMap = BuildColMap(ws)
        minC = 999999
        For Each c In colMap.Keys
            If CLng(c) < minC Then minC = CLng(c)
        Next c
        If colMap.Count > 0 Then
            shown = "いま先頭列は " & Format$(colMap(minC), "yyyy/mm/dd") & " と読めています。" & vbCrLf & vbCrLf
        End If
    End If

    ans = InputBox(shown & _
                   "日付エリアの先頭列は何年ですか。" & vbCrLf & _
                   "（0 を入れると補正をやめ、シートの値をそのまま使います）", _
                   "カレンダーの年", CStr(Year(Date)))
    If Len(Trim$(ans)) = 0 Then Exit Sub
    If Not IsNumeric(ans) Then
        MsgBox "年を数値で入力してください。", vbExclamation
        Exit Sub
    End If

    y = CLng(ans)
    If y = 0 Then
        SaveSetting CFG_BASE_YEAR, ""
        MsgBox "年の補正をやめました。シートに入っている日付をそのまま使います。", _
               vbInformation, "カレンダーの年"
        Exit Sub
    End If

    If y < 1980 Or y > 2099 Then
        MsgBox "1980～2099 の範囲で入力してください。", vbExclamation
        Exit Sub
    End If

    SaveSetting CFG_BASE_YEAR, CStr(y)
    MsgBox "先頭列を " & y & " 年として扱います。" & vbCrLf & _
           "月が戻ったところ（12月→1月）で年を1つ繰り上げます。" & vbCrLf & vbCrLf & _
           "「ボタン_レイアウトを検証」で日付を確認してください。", _
           vbInformation, "カレンダーの年"
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
    msg = msg & CheckSheet(SH_VENDOR, ng)
    msg = msg & CheckSheet(SH_EXCEPT, ng)
    msg = msg & CheckSheet(SH_TASK, ng)
    If SheetExists(SH_SETTING) Or SheetExists(SH_TERM) Then
        msg = msg & "  ―   " & SH_SETTING & " / " & SH_TERM & " は使いません。" & _
              "「ボタン_初期セットアップ」で削除されます" & vbCrLf
    End If

    msg = msg & vbCrLf & "■ シートの形式" & vbCrLf
    If VendorSheetIsCurrent() Then
        msg = msg & "  OK  " & SH_VENDOR & " : 現行の色設定" & vbCrLf
    Else
        msg = msg & "  NG  " & SH_VENDOR & " : 古い色設定。「ボタン_初期セットアップ」を実行してください" & vbCrLf
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

    msg = msg & vbCrLf & "■ カレンダーの年" & vbCrLf
    If CalendarBaseYear() > 0 Then
        msg = msg & "  OK  先頭列を " & CalendarBaseYear() & " 年として扱う" & vbCrLf
    Else
        msg = msg & "  ―   シートに入っている年をそのまま使う" & vbCrLf & _
              "      年がずれているときは「ボタン_カレンダーの年を設定」" & vbCrLf
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
          "  先頭         : " & minC & " 列目 = " & Format$(firstDate, "yyyy/mm/dd") & vbCrLf & _
          "  末尾         : " & maxC & " 列目 = " & Format$(lastDate, "yyyy/mm/dd") & vbCrLf & _
          "  年の扱い     : " & IIf(CalendarBaseYear() > 0, _
                                    CalendarBaseYear() & " 年から振り直し", _
                                    "シートの値をそのまま使用") & vbCrLf & _
          "  シートの生値 : " & CStr(ws.Cells(ROW_DATE, minC).Value) & vbCrLf & vbCrLf & _
          "■ 物件ブロック" & vbCrLf & _
          "  検出件数     : " & blocks.Count & " 件" & vbCrLf & vbCrLf & _
          "  先頭5件:" & vbCrLf

    i = 0
    For Each b In blocks
        i = i + 1
        If i > 5 Then Exit For
        msg = msg & "    " & b(0) & "行目  " & b(1) & "  [" & b(2) & "]  " & b(3) & vbCrLf & _
              "      基礎業者 " & IIf(Len(Trim$(CStr(b(4)))) > 0, b(4), "（空）") & _
              " / 躯体業者 " & IIf(Len(Trim$(CStr(b(5)))) > 0, b(5), "（空）") & vbCrLf & _
              "      本着日 " & IIf(IsDate(b(6)), Format$(b(6), "yyyy/mm/dd"), "（空）") & _
              " / 納期 " & IIf(IsDate(b(7)), Format$(b(7), "yyyy/mm/dd"), "（空）") & vbCrLf
    Next b

    msg = msg & vbCrLf & "この内容が実際のシートと合っていれば、座標設定は正しいです。" & vbCrLf & _
          "業者名や本着日がずれている場合は M00_Config の列番号を直してください。" & vbCrLf & _
          "年だけ違う場合は「ボタン_カレンダーの年を設定」で直せます。"
    MsgBox msg, vbInformation, "レイアウト検証"
    Exit Sub

Fail:
    MsgBox "レイアウトの検証に失敗しました。" & vbCrLf & vbCrLf & _
           Err.Description & vbCrLf & vbCrLf & _
           "M00_Config の定数を実際のシートに合わせてください。", vbCritical
End Sub
