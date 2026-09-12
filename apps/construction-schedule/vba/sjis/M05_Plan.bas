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
'   1. 工程表の「基礎業者」「躯体業者」欄から、その物件の業者を読む
'   2. M_工程データ（1物件1行）から開始日を読む（空欄なら本着日を使う）
'   3. 工程表のタイプ（例 C2E42）から坪数と建物種類を取り出す
'   4. 工期の式（M02_Masters の TermDays）で稼働日数を計算し、終了日を確定する
'   5. 同じ業者が2現場に重ならないよう、後の現場を後ろへずらす
'   6. 工程表に色を塗る
'
' ■ 業者はシートで決まっている（自動割り当てはしない）
' 業者名は工程表のお客様名の右（建設地の右2列）に書いてある。
' その名前を M_業者 の「業者名」で引いて色を決める。
'
' ■ 業者の順番はシートの上から
' 1業者は同時に2現場へ入れない。シートの上にある物件を優先し、
' 前の現場が終わった翌営業日から次の現場に入る。
' 次の現場の開始予定日が前の現場の完了より前なら、開始日を後ろへずらす。
' 前倒しはしない（空きがあっても予定日より早く始めない）。
'
' ■ 手入力（黒字）は触らない・自動（青字）は毎回決め直す
' 会社やお客様の都合で日程を人が決めることがあるため、人が入力した値には触らない。
' マクロが計算して入れた値は青字にしておき、次の計算で決め直す。
'
'   開始日 … 黒字ならその日を使う。青字・空欄なら本着日／前工程から決め直す
'   終了日 … 黒字ならその日を使う。青字・空欄なら工期の式で計算し直す
'   色名   … 黒字ならその色。青字・空欄なら工程表の業者欄から引き直す
'   調整   … 入力。終了日を計算するときに足し引きする日数
'
' 青字を決め直すので、あとから調整を入れたり業者を変えたりしても、
' 「ボタン_工程を計算する」を実行するだけで後続の現場までずれる。
' 手入力（黒字）の開始日が前の現場と重なるときは、書き換えずに警告で知らせる。
'
' 手入力の値を自動に戻したいときは、そのセルを消す（または黒字→空欄にする）。
' 行をまとめて消すなら ClearPlanResultsForSelection / ClearPlanResults を使う。
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
' メイン1 : 表の上で計算する（工程表には触らない）
'=====================================================================
Public Sub CalculatePlan()
    Dim ws As Worksheet, wsT As Worksheet
    Dim info As Object, order As Collection, taskRow As Object
    Dim prevEnd As Object, result As Object
    Dim k As Long
    Dim warned As String, warnCount As Long
    Dim conflicts As String, conflictCount As Long
    Dim derived As Long, outOfRange As Long, kept As Long, delayed As Long

    If Not PreflightOK() Then Exit Sub

    ' 例外日を読み直す。工期の計算にも効かせるため必ず先に行う。
    ResetExceptionCache
    UpdateExceptionDetails

    Set ws = ChartSheet()
    Set wsT = ThisWorkbook.Worksheets(SH_TASK)
    LoadBlocks ws, info, order
    Set taskRow = BuildTaskRowMap(wsT)

    Set prevEnd = CreateObject("Scripting.Dictionary")
    Set result = CreateObject("Scripting.Dictionary")

    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual
    On Error GoTo Cleanup

    ' 工程は順番に処理する。躯体は基礎の結果（終了日）を使うため。
    For k = 1 To TASK_COUNT
        PlanOneTask k, wsT, info, order, taskRow, prevEnd, result, _
                    warned, warnCount, conflicts, conflictCount, _
                    derived, outOfRange, kept, delayed
    Next k

Cleanup:
    Application.Calculation = xlCalculationAutomatic
    Application.ScreenUpdating = True

    If Err.Number <> 0 Then
        MsgBox "エラーが発生しました: " & Err.Description, vbCritical
        Exit Sub
    End If

    ShowReport ws, result, info, derived, outOfRange, kept, delayed, _
               conflicts, conflictCount, warned, warnCount
End Sub

