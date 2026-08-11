Attribute VB_Name = "M05_Plan"
Option Explicit

'=====================================================================
' M05_Plan : 工程を自動で作って工程表に色を塗る
'
' クリティカル工程 7 段階のうち、いまは 1 基礎 と 2 躯体 まで。
'   1 基礎工事 ← 実装済み
'   2 躯体工事 ← 実装済み
'   3 モルタル / 4 防水 / 5 断熱 / 6 木工事 / 7 仕上げ … 順次追加
'
' やること:
'   1. M_工程データ（1物件1行）から開始日を読む
'   2. 工程表のタイプ（例 C2E42）から坪数と建物種類を取り出す
'   3. M_工期 の式で稼働日数を計算し、終了日を確定する
'   4. 同じ業者が同じ日に2現場へ入らないように業者を割り当てる
'   5. 工程表に色を塗る
'
' 躯体の開始日が空欄なら、基礎の終了日から自動で決める。
' 終了日を手で入れておけば、その日付が優先される（計算で上書きしない）。
'
' 何度実行しても同じ結果になる（冪等）。
'=====================================================================

' 工程の数。増やすときは下の Task〇〇 関数にも Case を足す。
Private Const TASK_COUNT As Long = 2

'---------------------------------------------------------------------
' 工程の定義
'---------------------------------------------------------------------
Private Function TaskName(k As Long) As String
    Select Case k
        Case 1: TaskName = "基礎"
        Case 2: TaskName = "躯体"
    End Select
End Function

' 色帯を塗る行オフセット。工程ごとに違う（実測で確認済み）。
Private Function TaskRowOffsets(k As Long) As Variant
    Select Case k
        Case 1: TaskRowOffsets = Array(OFS_KISO, OFS_KISO_SUB)   ' 基礎は2行
        Case 2: TaskRowOffsets = Array(OFS_KUTAI)                ' 躯体は1行だけ
    End Select
End Function

' 前の工程からのインターバル（暦日）。1番目の工程は使わない。
Private Function TaskInterval(k As Long) As Long
    Select Case k
        Case 2: TaskInterval = TermInterval("基礎完了→躯体着手", 4)
        Case Else: TaskInterval = 0
    End Select
End Function

' M_工程データ でこの工程が使う先頭列（開始日の列）
Private Function TaskFirstCol(k As Long) As Long
    TaskFirstCol = TASK_COL_FIRST + (k - 1) * TASK_COL_WIDTH
End Function

'=====================================================================
' メイン
'=====================================================================
Public Sub GeneratePlan()
    Dim ws As Worksheet, wsT As Worksheet
    Dim dateMap As Object, colorMap As Object
    Dim blockRow As Object, blockType As Object, blockName As Object
    Dim occupied As Object, prevEnd As Object, result As Object
    Dim k As Long, painted As Long
    Dim warned As String, warnCount As Long
    Dim unassigned As String, unassignedCount As Long
    Dim derived As Long, outOfRange As Long

    If Not PreflightOK() Then Exit Sub

    Set ws = ChartSheet()
    Set wsT = ThisWorkbook.Worksheets(SH_TASK)
    Set dateMap = BuildDateMap(ws)
    Set colorMap = LoadColorMap()
    LoadBlocks ws, blockRow, blockType, blockName

    Set occupied = CreateObject("Scripting.Dictionary")
    Set prevEnd = CreateObject("Scripting.Dictionary")
    Set result = CreateObject("Scripting.Dictionary")

    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual
    On Error GoTo Cleanup

    ' 工程は順番に処理する。躯体は基礎の結果（終了日）を使うため。
    For k = 1 To TASK_COUNT
        PlanOneTask k, ws, wsT, dateMap, colorMap, _
                    blockRow, blockType, blockName, _
                    occupied, prevEnd, result, _
                    painted, warned, warnCount, _
                    unassigned, unassignedCount, derived, outOfRange
    Next k

