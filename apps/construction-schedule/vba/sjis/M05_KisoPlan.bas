Attribute VB_Name = "M05_KisoPlan"
Option Explicit

'=====================================================================
' M05_KisoPlan : 基礎工事の工程を自動で作る
'
' クリティカル工程 7 段階のうち、まず 1 番目の「基礎工事」だけを扱う。
'   1 基礎工事 ← ここ
'   2 躯体工事 / 3 モルタル工事 / 4 防水工事
'   5 断熱工事 / 6 木工事 / 7 仕上げ工事   … 順次追加
'
' やること:
'   1. M_工程データ の「基礎」行から開始日を読む
'   2. 工程表のタイプ（例 C2E42）から坪数と建物種類を取り出す
'   3. M_工期 の式で稼働日数を計算し、終了日を確定する
'   4. 同じ業者が同じ日に2現場へ入らないように業者を割り当てる
'   5. 工程表に色を塗る
'
' 何度実行しても同じ結果になる（冪等）。
' 日程がずれたら開始日を直して再実行すればよい。
'=====================================================================

Private Const TASK_NAME As String = "基礎"

'---------------------------------------------------------------------
' メイン
'---------------------------------------------------------------------
Public Sub GenerateKisoPlan()
    Dim ws As Worksheet, wsT As Worksheet
    Dim dateMap As Object, colorMap As Object
    Dim blockRow As Object, blockType As Object, blockName As Object
    Dim kisoColors As Object, occupied As Object
    Dim plan() As Variant, n As Long
    Dim r As Long, lastRow As Long
    Dim contract As String, typeCode As String, colorName As String
    Dim dStart As Date, dEnd As Date
    Dim days As Long
    Dim warned As String, warnCount As Long
    Dim i As Long

    ' 前提のシートが揃っているか先に確かめる
    If Not SheetExists(SH_TASK) Then
        MsgBox SH_TASK & " シートがありません。" & vbCrLf & _
               "「ボタン_初期セットアップ」を実行してください。", vbExclamation
        Exit Sub
    End If
    If Not TermSheetIsCurrent() Then
        MsgBox SH_TERM & " シートが古い形式です。" & vbCrLf & vbCrLf & _
               "「ボタン_初期セットアップ」を実行してください。" & vbCrLf & _
               "古いシートは " & SH_TERM & "_旧1 という名前で残ります。", _
               vbExclamation, "基礎の工程を作る"
        Exit Sub
    End If

    Set ws = ChartSheet()
    Set wsT = ThisWorkbook.Worksheets(SH_TASK)
    Set dateMap = BuildDateMap(ws)
    Set colorMap = LoadColorMap2()
    Set kisoColors = LoadKisoVendors()

    If kisoColors.Count = 0 Then
        MsgBox SH_VENDOR & " シートに、工種が「基礎」の色が1つもありません。" & vbCrLf & _
               "E列（工種）に「基礎」と入っている行が必要です。", vbExclamation
        Exit Sub
    End If

    LoadBlocks ws, blockRow, blockType, blockName

    '--- 1) M_工程データ から基礎行を集める --------------------------
    lastRow = wsT.Cells(wsT.Rows.Count, 1).End(xlUp).Row
    Dim cap As Long
    cap = lastRow
    If cap < 2 Then cap = 2
    ReDim plan(1 To cap, 1 To 7)
    n = 0

    For r = 2 To lastRow
        If Trim$(CStr(wsT.Cells(r, 3).Value)) <> TASK_NAME Then GoTo NextRow
        contract = Trim$(CStr(wsT.Cells(r, 1).Value))
        If Len(contract) = 0 Then GoTo NextRow

        If Not IsDate(wsT.Cells(r, 4).Value) Then
            warned = warned & "  " & contract & " : 開始日が未入力です（" & r & "行目）" & vbCrLf
            warnCount = warnCount + 1
            GoTo NextRow
        End If
        If Not blockRow.Exists(contract) Then
            warned = warned & "  " & contract & " : 工程表に見つかりません（" & r & "行目）" & vbCrLf
            warnCount = warnCount + 1
            GoTo NextRow
        End If

        typeCode = blockType(contract)
        days = TermDays(TASK_NAME, typeCode)
        If days <= 0 Then
            warned = warned & "  " & contract & " : タイプ「" & typeCode & _
                     "」から工期を計算できません（" & r & "行目）" & vbCrLf
            warnCount = warnCount + 1
            GoTo NextRow
        End If

        ' 開始日が非稼働日なら次の稼働日へ送る
        dStart = AddWorkingDays(CDate(wsT.Cells(r, 4).Value), 0)
        dEnd = AddWorkingDays(dStart, days - 1)

        n = n + 1
        plan(n, 1) = r
        plan(n, 2) = contract
        plan(n, 3) = typeCode
        plan(n, 4) = dStart
        plan(n, 5) = dEnd
        plan(n, 6) = Trim$(CStr(wsT.Cells(r, 6).Value))   ' 手入力の色名（あれば固定）
        plan(n, 7) = blockRow(contract)