'=====================================================================
' メイン2 : 工程表に色を塗る（計算はしない）
'
' M_工程データ に入っている 開始日・終了日・色名 をそのまま塗る。
' 日祝の塗りつぶしも、このなかで一緒に行う。
'=====================================================================
' clearedCount : 塗る前に消したセル数。RepaintPlan から渡す。単独実行なら -1。
Public Sub PaintPlan(Optional clearedCount As Long = -1)
    Dim ws As Worksheet, wsT As Worksheet
    Dim dateMap As Object, colorMap As Object, vendors As Object
    Dim info As Object, order As Collection, taskRow As Object
    Dim k As Long, r As Long, lastRow As Long, c0 As Long
    Dim contract As String, colorName As String
    Dim dFrom As Date, dTo As Date
    Dim painted As Long, skipped As Long, marks As Long, shiftCol As Long
    Dim holidayMsg As String, markMsg As String
    Dim warned As String, warnCount As Long

    If Not PreflightOK() Then Exit Sub

    Set ws = ChartSheet()
    Set wsT = ThisWorkbook.Worksheets(SH_TASK)

    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual
    On Error GoTo Cleanup

    ' 1) 日祝を先に塗る。祝日は稼働日なので、このあと工程色が上書きする。
    holidayMsg = PaintHolidaysCore(ws)

    Set dateMap = BuildDateMap(ws)
    Set colorMap = LoadColorMap()
    LoadBlocks ws, info, order
    lastRow = wsT.Cells(wsT.Rows.Count, TASK_COL_CONTRACT).End(xlUp).Row

    ' 2) 工程の色を塗る

    For k = 1 To TASK_COUNT
        c0 = TaskFirstCol(k)
        Set vendors = LoadVendorsByKind(TaskName(k))
        If vendors.Count = 0 Then GoTo NextTask

        For r = 2 To lastRow
            contract = Trim$(CStr(wsT.Cells(r, TASK_COL_CONTRACT).Value))
            If Len(contract) = 0 Then GoTo NextRow
            If Not info.Exists(contract) Then GoTo NextRow

            ' その工程の古い色をいったん消す（外構や日祝には触らない）
            ClearTaskPaint ws, BlockRowOf(info, contract), dateMap, vendors, colorMap, TaskRowOffsets(k)

            colorName = Trim$(CStr(wsT.Cells(r, c0 + TASK_OFS_COLOR).Value))
            If Len(colorName) = 0 Then GoTo NextRow
            If Not IsDate(wsT.Cells(r, c0 + TASK_OFS_START).Value) Then GoTo NextRow
            If Not IsDate(wsT.Cells(r, c0 + TASK_OFS_END).Value) Then GoTo NextRow

            If Not colorMap.Exists(colorName) Then
                warned = warned & "  " & contract & " [" & TaskName(k) & "] : 色名「" & _
                         colorName & "」が " & SH_VENDOR & " にありません" & vbCrLf
                warnCount = warnCount + 1
                GoTo NextRow
            End If

            dFrom = CDate(wsT.Cells(r, c0 + TASK_OFS_START).Value)
            dTo = CDate(wsT.Cells(r, c0 + TASK_OFS_END).Value)
            ' 基礎は本着日の黒と行がぶつかるので、その列だけ1行上へずらす
            If k = 1 Then
                shiftCol = HonchakuCol(info, contract, dateMap)
            Else
                shiftCol = 0
            End If

            painted = painted + PaintTask(ws, BlockRowOf(info, contract), dateMap, _
                                          dFrom, dTo, CLng(colorMap(colorName)), _
                                          TaskRowOffsets(k), contract, shiftCol)

            ' 工程表の表示期間から外れている日は塗れない
            If Not dateMap.Exists(CLng(dFrom)) Then skipped = skipped + 1
NextRow:
        Next r
NextTask:
    Next k

    ' 3) 本着日（黒）とお客様納期（青）を塗る。工程色より上に載せる。
    marks = PaintMilestones(ws, info, order, dateMap, markMsg)

    ' 4) 「2W」など、塗りつぶし無しにするイベントのセルを整える
    marks = marks + ApplyEventFills(ws, order, info)

Cleanup:
    Application.Calculation = xlCalculationAutomatic
    Application.ScreenUpdating = True

    If Err.Number <> 0 Then
        MsgBox "エラーが発生しました: " & Err.Description, vbCritical
        Exit Sub
    End If

    Dim msg As String
    msg = "工程表に色を塗りました。" & vbCrLf & vbCrLf & _
          "対象シート : " & ws.Name & vbCrLf
    If clearedCount >= 0 Then
        msg = msg & "消した色   : " & clearedCount & " セル" & vbCrLf
    End If
    msg = msg & _
          "工程の色   : " & painted & " セル" & vbCrLf & vbCrLf & _
          markMsg & vbCrLf & vbCrLf & _
          holidayMsg
    If skipped > 0 Then
        msg = msg & vbCrLf & vbCrLf & _
              "※ " & skipped & " 件は開始日が工程表の表示期間の外にあり、塗られていません。"
    End If
    If warnCount > 0 Then
        msg = msg & vbCrLf & vbCrLf & "■ 警告:" & vbCrLf & warned
    End If

    MsgBox msg, IIf(warnCount > 0, vbExclamation, vbInformation), "工程表に色を塗る"
End Sub