Cleanup:
    Application.Calculation = xlCalculationAutomatic
    Application.ScreenUpdating = True

    If Err.Number <> 0 Then
        MsgBox "エラーが発生しました: " & Err.Description, vbCritical
        Exit Sub
    End If

    ShowReport ws, result, blockName, painted, derived, outOfRange, _
               unassigned, unassignedCount, warned, warnCount
End Sub

'---------------------------------------------------------------------
' 工程を1つ処理する
'---------------------------------------------------------------------
Private Sub PlanOneTask(k As Long, ws As Worksheet, wsT As Worksheet, _
                        dateMap As Object, colorMap As Object, _
                        blockRow As Object, blockType As Object, blockName As Object, _
                        occupied As Object, prevEnd As Object, result As Object, _
                        ByRef painted As Long, ByRef warned As String, ByRef warnCount As Long, _
                        ByRef unassigned As String, ByRef unassignedCount As Long, _
                        ByRef derived As Long, ByRef outOfRange As Long)

    Dim vendors As Object
    Dim plan() As Variant, n As Long, cap As Long
    Dim r As Long, lastRow As Long, c0 As Long
    Dim contract As String, typeCode As String, colorName As String
    Dim dStart As Date, dEnd As Date
    Dim days As Long, i As Long
    Dim kind As String, floors As Long, area As Long
    Dim taskLabel As String

    taskLabel = TaskName(k)
    c0 = TaskFirstCol(k)
    Set vendors = LoadVendorsByKind(taskLabel)

    If vendors.Count = 0 Then
        warned = warned & "  " & SH_VENDOR & " に工種「" & taskLabel & "」の色がありません" & vbCrLf
        warnCount = warnCount + 1
        Exit Sub
    End If

    lastRow = wsT.Cells(wsT.Rows.Count, TASK_COL_CONTRACT).End(xlUp).Row
    cap = lastRow
    If cap < 2 Then cap = 2
    ReDim plan(1 To cap, 1 To 7)
    n = 0

    '--- 1) 行を集める ------------------------------------------------
    For r = 2 To lastRow
        contract = Trim$(CStr(wsT.Cells(r, TASK_COL_CONTRACT).Value))
        If Len(contract) = 0 Then GoTo NextRow
        If Not blockRow.Exists(contract) Then
            If k = 1 Then
                warned = warned & "  " & contract & " : 工程表に見つかりません（" & r & "行目）" & vbCrLf
                warnCount = warnCount + 1
            End If
            GoTo NextRow
        End If

        ' 開始日。空欄なら前工程の終了日から決める（1番目の工程は決められない）
        If IsDate(wsT.Cells(r, c0).Value) Then
            dStart = AddWorkingDays(CDate(wsT.Cells(r, c0).Value), 0)
        ElseIf k > 1 Then
            If Not prevEnd.Exists(contract) Then GoTo NextRow
            dStart = AddWorkingDays(CDate(prevEnd(contract)) + TaskInterval(k), 0)
            wsT.Cells(r, c0).Value = dStart
            derived = derived + 1
        Else
            GoTo NextRow      ' 基礎の開始日が空なら、その物件はまだ計画対象外
        End If

        typeCode = blockType(contract)

        ' 終了日。手入力があればそれを尊重し、無ければ工期から計算する
        If IsDate(wsT.Cells(r, c0 + 1).Value) And _
           CDate(wsT.Cells(r, c0 + 1).Value) >= dStart Then
            dEnd = CDate(wsT.Cells(r, c0 + 1).Value)
        Else
            days = TermDays(taskLabel, typeCode)
            If days <= 0 Then
                warned = warned & "  " & contract & " : タイプ「" & typeCode & _
                         "」から" & taskLabel & "の工期を計算できません" & vbCrLf
                warnCount = warnCount + 1
                GoTo NextRow
            End If
            dEnd = AddWorkingDays(dStart, days - 1)
        End If

        ' 実測範囲（25～90坪）を外れていたら印を付ける
        If ParseType(typeCode, kind, floors, area) Then
            If area < 25 Or area > 90 Then outOfRange = outOfRange + 1
        End If

        n = n + 1
        plan(n, 1) = r
        plan(n, 2) = contract
        plan(n, 3) = typeCode
        plan(n, 4) = dStart
        plan(n, 5) = dEnd
        plan(n, 6) = Trim$(CStr(wsT.Cells(r, c0 + 2).Value))   ' 手入力の色名
        plan(n, 7) = blockRow(contract)
