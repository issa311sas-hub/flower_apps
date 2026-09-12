Attribute VB_Name = "M04_Repaint"
Option Explicit

'=====================================================================
' M04_Repaint : 工程データから色を塗り直す
'
' M_工程データ シートの「契約番号・工程・開始日・終了日・色名」を読み、
' 工程表の該当行へ色を塗る。日程がずれたらこのシートの日付だけ直して
' 再実行すれば、工程表全体が塗り直される。
'
' あわせて「同じ色（＝同じ業者）が別物件で同じ日に入っていないか」を
' チェックする。基礎・躯体とも同時に2現場は稼働できないため。
'=====================================================================

' 工程名 -> 描画する行オフセット
Private Function TaskOffsets(taskName As String) As Variant
    Select Case taskName
        Case "躯体":       TaskOffsets = Array(OFS_KUTAI, OFS_KUTAI_SUB)
        Case "コテ":       TaskOffsets = Array(OFS_KOTE)
        Case "基礎":       TaskOffsets = Array(OFS_KISO, OFS_KISO_SUB)
        Case "外構":       TaskOffsets = Array(OFS_KISO, OFS_KISO_SUB)
        Case "契約着工日": TaskOffsets = Array(OFS_KISO, OFS_KISO_SUB)
        Case Else:         TaskOffsets = Array()
    End Select
End Function

'---------------------------------------------------------------------
' メイン : 色を塗り直す
'---------------------------------------------------------------------
Public Sub RepaintTasks()
    Dim ws As Worksheet, wsT As Worksheet
    Dim dateMap As Object, colorMap As Object, blockMap As Object
    Dim r As Long, lastRow As Long
    Dim contract As String, taskName As String, colorName As String
    Dim dFrom As Date, dTo As Date, d As Date
    Dim offs As Variant, i As Long
    Dim blockRow As Long, col As Long
    Dim rgbVal As Long
    Dim painted As Long, warned As String, warnCount As Long

    Set ws = ChartSheet()
    Set wsT = ThisWorkbook.Worksheets(SH_TASK)
    Set dateMap = BuildDateMap(ws)
    Set colorMap = LoadColorMap()
    Set blockMap = LoadBlockMap(ws)

    lastRow = wsT.Cells(wsT.Rows.Count, 1).End(xlUp).Row
    If lastRow < 2 Then
        MsgBox SH_TASK & " に工程データがありません。", vbExclamation
        Exit Sub
    End If

    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual
    On Error GoTo Cleanup

    For r = 2 To lastRow
        contract = Trim$(CStr(wsT.Cells(r, 1).Value))
        taskName = Trim$(CStr(wsT.Cells(r, 3).Value))
        colorName = Trim$(CStr(wsT.Cells(r, 6).Value))

        If Len(contract) = 0 Or Len(taskName) = 0 Then GoTo NextRow
        If Not IsDate(wsT.Cells(r, 4).Value) Then GoTo NextRow

        dFrom = CDate(wsT.Cells(r, 4).Value)
        If IsDate(wsT.Cells(r, 5).Value) Then
            dTo = CDate(wsT.Cells(r, 5).Value)
        Else
            dTo = dFrom
        End If

        If Not blockMap.Exists(contract) Then
            warned = warned & "  契約番号 " & contract & " が工程表に見つかりません（" & r & "行目）" & vbCrLf
            warnCount = warnCount + 1
            GoTo NextRow
        End If
        If Not colorMap.Exists(colorName) Then
            warned = warned & "  色名 「" & colorName & "」 が " & SH_VENDOR & " にありません（" & r & "行目）" & vbCrLf
            warnCount = warnCount + 1
            GoTo NextRow
        End If

        blockRow = blockMap(contract)
        rgbVal = colorMap(colorName)
        offs = TaskOffsets(taskName)
        If UBound(offs) < 0 Then
            warned = warned & "  工程名 「" & taskName & "」 は未対応です（" & r & "行目）" & vbCrLf
            warnCount = warnCount + 1
            GoTo NextRow
        End If

        For d = dFrom To dTo
            If Not IsNonWorkingDay(d) Then
                If dateMap.Exists(CLng(d)) Then
                    col = dateMap(CLng(d))
                    For i = LBound(offs) To UBound(offs)
                        ws.Cells(blockRow + offs(i), col).Interior.Color = rgbVal
                        painted = painted + 1
                    Next i
                End If
            End If
        Next d
NextRow:
    Next r

