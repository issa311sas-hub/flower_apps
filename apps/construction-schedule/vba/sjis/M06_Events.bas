Attribute VB_Name = "M06_Events"
Option Explicit

'=====================================================================
' M06_Events : 工程表にイベント名を書く
'
' 工程表は色を塗るだけでなく、イベントを文字でも書き込む。
' M0～M5 / 家具搬入 / CL / クリーンハウス / 2W の10種類。
'
' 書き込む位置
'   行 … その物件のブロック（邸名の行から6行）のうち、イベントごとに決まった行
'         「上から2マス目」= ブロック先頭 +1、「上から6マス目」= ブロック先頭 +5
'   列 … 入力された日付の列
'
' 書式もイベントごとに決まっている（文字色・縦書き / 横書き）。
' 「2W」だけは、そのセルの塗りつぶしを消す。
'
' どの物件かはカーソルの位置（行）で判定する。
' 工程表の上で、対象の物件の行にカーソルを置いてからボタンを押す。
'
' 何度実行しても同じ結果になる（冪等）。
' 同じイベントを入れ直すと、前に書いた場所は消えて新しい場所に書かれる。
'=====================================================================

' イベントの数
Public Const EVENT_COUNT As Long = 10

' 文字色
Private Const CLR_EVENT_BLACK As Long = 0          ' RGB(0, 0, 0)
Private Const CLR_EVENT_RED   As Long = 255        ' RGB(255, 0, 0)

'---------------------------------------------------------------------
' イベントの定義
'
' 戻り値 : Array(名前, 行オフセット, 文字色, 縦書きか, 塗りつぶしを消すか)
'
'   行オフセットは物件ブロックの先頭からの位置（0 始まり）。
'   「上から2マス目」= 1、「上から6マス目」= 5。
'---------------------------------------------------------------------
Public Function EventDef(i As Long) As Variant
    Select Case i
        Case 1:  EventDef = Array("M0", OFS_KISO_SUB, CLR_EVENT_BLACK, False, False)
        Case 2:  EventDef = Array("M1", OFS_KISO_SUB, CLR_EVENT_BLACK, False, False)
        Case 3:  EventDef = Array("M2", OFS_KUTAI_SUB, CLR_EVENT_BLACK, False, False)
        Case 4:  EventDef = Array("M3", OFS_KUTAI_SUB, CLR_EVENT_BLACK, False, False)
        Case 5:  EventDef = Array("M4", OFS_KUTAI_SUB, CLR_EVENT_BLACK, False, False)
        Case 6:  EventDef = Array("M5", OFS_KUTAI_SUB, CLR_EVENT_BLACK, False, False)
        Case 7:  EventDef = Array("家具搬入", OFS_KUTAI_SUB, CLR_EVENT_RED, True, False)
        Case 8:  EventDef = Array("CL", OFS_KUTAI_SUB, CLR_EVENT_RED, True, False)
        Case 9:  EventDef = Array("クリーンハウス", OFS_KUTAI_SUB, CLR_EVENT_BLACK, True, False)
        Case 10: EventDef = Array("2W", OFS_KUTAI_SUB, CLR_EVENT_RED, False, True)
    End Select
End Function

Public Function EventName(i As Long) As String
    Dim v As Variant
    v = EventDef(i)
    EventName = CStr(v(0))
End Function