'---------------------------------------------------------------------
' 工程を1つ処理する
'---------------------------------------------------------------------
Private Sub PlanOneTask(k As Long, wsT As Worksheet, _
                        info As Object, order As Collection, taskRow As Object, _
                        prevEnd As Object, result As Object, _
                        ByRef warned As String, ByRef warnCount As Long, _
                        ByRef conflicts As String, ByRef conflictCount As Long, _
                        ByRef derived As Long, ByRef outOfRange As Long, _
                        ByRef kept As Long, ByRef delayed As Long)

    Dim vendors As Object, nameMap As Object, vendorFree As Object, vendorLast As Object
    Dim r As Long, c0 As Long
    Dim key As Variant, contract As String, typeCode As String
    Dim vendorName As String, colorName As String, writtenColor As String
    Dim dWish As Date, dStart As Date, dEnd As Date
    Dim days As Long
    Dim kind As String, floors As Long, area As Long
    Dim taskLabel As String, startFixed As Boolean, endFixed As Boolean
    Dim v As Variant
    Dim cStart As Range, cEnd As Range, cColor As Range

    taskLabel = TaskName(k)
    c0 = TaskFirstCol(k)
    Set vendors = LoadVendorsByKind(taskLabel)

    If vendors.Count = 0 Then
        warned = warned & "  " & SH_VENDOR & " に工種「" & taskLabel & "」の色がありません" & vbCrLf
        warnCount = warnCount + 1
        Exit Sub
    End If

    Set nameMap = BuildVendorNameMap(vendors)
    Set vendorFree = CreateObject("Scripting.Dictionary")   ' 色名 -> 次に入れる日
    Set vendorLast = CreateObject("Scripting.Dictionary")   ' 色名 -> 直前の現場の契約番号

    ' シートの上から順に処理する。これが業者の優先順位そのもの。
    For Each key In order
        contract = CStr(key)
        v = info(contract)

        If Not taskRow.Exists(contract) Then GoTo NextProp
        r = CLng(taskRow(contract))

        Set cStart = wsT.Cells(r, c0 + TASK_OFS_START)
        Set cEnd = wsT.Cells(r, c0 + TASK_OFS_END)
        Set cColor = wsT.Cells(r, c0 + TASK_OFS_COLOR)

        '--- 業者を決める --------------------------------------------
        ' 手入力（黒字）の色名だけ尊重する。
        ' 自前で入れた（青字）色名は、工程表の業者欄から引き直す。
        vendorName = Trim$(CStr(v(IIf(k = 1, 4, 5))))
        writtenColor = Trim$(CStr(cColor.Value))
        If IsAutoCell(cColor) Then writtenColor = ""

        If Len(writtenColor) > 0 Then
            ' 手入力の色名を尊重する
            colorName = writtenColor
            If Not vendors.Exists(colorName) Then
                warned = warned & "  " & InfoName(info, contract) & " [" & taskLabel & "] : 色名「" & _
                         colorName & "」は" & taskLabel & "の業者ではありません" & vbCrLf
                warnCount = warnCount + 1
                GoTo NextProp
            End If
        ElseIf Len(vendorName) = 0 Then
            warned = warned & "  " & InfoName(info, contract) & " [" & taskLabel & "] : " & _
                     "工程表に" & taskLabel & "業者が書かれていません" & vbCrLf
            warnCount = warnCount + 1
            GoTo NextProp
        ElseIf nameMap.Exists(NormalizeName(vendorName)) Then
            colorName = CStr(nameMap(NormalizeName(vendorName)))
        Else
            warned = warned & "  " & InfoName(info, contract) & " [" & taskLabel & "] : 業者「" & _
                     vendorName & "」が " & SH_VENDOR & " にありません（工種" & taskLabel & "）" & vbCrLf
            warnCount = warnCount + 1
            GoTo NextProp
        End If

        '--- 希望の開始日を決める ------------------------------------
        ' 入っていればその日を使う（人が決めた日程を尊重する）。
        ' 空欄なら、基礎は本着日から、2番目以降は前工程の終了日から決める。
        ' 手入力（黒字）の開始日だけ動かさない。
        ' 自前で入れた（青字）開始日は、毎回決め直す。
        ' こうしないと、前の現場の工期が伸びたときに後ろがずれない。
        startFixed = False
        If IsDate(cStart.Value) And Not IsAutoCell(cStart) Then
            dWish = CDate(cStart.Value)
            startFixed = True
        ElseIf k > 1 And prevEnd.Exists(contract) Then
            dWish = CDate(prevEnd(contract)) + TaskInterval(k)
        ElseIf k = 1 And IsDate(v(6)) Then
            dWish = CDate(v(6))          ' 本着日
        Else
            GoTo NextProp                ' 開始日も本着日も無い＝まだ計画対象外
        End If
        dStart = AddWorkingDaysFor(contract, dWish, 0)

        '--- 業者の空きに合わせて後ろへずらす ------------------------
        ' 前の現場が終わった翌営業日から。前倒しはしない。
        If vendorFree.Exists(colorName) Then
            If CDate(vendorFree(colorName)) > dStart Then
                If startFixed Then
                    ' 手入力の開始日は書き換えない。重なることだけ知らせる。
                    conflicts = conflicts & _
                        "  【" & taskLabel & "】" & InfoName(info, contract) & _
                        "  開始日 " & Format$(dStart, "yyyy/mm/dd") & vbCrLf & _
                        "    業者「" & colorName & "」は " & _
                        InfoName(info, CStr(vendorLast(colorName))) & " に入っています。" & vbCrLf & _
                        "    → " & Format$(CDate(vendorFree(colorName)), "yyyy/mm/dd") & _
                        " 以降なら入れます" & vbCrLf & vbCrLf
                    conflictCount = conflictCount + 1
                Else
                    dStart = AddWorkingDaysFor(contract, CDate(vendorFree(colorName)), 0)
                    delayed = delayed + 1
                End If
            End If
        End If

        If Not startFixed Then
            WriteAuto cStart, dStart
            derived = derived + 1
        End If

        typeCode = CStr(v(3))

        '--- 終了日を決める ------------------------------------------
        ' 入っていればその日を使う（人が決めた日程を尊重する）。空欄なら計算する。
        ' 手入力（黒字）の終了日だけそのまま使う。
        ' 自前で入れた（青字）終了日は、調整の変更を拾えるよう計算し直す。
        endFixed = (IsDate(cEnd.Value) And Not IsAutoCell(cEnd))
        If endFixed Then
            dEnd = CDate(cEnd.Value)
            If dEnd < dStart Then dEnd = dStart
            kept = kept + 1
        Else
            days = TermDays(taskLabel, typeCode)
            If days <= 0 Then
                warned = warned & "  " & InfoName(info, contract) & " : タイプ「" & typeCode & _
                         "」から" & taskLabel & "の工期を計算できません" & vbCrLf
                warnCount = warnCount + 1
                GoTo NextProp
            End If

            ' 調整列の日数を足し引きする（1日を下回らないようにする）
            If IsNumeric(wsT.Cells(r, c0 + TASK_OFS_ADJUST).Value) Then
                If Len(Trim$(CStr(wsT.Cells(r, c0 + TASK_OFS_ADJUST).Value))) > 0 Then
                    days = days + CLng(wsT.Cells(r, c0 + TASK_OFS_ADJUST).Value)
                End If
            End If
            If days < 1 Then days = 1

            dEnd = AddWorkingDaysFor(contract, dStart, days - 1)
            WriteAuto cEnd, dEnd
        End If

        ' 実測範囲（25～90坪）を外れていたら印を付ける
        If ParseType(typeCode, kind, floors, area) Then
            If area < 25 Or area > 90 Then outOfRange = outOfRange + 1
        End If

        '--- 業者の次の空き日を更新する ------------------------------
        ' 終わった翌営業日から次の現場へ入る。
        vendorFree(colorName) = AddWorkingDaysFor(contract, dEnd, 1)
        vendorLast(colorName) = contract

        If Len(writtenColor) = 0 Then
            WriteAuto cColor, colorName
        End If

        prevEnd(contract) = dEnd
        result(contract & "|" & k) = Array(typeCode, dStart, dEnd, colorName)