NextRow:
    Next r

    If n = 0 Then
        MsgBox SH_TASK & " に、工程「" & TASK_NAME & "」の行がありません。" & vbCrLf & vbCrLf & _
               "契約番号・工程「基礎」・開始日 を入力してから実行してください。" & _
               IIf(warnCount > 0, vbCrLf & vbCrLf & "警告:" & vbCrLf & warned, ""), _
               vbExclamation, "基礎の工程を作る"
        Exit Sub
    End If

    '--- 2) 開始日の早い順に並べる（早い物件から業者を押さえる） -----
    SortPlanByStart plan, n

    '--- 3) 業者を割り当てる ------------------------------------------
    Set occupied = CreateObject("Scripting.Dictionary")

    ' 手入力で固定されている色を先に押さえる
    For i = 1 To n
        colorName = CStr(plan(i, 6))
        If Len(colorName) > 0 Then
            If kisoColors.Exists(colorName) Then
                MarkOccupied occupied, colorName, CDate(plan(i, 4)), CDate(plan(i, 5))
            Else
                warned = warned & "  " & plan(i, 2) & " : 色名「" & colorName & _
                         "」は基礎の業者ではありません" & vbCrLf
                warnCount = warnCount + 1
                plan(i, 6) = ""
            End If
        End If
    Next i

    ' 空欄に、空いている業者を順に割り当てる
    Dim unassigned As String, unassignedCount As Long
    For i = 1 To n
        If Len(CStr(plan(i, 6))) = 0 Then
            colorName = FindFreeVendor(kisoColors, occupied, CDate(plan(i, 4)), CDate(plan(i, 5)))
            If Len(colorName) = 0 Then
                unassigned = unassigned & "  " & blockName(CStr(plan(i, 2))) & _
                             " (" & plan(i, 2) & ")  " & _
                             Format$(plan(i, 4), "mm/dd") & "～" & Format$(plan(i, 5), "mm/dd") & vbCrLf
                unassignedCount = unassignedCount + 1
            Else
                plan(i, 6) = colorName
                MarkOccupied occupied, colorName, CDate(plan(i, 4)), CDate(plan(i, 5))
            End If
        End If
    Next i

    '--- 4) 書き戻して色を塗る ----------------------------------------
    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual
    On Error GoTo Cleanup

    Dim painted As Long
    For i = 1 To n
        r = CLng(plan(i, 1))
        wsT.Cells(r, 5).Value = CDate(plan(i, 5))         ' 終了日
        wsT.Cells(r, 6).Value = CStr(plan(i, 6))          ' 色名

        ClearKisoPaint ws, CLng(plan(i, 7)), dateMap, kisoColors, colorMap
        If Len(CStr(plan(i, 6))) > 0 Then
            painted = painted + PaintKiso(ws, CLng(plan(i, 7)), dateMap, _
                                          CDate(plan(i, 4)), CDate(plan(i, 5)), _
                                          CLng(colorMap(CStr(plan(i, 6)))))
        End If
    Next i

Cleanup:
    Application.Calculation = xlCalculationAutomatic
    Application.ScreenUpdating = True

    If Err.Number <> 0 Then
        MsgBox "エラーが発生しました: " & Err.Description, vbCritical
        Exit Sub
    End If

    ShowPlanReport ws, plan, n, blockName, painted, unassigned, unassignedCount, warned, warnCount
End Sub