'=====================================================================
' メイン : イベントを入力する
'
' カーソルのある物件について、10個のイベントの日付を順に聞く。
' 空欄のままEnterを押せばそのイベントは飛ばす（すでに書いてあれば消さない）。
' 「-」を入れるとそのイベントを消す。
'=====================================================================
Public Sub InputEvents()
    Dim ws As Worksheet, dateMap As Object, colMap As Object
    Dim blocks As Collection, b As Variant
    Dim blockTop As Long, nm As String
    Dim i As Long, ans As String
    Dim cur As Variant, defaultText As String
    Dim entered As Object, removed As Object
    Dim d As Date, msg As String
    Dim wrote As Long, cleared As Long, outOfRange As String

    On Error GoTo Fail

    Set ws = ChartSheet()
    If ActiveSheet.Name <> ws.Name Then
        MsgBox "工程表シート「" & ws.Name & "」の上で、" & vbCrLf & _
               "対象の物件の行にカーソルを置いてから実行してください。", _
               vbExclamation, "イベントを入力"
        Exit Sub
    End If

    Set blocks = FindBlocks(ws)
    blockTop = BlockTopFromRow(blocks, Selection.Row, nm)

    If blockTop = 0 Then
        MsgBox "カーソルの行から物件を特定できませんでした。" & vbCrLf & vbCrLf & _
               "邸名の行から6行がその物件の範囲です。" & vbCrLf & _
               "その範囲にカーソルを置いてから実行してください。", _
               vbExclamation, "イベントを入力"
        Exit Sub
    End If

    Set dateMap = BuildDateMap(ws)
    Set colMap = BuildColMap(ws)

    Set entered = CreateObject("Scripting.Dictionary")
    Set removed = CreateObject("Scripting.Dictionary")

    ' --- 10個ぶん順に聞く ------------------------------------------
    For i = 1 To EVENT_COUNT
        cur = FindEventDate(ws, blockTop, i, colMap)
        If IsDate(cur) Then
            defaultText = Format$(cur, "yyyy/mm/dd")
        Else
            defaultText = ""
        End If

        ans = InputBox( _
              nm & vbCrLf & vbCrLf & _
              "【" & EventName(i) & "】の日付を入力してください。" & _
              "  (" & i & "/" & EVENT_COUNT & ")" & vbCrLf & vbCrLf & _
              "  空欄のまま OK … 変更しない" & vbCrLf & _
              "  「-」を入力   … このイベントを消す" & vbCrLf & _
              "  キャンセル     … 入力をやめる（ここまでの分は書き込まない）", _
              "イベントを入力 － " & EventName(i), defaultText)

        ' キャンセルは空文字を返す。既定値のままOKでも同じ文字が返るため、
        ' 「キャンセルされたか」は StrPtr で判定する。
        If StrPtr(ans) = 0 Then Exit Sub

        ans = Trim$(ans)
        If ans = "-" Then
            removed(i) = True
        ElseIf Len(ans) > 0 Then
            If Not IsDate(ans) Then
                MsgBox "「" & ans & "」を日付として読めませんでした。" & vbCrLf & _
                       EventName(i) & " は変更しません。", vbExclamation
            Else
                d = CDate(ans)
                If Not dateMap.Exists(CLng(d)) Then
                    outOfRange = outOfRange & "  " & EventName(i) & " : " & _
                                 Format$(d, "yyyy/mm/dd") & vbCrLf
                Else
                    entered(i) = d
                End If
            End If
        End If
    Next i

    If entered.Count = 0 And removed.Count = 0 Then
        If Len(outOfRange) > 0 Then
            MsgBox "工程表の表示期間の外だったため、書き込めませんでした。" & vbCrLf & vbCrLf & _
                   outOfRange, vbExclamation, "イベントを入力"
        Else
            MsgBox "入力がなかったので、何も変更していません。", vbInformation, "イベントを入力"
        End If
        Exit Sub
    End If

    ' --- 確認 -------------------------------------------------------
    msg = nm & " のイベントを書き込みます。" & vbCrLf & vbCrLf
    For i = 1 To EVENT_COUNT
        If entered.Exists(i) Then
            msg = msg & "  " & EventName(i) & " : " & Format$(entered(i), "yyyy/mm/dd") & vbCrLf
        ElseIf removed.Exists(i) Then
            msg = msg & "  " & EventName(i) & " : 消す" & vbCrLf
        End If
    Next i
    If Len(outOfRange) > 0 Then
        msg = msg & vbCrLf & "※ 次のイベントは工程表の表示期間の外なので書き込めません。" & vbCrLf & _
              outOfRange
    End If
    msg = msg & vbCrLf & "よろしいですか？"

    If MsgBox(msg, vbYesNo + vbQuestion, "イベントを入力") <> vbYes Then Exit Sub

    ' --- 書き込む ---------------------------------------------------
    Application.ScreenUpdating = False

    For i = 1 To EVENT_COUNT
        If entered.Exists(i) Or removed.Exists(i) Then
            ' 同じイベントが別の日に書いてあれば、まず消す
            cleared = cleared + ClearEvent(ws, blockTop, i, colMap)
        End If
        If entered.Exists(i) Then
            WriteEvent ws, blockTop, i, CLng(dateMap(CLng(CDate(entered(i)))))
            wrote = wrote + 1
        End If
    Next i

    Application.ScreenUpdating = True

    MsgBox nm & vbCrLf & vbCrLf & _
           "書き込み : " & wrote & " 件" & vbCrLf & _
           "消した   : " & cleared & " 件", _
           vbInformation, "イベントを入力"
    Exit Sub