NextProp:
    Next key
End Sub

'---------------------------------------------------------------------
' 邸名（分からなければ契約番号）
'---------------------------------------------------------------------
Private Function InfoName(info As Object, contract As String) As String
    Dim v As Variant
    If info.Exists(contract) Then
        v = info(contract)
        If Len(Trim$(CStr(v(1)))) > 0 Then
            InfoName = Trim$(CStr(v(1)))
            Exit Function
        End If
    End If
    InfoName = contract
End Function

'---------------------------------------------------------------------
' 契約番号 -> M_工程データ の行番号
'---------------------------------------------------------------------
Private Function BuildTaskRowMap(wsT As Worksheet) As Object
    Dim map As Object, r As Long, lastRow As Long, contract As String
    Set map = CreateObject("Scripting.Dictionary")
    lastRow = wsT.Cells(wsT.Rows.Count, TASK_COL_CONTRACT).End(xlUp).Row
    For r = 2 To lastRow
        contract = Trim$(CStr(wsT.Cells(r, TASK_COL_CONTRACT).Value))
        If Len(contract) > 0 Then
            If Not map.Exists(contract) Then map.Add contract, r
        End If
    Next r
    Set BuildTaskRowMap = map
End Function

'---------------------------------------------------------------------
' 業者名 -> 色名 の対応表を作る
'
' M_業者 の「業者名」は「丸岩/KRK」のように / 区切りで別名を並べられる。
' 表記ゆれを吸収するため、空白を落として比較する。
'---------------------------------------------------------------------
Private Function BuildVendorNameMap(vendors As Object) As Object
    Dim map As Object, k As Variant, parts As Variant, i As Long, nm As String
    Set map = CreateObject("Scripting.Dictionary")
    For Each k In vendors.Keys
        parts = Split(CStr(vendors(k)), "/")
        For i = LBound(parts) To UBound(parts)
            nm = NormalizeName(CStr(parts(i)))
            If Len(nm) > 0 Then map(nm) = CStr(k)
        Next i
    Next k
    Set BuildVendorNameMap = map
End Function

'---------------------------------------------------------------------
' 業者名の突き合わせ用に整える（前後と途中の空白を落とす）
'---------------------------------------------------------------------
Private Function NormalizeName(s As String) As String
    Dim t As String
    t = Trim$(s)
    t = Replace$(t, " ", "")
    t = Replace$(t, "　", "")
    NormalizeName = t
End Function

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
    If Not VendorSheetIsCurrent() Then
        MsgBox SH_VENDOR & " シートが古い色設定です。" & vbCrLf & vbCrLf & _
               "「ボタン_初期セットアップ」を実行してください。" & vbCrLf & _
               "古いシートは " & SH_VENDOR & "_旧1 という名前で残ります。", _
               vbExclamation, "工程を作る"
        Exit Function
    End If
    PreflightOK = True
End Function