'---------------------------------------------------------------------
' 結果を表示する
'---------------------------------------------------------------------
Private Sub ShowPlanReport(ws As Worksheet, plan() As Variant, n As Long, _
                           blockName As Object, painted As Long, _
                           unassigned As String, unassignedCount As Long, _
                           warned As String, warnCount As Long)
    Dim msg As String, i As Long, shown As Long

    msg = "基礎工事の工程を作成しました。" & vbCrLf & vbCrLf & _
          "対象シート : " & ws.Name & vbCrLf & _
          "物件       : " & n & " 件" & vbCrLf & _
          "塗ったセル : " & painted & vbCrLf & vbCrLf & _
          "邸名 / タイプ / 期間 / 業者" & vbCrLf

    Dim kind As String, floors As Long, area As Long
    Dim outOfRange As Long

    For i = 1 To n
        shown = shown + 1
        If shown > 15 Then
            msg = msg & "  ... 他 " & (n - 15) & " 件" & vbCrLf
            Exit For
        End If

        ' 実測データは 25～90 坪。外れる場合は外挿なので印を付ける
        Dim mark As String
        mark = ""
        If ParseType(CStr(plan(i, 3)), kind, floors, area) Then
            If area < 25 Or area > 90 Then
                mark = "  ※実測範囲外"
                outOfRange = outOfRange + 1
            End If
        End If

        msg = msg & "  " & Left$(blockName(CStr(plan(i, 2))) & String$(12, " "), 12) & _
              " " & Left$(CStr(plan(i, 3)) & String$(7, " "), 7) & _
              " " & Format$(plan(i, 4), "mm/dd") & "～" & Format$(plan(i, 5), "mm/dd") & _
              " " & IIf(Len(CStr(plan(i, 6))) > 0, CStr(plan(i, 6)), "（未割当）") & _
              mark & vbCrLf
    Next i

    If outOfRange > 0 Then
        msg = msg & vbCrLf & "※実測範囲外 : 工期の式は 25～90坪 の実績から作っています。" & vbCrLf & _
              "　この範囲を外れる物件の日数は目安です。必ず確認してください。" & vbCrLf
    End If

    If unassignedCount > 0 Then
        msg = msg & vbCrLf & "■ 業者が足りず割り当てられなかった物件 (" & unassignedCount & "件):" & vbCrLf & _
              unassigned & _
              "　" & SH_VENDOR & " に基礎の業者を追加するか、開始日をずらしてください。" & vbCrLf
    End If

    If warnCount > 0 Then
        msg = msg & vbCrLf & "■ 警告:" & vbCrLf & warned
    End If

    MsgBox msg, IIf(unassignedCount > 0 Or warnCount > 0, vbExclamation, vbInformation), _
           "基礎の工程を作る"
End Sub

'---------------------------------------------------------------------
' 基礎の色帯を塗る。塗ったセル数を返す。
'---------------------------------------------------------------------
Private Function PaintKiso(ws As Worksheet, blockRow As Long, dateMap As Object, _
                           dFrom As Date, dTo As Date, rgbVal As Long) As Long
    Dim d As Date, col As Long, cnt As Long
    For d = dFrom To dTo
        If Not IsNonWorkingDay(d) Then
            If dateMap.Exists(CLng(d)) Then
                col = dateMap(CLng(d))
                ws.Cells(blockRow + OFS_KISO, col).Interior.Color = rgbVal
                ws.Cells(blockRow + OFS_KISO_SUB, col).Interior.Color = rgbVal
                cnt = cnt + 2
            End If
        End If
    Next d
    PaintKiso = cnt
End Function

'---------------------------------------------------------------------
' その物件の基礎の色だけを消す
'
' 基礎の行は後半で外構も使うため、行ごと消してはいけない。
' 「基礎業者の色」に一致するセルだけを対象にする。
'---------------------------------------------------------------------
Private Sub ClearKisoPaint(ws As Worksheet, blockRow As Long, dateMap As Object, _
                           kisoColors As Object, colorMap As Object)
    Dim rgbSet As Object, k As Variant, c As Variant
    Dim offsets As Variant, off As Variant, cell As Range

    Set rgbSet = CreateObject("Scripting.Dictionary")
    For Each k In kisoColors.Keys
        If colorMap.Exists(k) Then rgbSet(CLng(colorMap(k))) = True
    Next k
    If rgbSet.Count = 0 Then Exit Sub

    offsets = Array(OFS_KISO, OFS_KISO_SUB)
    For Each c In dateMap.Items
        For Each off In offsets
            Set cell = ws.Cells(blockRow + CLng(off), CLng(c))
            If cell.Interior.Pattern <> xlNone Then
                If rgbSet.Exists(CLng(cell.Interior.Color)) Then cell.Interior.Pattern = xlNone
            End If
        Next off
    Next c
