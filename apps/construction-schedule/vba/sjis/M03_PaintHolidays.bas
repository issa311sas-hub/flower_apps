Attribute VB_Name = "M03_PaintHolidays"
Option Explicit

'=====================================================================
' M03_PaintHolidays : 日曜・祝日の自動塗りつぶし
'
' ・日曜と祝日を黄緑 RGB(153,204,0) で塗る
' ・物件ごとの例外を M_例外日 シートで受け付ける
'     非祝日扱い … その物件だけ稼働日として扱う（塗らない）
'     臨時休工   … その物件だけ平日でも休みとして塗る
' ・すでに工程色が入っているセルは塗りつぶさず、報告だけする
'   （実データに、日曜へ社内行事の色を載せている例があるため）
'
' 何度実行しても同じ結果になる（冪等）。
'=====================================================================

'---------------------------------------------------------------------
' メイン : 日祝を塗り直す
'---------------------------------------------------------------------
Public Sub PaintHolidays()
    Dim ws As Worksheet
    Dim colMap As Object, exMap As Object
    Dim blocks As Collection, b As Variant
    Dim c As Variant, d As Date
    Dim r As Long, off As Long
    Dim baseOff As Boolean, eff As Boolean
    Dim key As String, kind As String
    Dim painted As Long, cleared As Long, skipped As Long
    Dim skipList As String, skipCount As Long
    Dim cell As Range

    Set ws = ChartSheet()
    Set colMap = BuildColMap(ws)
    Set blocks = FindBlocks(ws)
    Set exMap = LoadExceptions()

    If blocks.Count = 0 Then
        MsgBox "物件ブロックが見つかりませんでした。" & vbCrLf & _
               "M00_Config の ROW_BLOCK_1ST / COL_NAME を確認してください。", vbExclamation
        Exit Sub
    End If

    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual

    On Error GoTo Cleanup

    For Each c In colMap.Keys
        d = colMap(c)
        baseOff = IsNonWorkingDay(d)

        For Each b In blocks
            key = BlockKey(b) & "|" & CLng(d)
            kind = ""
            If exMap.Exists(key) Then kind = exMap(key)

            eff = baseOff
            If kind = "非祝日扱い" Then eff = False
            If kind = "臨時休工" Then eff = True

            For off = 0 To BLOCK_ROWS - 1
                r = CLng(b(0)) + off
                Set cell = ws.Cells(r, CLng(c))

                If eff Then
                    If cell.Interior.Pattern = xlNone Then
                        cell.Interior.Color = CLR_HOLIDAY
                        painted = painted + 1
                    ElseIf cell.Interior.Color = CLR_HOLIDAY Then
                        ' 既に塗られている。何もしない
                    Else
                        ' 工程色が入っている。上書きせず報告に回す
                        skipped = skipped + 1
                        If skipCount < 20 Then
                            skipList = skipList & "  " & b(1) & " / " & _
                                       Format$(d, "yyyy/mm/dd") & " / " & cell.Address(False, False) & vbCrLf
                            skipCount = skipCount + 1
                        End If
                    End If
                Else
                    If cell.Interior.Pattern <> xlNone Then
                        If cell.Interior.Color = CLR_HOLIDAY Then
                            cell.Interior.Pattern = xlNone
                            cleared = cleared + 1
                        End If
                    End If
                End If
            Next off
        Next b
    Next c

    PaintHeaderHolidays ws, colMap

Cleanup:
    Application.Calculation = xlCalculationAutomatic
    Application.ScreenUpdating = True

    If Err.Number <> 0 Then
        MsgBox "エラーが発生しました: " & Err.Description, vbCritical
        Exit Sub
    End If

    Dim msg As String
    msg = "日曜・祝日の塗りつぶしが完了しました。" & vbCrLf & vbCrLf & _
          "対象シート : " & ws.Name & vbCrLf & _
          "物件       : " & blocks.Count & " 件" & vbCrLf & vbCrLf & _
          "塗った   : " & painted & " セル" & vbCrLf & _
          "消した   : " & cleared & " セル" & vbCrLf & _
          "見送った : " & skipped & " セル（工程色が入っていたため）"
    If skipped > 0 Then
        msg = msg & vbCrLf & vbCrLf & "見送った箇所（先頭20件）:" & vbCrLf & skipList
        If skipped > skipCount Then msg = msg & "  ... 他 " & (skipped - skipCount) & " 件"
    End If
    MsgBox msg, vbInformation, "日祝の塗りつぶし"
End Sub

'---------------------------------------------------------------------
' 日付ヘッダ行の日祝も塗る（物件ごとの例外は適用しない）
'---------------------------------------------------------------------
Private Sub PaintHeaderHolidays(ws As Worksheet, colMap As Object)
    Dim c As Variant, d As Date, r As Long
    For Each c In colMap.Keys
        d = colMap(c)
        For r = ROW_DATE To ROW_DATE + 1
            With ws.Cells(r, CLng(c)).Interior
                If IsNonWorkingDay(d) Then
                    If .Pattern = xlNone Then .Color = CLR_HOLIDAY
                Else
                    If .Pattern <> xlNone Then
                        If .Color = CLR_HOLIDAY Then .Pattern = xlNone
                    End If
                End If
            End With
        Next r
    Next c