'=====================================================================
' 結果表示
'=====================================================================
Private Sub ShowReport(ws As Worksheet, result As Object, info As Object, _
                       derived As Long, outOfRange As Long, kept As Long, delayed As Long, _
                       conflicts As String, conflictCount As Long, _
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

    msg = "工程を計算しました。" & vbCrLf & vbCrLf & _
          "対象シート : " & ws.Name & vbCrLf & _
          "物件       : " & total & " 件" & vbCrLf
    If derived > 0 Then msg = msg & "開始日を自動で決めた工程 : " & derived & " 件" & vbCrLf
    If delayed > 0 Then msg = msg & "業者の前の現場に合わせて後ろへずらした工程 : " & delayed & " 件" & vbCrLf
    If kept > 0 Then msg = msg & "手入力の終了日をそのまま使った工程 : " & kept & " 件" & vbCrLf

    msg = msg & vbCrLf & "邸名 / タイプ / 基礎 / 躯体" & vbCrLf

    For Each key In seen.Keys
        shown = shown + 1
        If shown > 12 Then
            msg = msg & "  ... 他 " & (total - 12) & " 件" & vbCrLf
            Exit For
        End If
        contract = CStr(key)
        line = "  " & Left$(InfoName(info, contract) & String$(11, " "), 11)
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
    If conflictCount > 0 Then
        msg = msg & vbCrLf & String$(50, "-") & vbCrLf & _
              "■ その日程では業者が入れません（" & conflictCount & "件）" & vbCrLf & vbCrLf & _
              conflicts & _
              "  手入力の開始日は書き換えていません。次のどれかで解消できます。" & vbCrLf & _
              "    ・上に出ている日まで開始日をずらす" & vbCrLf & _
              "    ・先に入っている物件の日程を動かす" & vbCrLf & _
              "    ・工程表の業者欄を別の業者に変える" & vbCrLf & vbCrLf & _
              "  ※このままだと同じ業者が2現場に重なります。" & vbCrLf
    End If
    If warnCount > 0 Then
        msg = msg & vbCrLf & "■ 警告:" & vbCrLf & warned
    End If

    msg = msg & vbCrLf & "続けて「ボタン_工程表に色を塗る」を実行してください。"

    MsgBox msg, IIf(conflictCount > 0 Or warnCount > 0, vbExclamation, vbInformation), _
           IIf(conflictCount > 0, "工程を計算する － 業者が重なっています", "工程を計算する")
End Sub

'=====================================================================
' 塗る / 消す
'=====================================================================
Private Function PaintTask(ws As Worksheet, blockRow As Long, dateMap As Object, _
                           dFrom As Date, dTo As Date, rgbVal As Long, _
                           offsets As Variant, contract As String, _
                           shiftCol As Long) As Long
    Dim d As Date, col As Long, cnt As Long, off As Variant
    Dim use As Variant

    For d = dFrom To dTo
        If Not IsNonWorkingDayFor(contract, d) Then
            If dateMap.Exists(CLng(d)) Then
                col = dateMap(CLng(d))

                ' 本着日の列だけ、黒に場所を譲って1行上へ逃がす
                If shiftCol > 0 And col = shiftCol Then
                    use = ShiftedOffsets(offsets)
                Else
                    use = offsets
                End If

                For Each off In use
                    If blockRow + CLng(off) >= blockRow Then
                        ws.Cells(blockRow + CLng(off), col).Interior.Color = rgbVal
                        cnt = cnt + 1
                    End If
                Next off
            End If
        End If
    Next d
    PaintTask = cnt
End Function

'---------------------------------------------------------------------
' 本着日（黒）とお客様納期（青）を工程表に塗る
'
' 工事の色より上に載せる。日付が工程表の表示期間の外なら何もしない。
'   本着日       … 基礎の下の行に1マスだけ（MARK_OFS_HONCHAKU）
'                   その列の基礎の色帯は1行上へずらして塗ってある
'   お客様納期   … 物件ブロックの上から縦 MARK_ROWS マス
'---------------------------------------------------------------------
Private Function PaintMilestones(ws As Worksheet, info As Object, _
                                 order As Collection, dateMap As Object, _
                                 ByRef report As String) As Long
    Dim key As Variant, v As Variant, cnt As Long
    Dim blockTop As Long, res As Long
    Dim hOK As Long, hNone As Long, hOut As Long, hList As String
    Dim nOK As Long, nNone As Long, nOut As Long

    For Each key In order
        v = info(CStr(key))
        blockTop = CLng(v(0))

        res = PaintMarkColumn(ws, blockTop + MARK_OFS_HONCHAKU, dateMap, _
                              v(6), CLR_MARK_HONCHAKU, 1)
        Select Case res
            Case -1: hNone = hNone + 1
            Case -2
                hOut = hOut + 1
                If hOut <= 5 Then hList = hList & "    " & CStr(v(1)) & " " & _
                                          Format$(v(6), "yyyy/mm/dd") & vbCrLf
            Case Else: hOK = hOK + 1: cnt = cnt + res
        End Select

        res = PaintMarkColumn(ws, blockTop + MARK_OFS_FIRST, dateMap, _
                              v(7), CLR_MARK_NOUKI, MARK_ROWS)
        Select Case res
            Case -1: nNone = nNone + 1
            Case -2: nOut = nOut + 1
            Case Else: nOK = nOK + 1: cnt = cnt + res
        End Select
    Next key

    report = "本着日（黒） : " & hOK & " 件"
    If hNone > 0 Then report = report & " / 日付なし " & hNone & " 件"
    If hOut > 0 Then report = report & " / 表示期間外 " & hOut & " 件" & vbCrLf & hList
    report = report & vbCrLf & "お客様納期（青） : " & nOK & " 件"
    If nNone > 0 Then report = report & " / 日付なし " & nNone & " 件"
    If nOut > 0 Then report = report & " / 表示期間外 " & nOut & " 件"

    PaintMilestones = cnt
End Function

'---------------------------------------------------------------------
' 縦に rowCount マス塗る
'
' 戻り値 : 塗ったセル数 / -1 日付が無い / -2 工程表の表示期間の外
'---------------------------------------------------------------------
Private Function PaintMarkColumn(ws As Worksheet, baseRow As Long, dateMap As Object, _
                                 dv As Variant, rgbVal As Long, rowCount As Long) As Long
    Dim d As Date, col As Long, i As Long

    If Not IsDate(dv) Then
        PaintMarkColumn = -1
        Exit Function
    End If
    d = CDate(dv)
    If Not dateMap.Exists(CLng(d)) Then
        PaintMarkColumn = -2
        Exit Function
    End If

    col = CLng(dateMap(CLng(d)))
    For i = 0 To rowCount - 1
        ws.Cells(baseRow + i, col).Interior.Color = rgbVal
    Next i
    PaintMarkColumn = rowCount
End Function

'---------------------------------------------------------------------
' 本着日の列だけ、色帯を1行上へずらす
'
' 本着日はその物件の基礎の下1マスを黒で使う。同じマスに基礎の色を塗ると
' 消えてしまうため、その列に限って基礎の色帯を1行上へ逃がす。
' 基礎以外の工程は本着日と行が重ならないので、そのまま。
'---------------------------------------------------------------------
Private Function ShiftedOffsets(offsets As Variant) As Variant
    Dim res As Variant, i As Long
    res = offsets
    For i = LBound(res) To UBound(res)
        res(i) = CLng(res(i)) - 1
    Next i
    ShiftedOffsets = res
End Function

'---------------------------------------------------------------------
' その物件の本着日が入っている列。無ければ 0。
'---------------------------------------------------------------------
Private Function HonchakuCol(info As Object, contract As String, dateMap As Object) As Long
    Dim v As Variant, d As Date
    If Not info.Exists(contract) Then Exit Function
    v = info(contract)
    If Not IsDate(v(6)) Then Exit Function
    d = CDate(v(6))
    If Not dateMap.Exists(CLng(d)) Then Exit Function
    HonchakuCol = CLng(dateMap(CLng(d)))
End Function

'---------------------------------------------------------------------
' その物件のブロック先頭行
'---------------------------------------------------------------------
Private Function BlockRowOf(info As Object, contract As String) As Long
    Dim v As Variant
    v = info(contract)
    BlockRowOf = CLng(v(0))
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

    ' 本着日の列で1行上へ逃がした分も消えるよう、1行上まで対象にする
    Dim allOffsets As Variant
    allOffsets = WithShifted(offsets)

    For Each c In dateMap.Items
        For Each off In allOffsets
            If blockRow + CLng(off) < blockRow Then GoTo NextOffset
            Set cell = ws.Cells(blockRow + CLng(off), CLng(c))
            If cell.Interior.Pattern <> xlNone Then
                If rgbSet.Exists(CLng(cell.Interior.Color)) Then cell.Interior.Pattern = xlNone
            End If
NextOffset:
        Next off
    Next c
End Sub

'---------------------------------------------------------------------
' 色帯の行オフセットに、1行上へずらした分を足したもの
'---------------------------------------------------------------------
Private Function WithShifted(offsets As Variant) As Variant
    Dim d As Object, i As Long, res() As Variant, k As Variant, n As Long

    Set d = CreateObject("Scripting.Dictionary")
    For i = LBound(offsets) To UBound(offsets)
        d(CLng(offsets(i))) = True
        d(CLng(offsets(i)) - 1) = True
    Next i

    ReDim res(0 To d.Count - 1)
    For Each k In d.Keys
        res(n) = CLng(k)
        n = n + 1
    Next k
    WithShifted = res
End Function

'=====================================================================
' マスタの読み込み
'=====================================================================
' 工程表の物件ブロックを読む
'   info  : 契約番号 -> FindBlocks の1件分（行 / 邸名 / 契約番号 / タイプ /
'                       基礎業者 / 躯体業者 / 本着日 / お客様納期）
'   order : 契約番号をシートの上から順に並べたもの（＝業者の優先順位）
Private Sub LoadBlocks(ws As Worksheet, ByRef info As Object, ByRef order As Collection)
    Dim blocks As Collection, b As Variant, key As String

    Set info = CreateObject("Scripting.Dictionary")
    Set order = New Collection
    Set blocks = FindBlocks(ws)

    For Each b In blocks
        key = Trim$(CStr(b(2)))
        If Len(key) > 0 Then
            If Not info.Exists(key) Then
                info.Add key, b
                order.Add key
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

    ResetExceptionCache
    Set wsT = ThisWorkbook.Worksheets(SH_TASK)
    Set occupied = CreateObject("Scripting.Dictionary")
    lastRow = wsT.Cells(wsT.Rows.Count, TASK_COL_CONTRACT).End(xlUp).Row

    For k = 1 To TASK_COUNT
        c0 = TaskFirstCol(k)
        For r = 2 To lastRow
            contract = Trim$(CStr(wsT.Cells(r, TASK_COL_CONTRACT).Value))
            colorName = Trim$(CStr(wsT.Cells(r, c0 + TASK_OFS_COLOR).Value))
            If Len(contract) = 0 Or Len(colorName) = 0 Then GoTo NextRow
            If Not IsDate(wsT.Cells(r, c0 + TASK_OFS_START).Value) Then GoTo NextRow
            If Not IsDate(wsT.Cells(r, c0 + TASK_OFS_END).Value) Then GoTo NextRow

            dFrom = CDate(wsT.Cells(r, c0 + TASK_OFS_START).Value)
            dTo = CDate(wsT.Cells(r, c0 + TASK_OFS_END).Value)

            For d = dFrom To dTo
                If Not IsNonWorkingDayFor(contract, d) Then
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
' 工程表から工程の色を消す
'
' M_業者 に登録されている色に一致するセルだけを消す。
' 日祝の黄緑と、マクロが知らない色（手で塗った印など）は残る。
' M_工程データ の日付は消えないので、「工程を作る」で塗り直せる。
'=====================================================================
Public Sub ClearTaskColors()
    Dim ws As Worksheet, cleared As Long

    Set ws = ChartSheet()

    If MsgBox("「" & ws.Name & "」から工程の色をすべて消します。" & vbCrLf & vbCrLf & _
              "消えるもの : " & SH_VENDOR & " に登録されている色" & vbCrLf & _
              "残るもの   : 日祝の黄緑、手で塗った色、" & SH_TASK & " の日付" & vbCrLf & vbCrLf & _
              "元に戻す（Ctrl+Z）は効きません。よろしいですか？", _
              vbYesNo + vbExclamation, "工程の色をクリア") <> vbYes Then Exit Sub

    cleared = ClearTaskColorsCore(ws)

    MsgBox cleared & " セルの色を消しました。" & vbCrLf & vbCrLf & _
           "「ボタン_工程表に色を塗る」で塗り直せます。" & vbCrLf & _
           "日程から作り直したい場合は「ボタン_工程の計算結果をクリア」を先に実行してください。", _
           vbInformation, "工程の色をクリア"
End Sub

'---------------------------------------------------------------------
' 工程の色を消す本体（確認も報告もしない）
'---------------------------------------------------------------------
Private Function ClearTaskColorsCore(ws As Worksheet) As Long
    Dim colorMap As Object, dateMap As Object
    Dim blocks As Collection, b As Variant
    Dim rgbSet As Object, k As Variant, c As Variant
    Dim off As Long, r As Long, cleared As Long
    Dim cell As Range

    Set colorMap = LoadColorMap()
    Set dateMap = BuildDateMap(ws)
    Set blocks = FindBlocks(ws)

    ' 消す対象の RGB を集める（日祝の黄緑は除外する）
    Set rgbSet = CreateObject("Scripting.Dictionary")
    For Each k In colorMap.Keys
        If Not IsHolidayColor(CLng(colorMap(k))) Then rgbSet(CLng(colorMap(k))) = True
    Next k

    If rgbSet.Count = 0 Then Exit Function

    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual

    For Each c In dateMap.Items
        For Each b In blocks
            For off = 0 To BLOCK_ROWS - 1
                r = CLng(b(0)) + off
                Set cell = ws.Cells(r, CLng(c))
                If cell.Interior.Pattern <> xlNone Then
                    If rgbSet.Exists(CLng(cell.Interior.Color)) Then
                        cell.Interior.Pattern = xlNone
                        cleared = cleared + 1
                    End If
                End If
            Next off
        Next b
    Next c

    Application.Calculation = xlCalculationAutomatic
    Application.ScreenUpdating = True

    ClearTaskColorsCore = cleared
End Function

'=====================================================================
' 工程表を塗り直す（消してから塗る）
'
' 実務で使うのはこのボタン。工程の色をいったん全部消してから塗り直すので、
' 日程を変えたあとに古い色が残らない。
' 「色をクリア」「色を塗る」の2つはデバッグ用に残してある。
'=====================================================================
Public Sub RepaintPlan()
    Dim ws As Worksheet, cleared As Long

    If Not PreflightOK() Then Exit Sub

    Set ws = ChartSheet()

    If MsgBox("「" & ws.Name & "」の工程の色を、いったん消してから塗り直します。" & vbCrLf & vbCrLf & _
              "消えるもの : " & SH_VENDOR & " に登録されている色" & vbCrLf & _
              "残るもの   : 日祝の黄緑、手で塗った色" & vbCrLf & vbCrLf & _
              "元に戻す（Ctrl+Z）は効きません。よろしいですか？", _
              vbYesNo + vbQuestion, "工程表を塗り直す") <> vbYes Then Exit Sub

    cleared = ClearTaskColorsCore(ws)
    PaintPlan cleared
End Sub

'=====================================================================
' 選択した行だけ計算結果をクリアする
'
' 雨で日程がずれた行を選んで実行 → 開始日を直して「工程を作る」で計算し直す。
'=====================================================================
Public Sub ClearPlanResultsForSelection()
    Dim wsT As Worksheet, cell As Range, rows As Object
    Dim r As Variant, k As Long, c0 As Long, cnt As Long

    If Not TaskSheetIsCurrent() Then
        MsgBox SH_TASK & " シートが古い形式です。" & vbCrLf & _
               "「ボタン_初期セットアップ」を実行してください。", vbExclamation
        Exit Sub
    End If

    Set wsT = ThisWorkbook.Worksheets(SH_TASK)
    If ActiveSheet.Name <> wsT.Name Then
        MsgBox SH_TASK & " シート上で、対象の行を選択してから実行してください。", vbExclamation
        Exit Sub
    End If

    ' 選択されている行番号を集める
    Set rows = CreateObject("Scripting.Dictionary")
    For Each cell In Selection.Cells
        If cell.Row >= 2 Then
            If Len(Trim$(CStr(wsT.Cells(cell.Row, TASK_COL_CONTRACT).Value))) > 0 Then
                rows(cell.Row) = True
            End If
        End If
    Next cell

    If rows.Count = 0 Then
        MsgBox "契約番号の入っている行が選択されていません。", vbExclamation
        Exit Sub
    End If

    If MsgBox(rows.Count & " 件の物件について、計算結果を消します。" & vbCrLf & vbCrLf & _
              "消すもの : マクロが入れた値（青字の 開始日 / 終了日 / 色名）" & vbCrLf & _
              "残るもの : 手入力した値（黒字）/ 調整 / 備考" & vbCrLf & vbCrLf & _
              "よろしいですか？", vbYesNo + vbQuestion) <> vbYes Then Exit Sub

    For Each r In rows.Keys
        ClearAutoOutputs wsT, CLng(r)
        cnt = cnt + 1
    Next r

    MsgBox cnt & " 件をクリアしました。" & vbCrLf & _
           "開始日を直してから「ボタン_工程を作る」を実行してください。", vbInformation
End Sub

'=====================================================================
' 計算結果をすべてクリアする（割り当てをやり直したいとき）
'
' 開始日は残し、終了日と色名だけ消す。
'=====================================================================
Public Sub ClearPlanResults()
    Dim wsT As Worksheet, r As Long, lastRow As Long
    Dim k As Long, c0 As Long, cnt As Long

    If MsgBox(SH_TASK & " から、計算結果を消します。" & vbCrLf & vbCrLf & _
              "消すもの : マクロが入れた値（青字の 開始日 / 終了日 / 色名）" & vbCrLf & _
              "残るもの : 手入力した値（黒字）/ 調整 / 備考" & vbCrLf & vbCrLf & _
              "よろしいですか？", vbYesNo + vbQuestion) <> vbYes Then Exit Sub

    Set wsT = ThisWorkbook.Worksheets(SH_TASK)
    lastRow = wsT.Cells(wsT.Rows.Count, TASK_COL_CONTRACT).End(xlUp).Row

    For r = 2 To lastRow
        If Len(Trim$(CStr(wsT.Cells(r, TASK_COL_CONTRACT).Value))) > 0 Then
            cnt = cnt + ClearAutoOutputs(wsT, r)
        End If
    Next r

    MsgBox cnt & " 箇所をクリアしました。" & vbCrLf & _
           "「ボタン_工程を作る」で計算し直せます。", vbInformation
End Sub

'---------------------------------------------------------------------
' その行の「マクロが入れた値」だけ消す（手入力は残す）
'
' 戻り値は消したセル数。
'---------------------------------------------------------------------
Private Function ClearAutoOutputs(wsT As Worksheet, r As Long) As Long
    Dim k As Long, c0 As Long, cnt As Long

    For k = 1 To TASK_COUNT
        c0 = TaskFirstCol(k)
        If ClearIfAuto(wsT.Cells(r, c0 + TASK_OFS_START)) Then cnt = cnt + 1
        If ClearIfAuto(wsT.Cells(r, c0 + TASK_OFS_END)) Then cnt = cnt + 1
        If ClearIfAuto(wsT.Cells(r, c0 + TASK_OFS_COLOR)) Then cnt = cnt + 1
    Next k

    ClearAutoOutputs = cnt
End Function

'=====================================================================
' 選択した行と、その影響を受ける行を計算し直す
'
' あとから調整を入れたときに使う。選んだ物件と、
' 「同じ業者を使っていて、工程表で下にある物件」をまとめて計算し直す。
' 業者は前の現場が終わってから次に移るので、影響が出るのはこの範囲だけ。
'
' 手入力（黒字）の値は消さないので、人が決めた日程は残る。
'=====================================================================
Public Sub RecalcFromSelection()
    Dim wsT As Worksheet, ws As Worksheet
    Dim cell As Range, picked As Object, target As Object
    Dim info As Object, order As Collection, taskRow As Object
    Dim idx As Object, key As Variant, contract As String
    Dim k As Long, i As Long, n As Long
    Dim v As Variant, vendorName As String
    Dim pickedVendors As Object
    Dim listMsg As String, cleared As Long

    If Not PreflightOK() Then Exit Sub

    Set wsT = ThisWorkbook.Worksheets(SH_TASK)
    If ActiveSheet.Name <> wsT.Name Then
        MsgBox SH_TASK & " シート上で、計算し直したい行を選択してから実行してください。", _
               vbExclamation, "選択行と後続を再計算"
        Exit Sub
    End If

    ' 選択されている契約番号を集める
    Set picked = CreateObject("Scripting.Dictionary")
    For Each cell In Selection.Cells
        If cell.Row >= 2 Then
            contract = Trim$(CStr(wsT.Cells(cell.Row, TASK_COL_CONTRACT).Value))
            If Len(contract) > 0 Then picked(contract) = True
        End If
    Next cell

    If picked.Count = 0 Then
        MsgBox "契約番号の入っている行が選択されていません。", vbExclamation
        Exit Sub
    End If

    Set ws = ChartSheet()
    LoadBlocks ws, info, order
    Set taskRow = BuildTaskRowMap(wsT)

    ' 工程表の並び順（＝業者の優先順位）での位置
    Set idx = CreateObject("Scripting.Dictionary")
    i = 0
    For Each key In order
        idx(CStr(key)) = i
        i = i + 1
    Next key

    Set target = CreateObject("Scripting.Dictionary")

    For k = 1 To TASK_COUNT
        ' 選んだ物件が使っている業者を集める
        Set pickedVendors = CreateObject("Scripting.Dictionary")
        For Each key In picked.Keys
            contract = CStr(key)
            If info.Exists(contract) Then
                v = info(contract)
                vendorName = NormalizeName(CStr(v(IIf(k = 1, 4, 5))))
                If Len(vendorName) > 0 Then
                    pickedVendors(vendorName) = idx(contract)
                    target(contract) = True
                End If
            End If
        Next key

        ' 同じ業者で、選んだ物件より下にある物件も対象にする
        For Each key In order
            contract = CStr(key)
            If Not target.Exists(contract) Then
                v = info(contract)
                vendorName = NormalizeName(CStr(v(IIf(k = 1, 4, 5))))
                If pickedVendors.Exists(vendorName) Then
                    If CLng(idx(contract)) > CLng(pickedVendors(vendorName)) Then
                        target(contract) = True
                    End If
                End If
            End If
        Next key
    Next k

    ' 対象の一覧を作る（工程表の並び順）
    For Each key In order
        contract = CStr(key)
        If target.Exists(contract) Then
            n = n + 1
            If n <= 15 Then
                listMsg = listMsg & "  " & InfoName(info, contract) & _
                          IIf(picked.Exists(contract), "  ← 選択", "") & vbCrLf
            End If
        End If
    Next key
    If n > 15 Then listMsg = listMsg & "  ... 他 " & (n - 15) & " 件" & vbCrLf

    If MsgBox(n & " 件を計算し直します。" & vbCrLf & vbCrLf & _
              listMsg & vbCrLf & _
              "選んだ物件と、同じ業者を使っていて工程表で下にある物件が対象です。" & vbCrLf & vbCrLf & _
              "消すもの : マクロが入れた値（青字）" & vbCrLf & _
              "残るもの : 手入力した値（黒字）/ 調整 / 備考" & vbCrLf & vbCrLf & _
              "よろしいですか？", vbYesNo + vbQuestion, "選択行と後続を再計算") <> vbYes Then Exit Sub

    Application.ScreenUpdating = False
    For Each key In target.Keys
        contract = CStr(key)
        If taskRow.Exists(contract) Then
            cleared = cleared + ClearAutoOutputs(wsT, CLng(taskRow(contract)))
        End If
    Next key
    Application.ScreenUpdating = True

    ' そのまま計算する。青字は毎回決め直すので、対象外の物件は結果が変わらない。
    CalculatePlan
End Sub