NextRow:
    Next r

    If n = 0 Then Exit Sub

    '--- 2) 開始日の早い順に並べる ------------------------------------
    SortPlanByStart plan, n

    '--- 3) 業者を割り当てる ------------------------------------------
    ' 手入力で固定されている色を先に押さえる
    For i = 1 To n
        colorName = CStr(plan(i, 6))
        If Len(colorName) > 0 Then
            If vendors.Exists(colorName) Then
                MarkOccupied occupied, colorName, CDate(plan(i, 4)), CDate(plan(i, 5))
            Else
                warned = warned & "  " & plan(i, 2) & " : 色名「" & colorName & _
                         "」は" & taskLabel & "の業者ではありません" & vbCrLf
                warnCount = warnCount + 1
                plan(i, 6) = ""
            End If
        End If
    Next i

    ' 空欄に、空いている業者を順に割り当てる
    For i = 1 To n
        If Len(CStr(plan(i, 6))) = 0 Then
            colorName = FindFreeVendor(vendors, occupied, CDate(plan(i, 4)), CDate(plan(i, 5)))
            If Len(colorName) = 0 Then
                unassigned = unassigned & "  [" & taskLabel & "] " & _
                             blockName(CStr(plan(i, 2))) & "  " & _
                             Format$(plan(i, 4), "mm/dd") & "～" & Format$(plan(i, 5), "mm/dd") & vbCrLf
                unassignedCount = unassignedCount + 1
            Else
                plan(i, 6) = colorName
                MarkOccupied occupied, colorName, CDate(plan(i, 4)), CDate(plan(i, 5))
            End If
        End If
    Next i

    '--- 4) 書き戻して色を塗る ----------------------------------------
    For i = 1 To n
        r = CLng(plan(i, 1))
        wsT.Cells(r, c0 + 1).Value = CDate(plan(i, 5))     ' 終了日
        wsT.Cells(r, c0 + 2).Value = CStr(plan(i, 6))      ' 色名

        ClearTaskPaint ws, CLng(plan(i, 7)), dateMap, vendors, colorMap, TaskRowOffsets(k)
        If Len(CStr(plan(i, 6))) > 0 Then
            painted = painted + PaintTask(ws, CLng(plan(i, 7)), dateMap, _
                                          CDate(plan(i, 4)), CDate(plan(i, 5)), _
                                          CLng(colorMap(CStr(plan(i, 6)))), TaskRowOffsets(k))
        End If

        ' 次の工程が参照できるよう結果を残す
        prevEnd(CStr(plan(i, 2))) = CDate(plan(i, 5))
        result(CStr(plan(i, 2)) & "|" & k) = Array(plan(i, 3), plan(i, 4), plan(i, 5), plan(i, 6))
    Next i
End Sub

'=====================================================================
' 前提のチェック
'=====================================================================
Private Function PreflightOK() As Boolean
    If Not SheetExists(SH_TASK) Then
        MsgBox SH_TASK & " シートがありません。" & vbCrLf & _
               "「ボタン_初期セットアップ」を実行してください。", vbExclamation
        Exit Function
    End If
    If Not TaskSheetIsCurrent() Then
        MsgBox SH_TASK & " シートが古い形式です。" & vbCrLf & vbCrLf & _
               "「ボタン_初期セットアップ」を実行してください。" & vbCrLf & _
               "古いシートは " & SH_TASK & "_旧1 という名前で残ります。", _
               vbExclamation, "工程を作る"
        Exit Function
    End If
    If Not TermSheetIsCurrent() Then
        MsgBox SH_TERM & " シートが古い形式です。" & vbCrLf & vbCrLf & _
               "「ボタン_初期セットアップ」を実行してください。", _
               vbExclamation, "工程を作る"
        Exit Function
    End If
    PreflightOK = True