End Sub

'---------------------------------------------------------------------
' M_例外日 を読み込む
' キー: 契約番号 & "|" & 日付シリアル   値: 区分
'---------------------------------------------------------------------
Private Function LoadExceptions() As Object
    Dim ws As Worksheet, map As Object
    Dim r As Long, lastRow As Long
    Dim contract As String, kind As String
    Dim v As Variant

    Set map = CreateObject("Scripting.Dictionary")

    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(SH_EXCEPT)
    On Error GoTo 0
    If ws Is Nothing Then
        Set LoadExceptions = map
        Exit Function
    End If

    lastRow = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    For r = 2 To lastRow
        contract = Trim$(CStr(ws.Cells(r, 1).Value))
        v = ws.Cells(r, 2).Value
        kind = Trim$(CStr(ws.Cells(r, 3).Value))
        If Len(contract) > 0 And IsDate(v) And Len(kind) > 0 Then
            map(contract & "|" & CLng(CDate(v))) = kind
        End If
    Next r

    Set LoadExceptions = map
End Function

'---------------------------------------------------------------------
' ブロックのキー。契約番号を優先し、無ければ邸名を使う。
'---------------------------------------------------------------------
Private Function BlockKey(b As Variant) As String
    If Len(Trim$(CStr(b(2)))) > 0 Then
        BlockKey = Trim$(CStr(b(2)))
    Else
        BlockKey = Trim$(CStr(b(1)))
    End If
End Function

'---------------------------------------------------------------------
' 保守用 : 日祝の塗りを全部消す
'---------------------------------------------------------------------
Public Sub ClearAllHolidayFill()
    Dim ws As Worksheet, colMap As Object, blocks As Collection
    Dim c As Variant, b As Variant, off As Long, r As Long
    Dim cleared As Long

    If MsgBox("工程表から日祝の黄緑をすべて消します。よろしいですか？", _
              vbYesNo + vbQuestion) <> vbYes Then Exit Sub

    Set ws = ChartSheet()
    Set colMap = BuildColMap(ws)
    Set blocks = FindBlocks(ws)

    Application.ScreenUpdating = False
    For Each c In colMap.Keys
        For Each b In blocks
            For off = 0 To BLOCK_ROWS - 1
                r = CLng(b(0)) + off
                With ws.Cells(r, CLng(c)).Interior
                    If .Pattern <> xlNone Then
                        If .Color = CLR_HOLIDAY Then
                            .Pattern = xlNone
                            cleared = cleared + 1
                        End If
                    End If
                End With
            Next off
        Next b
    Next c
    Application.ScreenUpdating = True

    MsgBox cleared & " セルの塗りを消しました。", vbInformation
End Sub

'---------------------------------------------------------------------
' 選択セルの日付と物件を表示する（例外日を登録するときの確認用）
'---------------------------------------------------------------------
Public Sub WhatIsThisCell()
    Dim ws As Worksheet, colMap As Object, blocks As Collection
    Dim b As Variant, r As Long, c As Long
    Dim nm As String, contract As String, ofsName As String
    Dim d As Variant

    Set ws = ChartSheet()
    If ActiveSheet.Name <> ws.Name Then
        MsgBox "工程表シート上でセルを選択してから実行してください。", vbExclamation
        Exit Sub
    End If

    r = Selection.Row: c = Selection.Column
    Set colMap = BuildColMap(ws)
    Set blocks = FindBlocks(ws)

    If colMap.Exists(c) Then d = colMap(c) Else d = "（日付エリア外）"

    For Each b In blocks
        If r >= CLng(b(0)) And r < CLng(b(0)) + BLOCK_ROWS Then
            nm = CStr(b(1)): contract = CStr(b(2))
            Select Case r - CLng(b(0))
                Case OFS_KUTAI:     ofsName = "躯体（色帯）"
                Case OFS_KUTAI_SUB: ofsName = "躯体（補助）"
                Case OFS_NOTE:      ofsName = "補助メモ"
                Case OFS_MORTAR:    ofsName = "モルタル（黒帯）"
                Case OFS_KISO:      ofsName = "基礎（色帯）／外構"
                Case OFS_KISO_SUB:  ofsName = "基礎（補助）／契約着工日"
            End Select
            Exit For
        End If
    Next b

    Dim reason As String
    If IsDate(d) Then
        reason = NonWorkingReason(CDate(d))
        If Len(reason) = 0 Then reason = "稼働日"
    End If

    MsgBox "セル : " & Selection.Address(False, False) & vbCrLf & _
           "日付 : " & d & "  (" & reason & ")" & vbCrLf & _
           "物件 : " & nm & vbCrLf & _
           "契約番号 : " & contract & vbCrLf & _
           "行の意味 : " & ofsName, vbInformation, "セル情報"
End Sub