End Sub

'---------------------------------------------------------------------
' 期間中ずっと空いている業者を返す。無ければ空文字。
'---------------------------------------------------------------------
Private Function FindFreeVendor(kisoColors As Object, occupied As Object, _
                                dFrom As Date, dTo As Date) As String
    Dim k As Variant, d As Date, busy As Boolean

    For Each k In kisoColors.Keys
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

    FindFreeVendor = ""
End Function

'---------------------------------------------------------------------
' 業者の稼働日を埋める
'---------------------------------------------------------------------
Private Sub MarkOccupied(occupied As Object, colorName As String, _
                         dFrom As Date, dTo As Date)
    Dim d As Date
    For d = dFrom To dTo
        If Not IsNonWorkingDay(d) Then occupied(colorName & "|" & CLng(d)) = True
    Next d
End Sub

'---------------------------------------------------------------------
' 開始日の昇順に並べ替える（単純挿入ソート。件数が少ないので十分）
'---------------------------------------------------------------------
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

'---------------------------------------------------------------------
' 工程表のブロック情報を 契約番号 をキーに読み込む
'---------------------------------------------------------------------
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

'---------------------------------------------------------------------
' 基礎の業者色（M_業者 の工種が「基礎」の行）
'---------------------------------------------------------------------
Private Function LoadKisoVendors() As Object
    Dim ws As Worksheet, map As Object
    Dim r As Long, lastRow As Long, nm As String

    Set map = CreateObject("Scripting.Dictionary")
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(SH_VENDOR)
    On Error GoTo 0
    If ws Is Nothing Then
        Set LoadKisoVendors = map
        Exit Function
    End If

    lastRow = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    For r = 2 To lastRow
        nm = Trim$(CStr(ws.Cells(r, 1).Value))
        If Len(nm) > 0 And Trim$(CStr(ws.Cells(r, 5).Value)) = "基礎" Then
            map(nm) = Trim$(CStr(ws.Cells(r, 6).Value))    ' 値は業者名（未入力可）
        End If
    Next r

    Set LoadKisoVendors = map
End Function

'---------------------------------------------------------------------
' 色名 -> RGB（M04 と同じ内容。モジュール間の依存を作らないため再掲）
'---------------------------------------------------------------------
Private Function LoadColorMap2() As Object
    Dim ws As Worksheet, map As Object
    Dim r As Long, lastRow As Long, nm As String

    Set map = CreateObject("Scripting.Dictionary")
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(SH_VENDOR)
    On Error GoTo 0
    If ws Is Nothing Then
        Set LoadColorMap2 = map
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
    Set LoadColorMap2 = map
End Function

'---------------------------------------------------------------------
' 基礎の業者割当をクリアする（割り当てをやり直したいとき）
'---------------------------------------------------------------------
Public Sub ClearKisoVendorAssignment()
    Dim wsT As Worksheet, r As Long, lastRow As Long, cnt As Long

    If MsgBox("M_工程データ の「基礎」行から、終了日と色名を消します。" & vbCrLf & _
              "開始日は残ります。よろしいですか？", vbYesNo + vbQuestion) <> vbYes Then Exit Sub

    Set wsT = ThisWorkbook.Worksheets(SH_TASK)
    lastRow = wsT.Cells(wsT.Rows.Count, 1).End(xlUp).Row

    For r = 2 To lastRow
        If Trim$(CStr(wsT.Cells(r, 3).Value)) = TASK_NAME Then
            wsT.Cells(r, 5).ClearContents
            wsT.Cells(r, 6).ClearContents
            cnt = cnt + 1
        End If
    Next r

    MsgBox cnt & " 行をクリアしました。" & vbCrLf & _
           "「ボタン_基礎の工程を作る」で割り当て直せます。", vbInformation
End Sub