Cleanup:
    Application.Calculation = xlCalculationAutomatic
    Application.ScreenUpdating = True

    If Err.Number <> 0 Then
        MsgBox "エラーが発生しました: " & Err.Description, vbCritical
        Exit Sub
    End If

    Dim msg As String
    msg = "色の塗り直しが完了しました。" & vbCrLf & "塗ったセル : " & painted
    If warnCount > 0 Then msg = msg & vbCrLf & vbCrLf & "警告:" & vbCrLf & warned
    MsgBox msg, vbInformation, "色塗り直し"
End Sub

'---------------------------------------------------------------------
' 業者の重複稼働チェック
'
' 同じ色（＝同じ業者）が、別々の物件で同じ稼働日に入っていたら報告する。
'---------------------------------------------------------------------
Public Sub CheckVendorConflicts()
    Dim wsT As Worksheet
    Dim r As Long, lastRow As Long
    Dim occupied As Object          ' key: 色名|日付シリアル -> 契約番号
    Dim contract As String, colorName As String, taskName As String
    Dim dFrom As Date, dTo As Date, d As Date
    Dim key As String
    Dim report As String, hits As Long

    Set wsT = ThisWorkbook.Worksheets(SH_TASK)
    Set occupied = CreateObject("Scripting.Dictionary")

    lastRow = wsT.Cells(wsT.Rows.Count, 1).End(xlUp).Row

    For r = 2 To lastRow
        contract = Trim$(CStr(wsT.Cells(r, 1).Value))
        taskName = Trim$(CStr(wsT.Cells(r, 3).Value))
        colorName = Trim$(CStr(wsT.Cells(r, 6).Value))
        If Len(contract) = 0 Or Len(colorName) = 0 Then GoTo NextRow
        If taskName = "契約着工日" Then GoTo NextRow   ' マーカーなので対象外
        If Not IsDate(wsT.Cells(r, 4).Value) Then GoTo NextRow

        dFrom = CDate(wsT.Cells(r, 4).Value)
        If IsDate(wsT.Cells(r, 5).Value) Then dTo = CDate(wsT.Cells(r, 5).Value) Else dTo = dFrom

        For d = dFrom To dTo
            If Not IsNonWorkingDay(d) Then
                key = colorName & "|" & CLng(d)
                If occupied.Exists(key) Then
                    If occupied(key) <> contract Then
                        hits = hits + 1
                        If hits <= 30 Then
                            report = report & "  " & Format$(d, "yyyy/mm/dd") & "  色[" & colorName & "]  " & _
                                     occupied(key) & " と " & contract & vbCrLf
                        End If
                    End If
                Else
                    occupied(key) = contract
                End If
            End If
        Next d
NextRow:
    Next r

    If hits = 0 Then
        MsgBox "同じ業者（色）が同じ日に別物件へ入っている箇所はありませんでした。", _
               vbInformation, "重複チェック"
    Else
        Dim msg As String
        msg = hits & " 件の重複が見つかりました。" & vbCrLf & vbCrLf & report
        If hits > 30 Then msg = msg & "  ... 他 " & (hits - 30) & " 件"
        MsgBox msg, vbExclamation, "重複チェック"
    End If
End Sub

'---------------------------------------------------------------------
' 色名 -> RGB
'---------------------------------------------------------------------
Private Function LoadColorMap() As Object
    Dim ws As Worksheet, map As Object
    Dim r As Long, lastRow As Long, nm As String

    Set map = CreateObject("Scripting.Dictionary")
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(SH_VENDOR)
    On Error GoTo 0
    If ws Is Nothing Then
        Set LoadColorMap = map
        Exit Function
    End If

    lastRow = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    For r = 2 To lastRow
        nm = Trim$(CStr(ws.Cells(r, 1).Value))
        If Len(nm) > 0 And IsNumeric(ws.Cells(r, 2).Value) Then
            map(nm) = RGB(CLng(ws.Cells(r, 2).Value), _
                          CLng(ws.Cells(r, 3).Value), _
                          CLng(ws.Cells(r, 4).Value))
        End If
    Next r
    Set LoadColorMap = map
End Function

'---------------------------------------------------------------------
' 契約番号 -> ブロック開始行
'---------------------------------------------------------------------
Private Function LoadBlockMap(ws As Worksheet) As Object
    Dim map As Object, blocks As Collection, b As Variant
    Set map = CreateObject("Scripting.Dictionary")
    Set blocks = FindBlocks(ws)
    For Each b In blocks
        If Len(Trim$(CStr(b(2)))) > 0 Then
            If Not map.Exists(CStr(b(2))) Then map.Add CStr(b(2)), CLng(b(0))
        End If
    Next b
    Set LoadBlockMap = map
End Function