End Function

'=====================================================================
' 結果表示
'=====================================================================
Private Sub ShowReport(ws As Worksheet, result As Object, blockName As Object, _
                       painted As Long, derived As Long, outOfRange As Long, _
                       unassigned As String, unassignedCount As Long, _
                       warned As String, warnCount As Long)
    Dim msg As String, key As Variant, seen As Object
    Dim contract As String, shown As Long, total As Long
    Dim k As Long, v As Variant, line As String

    Set seen = CreateObject("Scripting.Dictionary")
    For Each key In result.Keys
        contract = Split(CStr(key), "|")(0)
        If Not seen.Exists(contract) Then seen.Add contract, True
    Next key
    total = seen.Count

    msg = "工程を作成しました。" & vbCrLf & vbCrLf & _
          "対象シート : " & ws.Name & vbCrLf & _
          "物件       : " & total & " 件" & vbCrLf & _
          "塗ったセル : " & painted & vbCrLf
    If derived > 0 Then msg = msg & "躯体開始日を自動で決めた物件 : " & derived & " 件" & vbCrLf

    msg = msg & vbCrLf & "邸名 / タイプ / 基礎 / 躯体" & vbCrLf

    For Each key In seen.Keys
        shown = shown + 1
        If shown > 12 Then
            msg = msg & "  ... 他 " & (total - 12) & " 件" & vbCrLf
            Exit For
        End If
        contract = CStr(key)
        line = "  " & Left$(blockName(contract) & String$(11, " "), 11)
        For k = 1 To TASK_COUNT
            If result.Exists(contract & "|" & k) Then
                v = result(contract & "|" & k)
                If k = 1 Then line = line & " " & Left$(CStr(v(0)) & String$(7, " "), 7)
                line = line & "  " & Format$(v(1), "mm/dd") & "～" & Format$(v(2), "mm/dd") & _
                       " " & IIf(Len(CStr(v(3))) > 0, CStr(v(3)), "未割当")
            Else
                line = line & "  （なし）"
            End If
        Next k
        msg = msg & line & vbCrLf
    Next key

    If outOfRange > 0 Then
        msg = msg & vbCrLf & "※実測範囲外が " & outOfRange & " 件あります。" & vbCrLf & _
              "　工期の式は 25～90坪 の実績から作っています。外れる物件の日数は目安です。" & vbCrLf
    End If
    If unassignedCount > 0 Then
        msg = msg & vbCrLf & "■ 業者が足りず割り当てられなかった工程 (" & unassignedCount & "件):" & vbCrLf & _
              unassigned & "　" & SH_VENDOR & " に業者を追加するか、開始日をずらしてください。" & vbCrLf
    End If
    If warnCount > 0 Then
        msg = msg & vbCrLf & "■ 警告:" & vbCrLf & warned
    End If

    MsgBox msg, IIf(unassignedCount > 0 Or warnCount > 0, vbExclamation, vbInformation), _
           "工程を作る"
End Sub

'=====================================================================
' 塗る / 消す
'=====================================================================
Private Function PaintTask(ws As Worksheet, blockRow As Long, dateMap As Object, _
                           dFrom As Date, dTo As Date, rgbVal As Long, _
                           offsets As Variant) As Long
    Dim d As Date, col As Long, cnt As Long, off As Variant
    For d = dFrom To dTo
        If Not IsNonWorkingDay(d) Then
            If dateMap.Exists(CLng(d)) Then
                col = dateMap(CLng(d))
                For Each off In offsets
                    ws.Cells(blockRow + CLng(off), col).Interior.Color = rgbVal
                    cnt = cnt + 1
                Next off
            End If
        End If
    Next d
    PaintTask = cnt
End Function