Fail:
    Application.ScreenUpdating = True
    MsgBox "エラーが発生しました: " & Err.Description, vbCritical, "イベントを入力"
End Sub

'=====================================================================
' カーソルのある物件のイベントを一覧表示する
'=====================================================================
Public Sub ShowEvents()
    Dim ws As Worksheet, colMap As Object
    Dim blocks As Collection
    Dim blockTop As Long, nm As String
    Dim i As Long, msg As String, cur As Variant, cnt As Long

    On Error GoTo Fail

    Set ws = ChartSheet()
    If ActiveSheet.Name <> ws.Name Then
        MsgBox "工程表シートの上で実行してください。", vbExclamation
        Exit Sub
    End If

    Set blocks = FindBlocks(ws)
    blockTop = BlockTopFromRow(blocks, Selection.Row, nm)
    If blockTop = 0 Then
        MsgBox "カーソルの行から物件を特定できませんでした。", vbExclamation
        Exit Sub
    End If

    Set colMap = BuildColMap(ws)

    For i = 1 To EVENT_COUNT
        cur = FindEventDate(ws, blockTop, i, colMap)
        If IsDate(cur) Then
            msg = msg & "  " & Left$(EventName(i) & String$(8, " "), 8) & _
                  Format$(cur, "yyyy/mm/dd (aaa)") & vbCrLf
            cnt = cnt + 1
        End If
    Next i

    If cnt = 0 Then msg = "  （まだ何も書かれていません）" & vbCrLf

    MsgBox nm & " のイベント" & vbCrLf & vbCrLf & msg, vbInformation, "イベント一覧"
    Exit Sub

Fail:
    MsgBox "エラーが発生しました: " & Err.Description, vbCritical
End Sub

'=====================================================================
' カーソルのある物件のイベントをすべて消す
'=====================================================================
Public Sub ClearEventsForProperty()
    Dim ws As Worksheet, colMap As Object
    Dim blocks As Collection
    Dim blockTop As Long, nm As String
    Dim i As Long, cleared As Long

    On Error GoTo Fail

    Set ws = ChartSheet()
    If ActiveSheet.Name <> ws.Name Then
        MsgBox "工程表シートの上で実行してください。", vbExclamation
        Exit Sub
    End If

    Set blocks = FindBlocks(ws)
    blockTop = BlockTopFromRow(blocks, Selection.Row, nm)
    If blockTop = 0 Then
        MsgBox "カーソルの行から物件を特定できませんでした。", vbExclamation
        Exit Sub
    End If

    If MsgBox(nm & " のイベント文字をすべて消します。" & vbCrLf & vbCrLf & _
              "消えるもの : M0～M5 / 家具搬入 / CL / クリーンハウス / 2W" & vbCrLf & _
              "残るもの   : 色の塗りつぶし、その他の文字" & vbCrLf & vbCrLf & _
              "よろしいですか？", vbYesNo + vbExclamation, "イベントをクリア") <> vbYes Then Exit Sub

    Set colMap = BuildColMap(ws)

    For i = 1 To EVENT_COUNT
        cleared = cleared + ClearEvent(ws, blockTop, i, colMap)
    Next i

    MsgBox cleared & " 件のイベントを消しました。", vbInformation, "イベントをクリア"
    Exit Sub

Fail:
    MsgBox "エラーが発生しました: " & Err.Description, vbCritical
End Sub

'=====================================================================
' 書き込み・削除・検索
'=====================================================================