'---------------------------------------------------------------------
' その物件・その工程の色だけを消す
'
' 基礎の行は後半で外構も使うため、行ごと消してはいけない。
' その工程の業者色に一致するセルだけを対象にする。
'---------------------------------------------------------------------
Private Sub ClearTaskPaint(ws As Worksheet, blockRow As Long, dateMap As Object, _
                           vendors As Object, colorMap As Object, offsets As Variant)
    Dim rgbSet As Object, k As Variant, c As Variant, off As Variant
    Dim cell As Range

    Set rgbSet = CreateObject("Scripting.Dictionary")
    For Each k In vendors.Keys
        If colorMap.Exists(k) Then rgbSet(CLng(colorMap(k))) = True
    Next k
    If rgbSet.Count = 0 Then Exit Sub

    For Each c In dateMap.Items
        For Each off In offsets
            Set cell = ws.Cells(blockRow + CLng(off), CLng(c))
            If cell.Interior.Pattern <> xlNone Then
                If rgbSet.Exists(CLng(cell.Interior.Color)) Then cell.Interior.Pattern = xlNone
            End If
        Next off
    Next c
End Sub

'=====================================================================
' 業者の割り当て
'=====================================================================
Private Function FindFreeVendor(vendors As Object, occupied As Object, _
                                dFrom As Date, dTo As Date) As String
    Dim k As Variant, d As Date, busy As Boolean

    For Each k In vendors.Keys
        busy = False
        For d = dFrom To dTo
            If Not IsNonWorkingDay(d) Then
                If occupied.Exists(k & "|" & CLng(d)) Then
                    busy = True
                    Exit For
                End If
            End If
        Next d
        If Not busy Then
            FindFreeVendor = CStr(k)
            Exit Function
        End If
    Next k
End Function

Private Sub MarkOccupied(occupied As Object, colorName As String, _
                         dFrom As Date, dTo As Date)
    Dim d As Date
    For d = dFrom To dTo
        If Not IsNonWorkingDay(d) Then occupied(colorName & "|" & CLng(d)) = True
    Next d
End Sub

'=====================================================================
' 並べ替え（単純挿入ソート。件数が少ないので十分）
'=====================================================================
Private Sub SortPlanByStart(plan() As Variant, n As Long)
    Dim i As Long, j As Long, c As Long
    Dim tmp(1 To 7) As Variant

    For i = 2 To n
        For c = 1 To 7
            tmp(c) = plan(i, c)
        Next c
        j = i - 1
        Do While j >= 1
            If CDate(plan(j, 4)) <= CDate(tmp(4)) Then Exit Do
            For c = 1 To 7
                plan(j + 1, c) = plan(j, c)
            Next c
            j = j - 1
        Loop
        For c = 1 To 7
            plan(j + 1, c) = tmp(c)
        Next c
    Next i
End Sub

'=====================================================================
' マスタの読み込み
'=====================================================================
Private Sub LoadBlocks(ws As Worksheet, ByRef rowMap As Object, _
                       ByRef typeMap As Object, ByRef nameMap As Object)
    Dim blocks As Collection, b As Variant, key As String

    Set rowMap = CreateObject("Scripting.Dictionary")
    Set typeMap = CreateObject("Scripting.Dictionary")
    Set nameMap = CreateObject("Scripting.Dictionary")
    Set blocks = FindBlocks(ws)

    For Each b In blocks
        key = Trim$(CStr(b(2)))
        If Len(key) > 0 Then
            If Not rowMap.Exists(key) Then
                rowMap.Add key, CLng(b(0))
                typeMap.Add key, Trim$(CStr(b(3)))
                nameMap.Add key, Trim$(CStr(b(1)))
            End If
        End If
    Next b
End Sub

' M_業者 のうち、工種が一致する色
Private Function LoadVendorsByKind(kindName As String) As Object
    Dim ws As Worksheet, map As Object
    Dim r As Long, lastRow As Long, nm As String

    Set map = CreateObject("Scripting.Dictionary")
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(SH_VENDOR)
    On Error GoTo 0
    If ws Is Nothing Then
        Set LoadVendorsByKind = map
        Exit Function
    End If

    lastRow = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    For r = 2 To lastRow
        nm = Trim$(CStr(ws.Cells(r, 1).Value))
        If Len(nm) > 0 And Trim$(CStr(ws.Cells(r, 5).Value)) = kindName Then
            map(nm) = Trim$(CStr(ws.Cells(r, 6).Value))
        End If
    Next r

    Set LoadVendorsByKind = map
End Function

' 色名 -> RGB
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

'=====================================================================
' 業者の重複チェック
'
' 同じ色（＝同じ業者）が、別々の物件で同じ稼働日に入っていたら報告する。
'=====================================================================
Public Sub CheckVendorConflicts()
    Dim wsT As Worksheet
    Dim r As Long, lastRow As Long, k As Long, c0 As Long
    Dim occupied As Object
    Dim contract As String, colorName As String
    Dim dFrom As Date, dTo As Date, d As Date
    Dim key As String, report As String, hits As Long

    If Not TaskSheetIsCurrent() Then
        MsgBox SH_TASK & " シートが古い形式です。" & vbCrLf & _
               "「ボタン_初期セットアップ」を実行してください。", vbExclamation
        Exit Sub
    End If

    Set wsT = ThisWorkbook.Worksheets(SH_TASK)
    Set occupied = CreateObject("Scripting.Dictionary")
    lastRow = wsT.Cells(wsT.Rows.Count, TASK_COL_CONTRACT).End(xlUp).Row

    For k = 1 To TASK_COUNT
        c0 = TaskFirstCol(k)
        For r = 2 To lastRow
            contract = Trim$(CStr(wsT.Cells(r, TASK_COL_CONTRACT).Value))
            colorName = Trim$(CStr(wsT.Cells(r, c0 + 2).Value))
            If Len(contract) = 0 Or Len(colorName) = 0 Then GoTo NextRow
            If Not IsDate(wsT.Cells(r, c0).Value) Then GoTo NextRow
            If Not IsDate(wsT.Cells(r, c0 + 1).Value) Then GoTo NextRow

            dFrom = CDate(wsT.Cells(r, c0).Value)
            dTo = CDate(wsT.Cells(r, c0 + 1).Value)

            For d = dFrom To dTo
                If Not IsNonWorkingDay(d) Then
                    key = colorName & "|" & CLng(d)
                    If occupied.Exists(key) Then
                        If occupied(key) <> contract Then
                            hits = hits + 1
                            If hits <= 30 Then
                                report = report & "  " & Format$(d, "yyyy/mm/dd") & _
                                         "  [" & TaskName(k) & "] 色[" & colorName & "]  " & _
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
    Next k

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

'=====================================================================
' 計算結果をクリアする（割り当てをやり直したいとき）
'
' 開始日は残し、終了日と色名だけ消す。
'=====================================================================
Public Sub ClearPlanResults()
    Dim wsT As Worksheet, r As Long, lastRow As Long
    Dim k As Long, c0 As Long, cnt As Long

    If MsgBox(SH_TASK & " から、終了日と色名を消します。" & vbCrLf & _
              "開始日は残ります。よろしいですか？", vbYesNo + vbQuestion) <> vbYes Then Exit Sub

    Set wsT = ThisWorkbook.Worksheets(SH_TASK)
    lastRow = wsT.Cells(wsT.Rows.Count, TASK_COL_CONTRACT).End(xlUp).Row

    For k = 1 To TASK_COUNT
        c0 = TaskFirstCol(k)
        For r = 2 To lastRow
            If Len(Trim$(CStr(wsT.Cells(r, TASK_COL_CONTRACT).Value))) > 0 Then
                wsT.Cells(r, c0 + 1).ClearContents
                wsT.Cells(r, c0 + 2).ClearContents
                cnt = cnt + 1
            End If
        Next r
    Next k

    MsgBox cnt & " 箇所をクリアしました。" & vbCrLf & _
           "「ボタン_工程を作る」で計算し直せます。", vbInformation
End Sub