'---------------------------------------------------------------------
' イベントを1件書き込む
'---------------------------------------------------------------------
Private Sub WriteEvent(ws As Worksheet, blockTop As Long, i As Long, col As Long)
    Dim v As Variant, cell As Range

    v = EventDef(i)
    Set cell = ws.Cells(blockTop + CLng(v(1)), col)

    cell.Value = CStr(v(0))
    cell.Font.Color = CLng(v(2))

    If CBool(v(3)) Then
        cell.Orientation = xlVertical      ' 縦書き
    Else
        cell.Orientation = 0               ' 横書き
    End If

    cell.HorizontalAlignment = xlCenter
    cell.VerticalAlignment = xlCenter

    ' 「2W」は塗りつぶしを消す
    If CBool(v(4)) Then cell.Interior.Pattern = xlNone
End Sub

'---------------------------------------------------------------------
' その物件に書かれている、そのイベントを消す
'
' 戻り値 : 消した件数
'---------------------------------------------------------------------
Private Function ClearEvent(ws As Worksheet, blockTop As Long, i As Long, _
                            colMap As Object) As Long
    Dim v As Variant, c As Variant, cell As Range
    Dim nm As String, cnt As Long

    v = EventDef(i)
    nm = CStr(v(0))

    For Each c In colMap.Keys
        Set cell = ws.Cells(blockTop + CLng(v(1)), CLng(c))
        If Trim$(CStr(cell.Value)) = nm Then
            cell.ClearContents
            cell.Orientation = 0
            cnt = cnt + 1
        End If
    Next c

    ClearEvent = cnt
End Function

'---------------------------------------------------------------------
' その物件に書かれている、そのイベントの日付を返す（無ければ Empty）
'---------------------------------------------------------------------
Private Function FindEventDate(ws As Worksheet, blockTop As Long, i As Long, _
                               colMap As Object) As Variant
    Dim v As Variant, c As Variant
    Dim nm As String

    v = EventDef(i)
    nm = CStr(v(0))

    For Each c In colMap.Keys
        If Trim$(CStr(ws.Cells(blockTop + CLng(v(1)), CLng(c)).Value)) = nm Then
            FindEventDate = colMap(c)
            Exit Function
        End If
    Next c
End Function

'---------------------------------------------------------------------
' 行番号から、その行が属する物件ブロックの先頭行を返す
'
' 邸名の行から6行がその物件の範囲。どれにも入らなければ 0 を返す。
'---------------------------------------------------------------------
Public Function BlockTopFromRow(blocks As Collection, r As Long, _
                                ByRef propName As String) As Long
    Dim b As Variant, top As Long

    For Each b In blocks
        top = CLng(b(0))
        If r >= top And r < top + BLOCK_ROWS Then
            propName = CStr(b(1))
            BlockTopFromRow = top
            Exit Function
        End If
    Next b
End Function

'=====================================================================
' 色を塗り直したあとの後始末
'
' 「2W」のセルは塗りつぶし無しでなければならないが、
' 日祝や工程の色を塗ると上から塗られてしまう。
' 色を塗ったあとにこれを呼んで、塗りつぶしを消し直す。
'
' 戻り値 : 直したセル数
'=====================================================================
Public Function ApplyEventFills(ws As Worksheet, order As Collection, _
                                info As Object) As Long
    Dim key As Variant, v As Variant, def As Variant
    Dim colMap As Object, c As Variant, cell As Range
    Dim i As Long, cnt As Long, blockTop As Long

    Set colMap = BuildColMap(ws)

    For i = 1 To EVENT_COUNT
        def = EventDef(i)
        If CBool(def(4)) Then
            For Each key In order
                v = info(CStr(key))
                blockTop = CLng(v(0))
                For Each c In colMap.Keys
                    Set cell = ws.Cells(blockTop + CLng(def(1)), CLng(c))
                    If Trim$(CStr(cell.Value)) = CStr(def(0)) Then
                        If cell.Interior.Pattern <> xlNone Then
                            cell.Interior.Pattern = xlNone
                            cnt = cnt + 1
                        End If
                    End If
                Next c
            Next key
        End If
    Next i

    ApplyEventFills = cnt
End Function
