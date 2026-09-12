Attribute VB_Name = "M06_Events"
Option Explicit

'=====================================================================
' M06_Events : 工程表にイベント名を書く
'
' 工程表は色を塗るだけでなく、イベントを文字でも書き込む。
' M0～M5 / 家具搬入 / CL / クリーンハウス / 2W の10種類。
'
' ■ 入力は1画面
' 10個の入力欄をまとめて出す。「イベント入力」シートが開くので、
' 日付を入れて「書き込む」を押す。入力が終わるとシートは消える。
' ユーザーフォーム F_イベント入力 がブックにあれば、そちらを使う。
'
' ■ 書き込む位置
'   行 … その物件のブロック（邸名の行から6行）のうち、イベントごとに決まった行
'   列 … 入力された日付の列
'
' 「上から◯マス目」は物件の6行のなかの位置（1 始まり）。
'
'   M0 / M1              上から5マス目          黒・横書き
'   M2 / M3 / M4 / M5    上から2マス目          黒・横書き
'   家具搬入             上から2～3マス目を結合  赤・太字・縦書き
'   CL                   上から2～3マス目を結合  赤・縦書き
'   クリーンハウス       上から1～3マス目を結合  黒・縦書き
'   2W                   上から2マス目          赤・横書き・塗りつぶしなし
'
' ■ 結合されたセルの扱い
' 工程表は 3～4マス目 と 5～6マス目 が結合されていることがある。
' 結合されたセルは左上にしか文字が入らないため、
' 書き込み・読み取りとも MergeArea の左上に読み替える。
' 複数マスにまたがるイベントは、必要なら結合してから書く。
'
' どの物件かはカーソルの位置（行）で判定する。
'
' 何度実行しても同じ結果になる（冪等）。
' 同じイベントを入れ直すと、前に書いた場所は消えて新しい場所に書かれる。
'=====================================================================

' イベントの数
Public Const EVENT_COUNT As Long = 10

' 1画面で入力するユーザーフォームの名前（任意）
' このフォームがブックにあればフォームを、無ければ入力シートを使う。
' 作り方は vba/userform/F_イベント入力.txt を参照。
Public Const EVENT_FORM_NAME As String = "F_イベント入力"

' --- 入力シートの座標 -----------------------------------------------
Private Const EVS_ROW_FIRST As Long = 4    ' 1件目の行
Private Const EVS_COL_NAME  As Long = 2    ' B列 : イベント名
Private Const EVS_COL_DATE  As Long = 3    ' C列 : 日付（入力）
Private Const EVS_COL_NOTE  As Long = 4    ' D列 : 説明
Private Const EVS_COL_KEEP  As Long = 8    ' H列 : 対象の記憶（非表示）

' --- 文字色 ---------------------------------------------------------
Private Const CLR_EVENT_BLACK As Long = 0          ' RGB(0, 0, 0)
Private Const CLR_EVENT_RED   As Long = 255        ' RGB(255, 0, 0)

' --- フォームとのやり取り -------------------------------------------
' フォームは部品の配置だけを持ち、値はここを通してやり取りする。
Private mFormTitle As String
Private mFormHeader As String
Private mFormDefault(1 To EVENT_COUNT) As String
Private mFormResult(1 To EVENT_COUNT) As String
Private mFormOK As Boolean

'---------------------------------------------------------------------
' イベントの定義
'
' 戻り値 : Array(名前, 行オフセット, 行数, 文字色, 太字, 縦書き, 塗りを消す)
'
'   行オフセット … 物件ブロックの先頭からの位置（0 始まり）
'                   「上から2マス目」= 1、「上から5マス目」= 4
'   行数         … 縦にいくつのマスを使うか。2以上なら結合して書く
'---------------------------------------------------------------------
Public Function EventDef(i As Long) As Variant
    Select Case i
        Case 1:  EventDef = Array("M0", 4, 1, CLR_EVENT_BLACK, False, False, False)
        Case 2:  EventDef = Array("M1", 4, 1, CLR_EVENT_BLACK, False, False, False)
        Case 3:  EventDef = Array("M2", 1, 1, CLR_EVENT_BLACK, False, False, False)
        Case 4:  EventDef = Array("M3", 1, 1, CLR_EVENT_BLACK, False, False, False)
        Case 5:  EventDef = Array("M4", 1, 1, CLR_EVENT_BLACK, False, False, False)
        Case 6:  EventDef = Array("M5", 1, 1, CLR_EVENT_BLACK, False, False, False)
        Case 7:  EventDef = Array("家具搬入", 1, 2, CLR_EVENT_RED, True, True, False)
        Case 8:  EventDef = Array("CL", 1, 2, CLR_EVENT_RED, False, True, False)
        Case 9:  EventDef = Array("クリーンハウス", 0, 3, CLR_EVENT_BLACK, False, True, False)
        Case 10: EventDef = Array("2W", 1, 1, CLR_EVENT_RED, False, False, True)
    End Select
End Function

Public Function EventName(i As Long) As String
    Dim v As Variant
    v = EventDef(i)
    EventName = CStr(v(0))
End Function

'---------------------------------------------------------------------
' 書き込む場所の説明（入力シートに出す）
'---------------------------------------------------------------------
Private Function EventWhere(i As Long) As String
    Dim v As Variant, s As String
    v = EventDef(i)

    If CLng(v(2)) > 1 Then
        s = "上から " & (CLng(v(1)) + 1) & "～" & (CLng(v(1)) + CLng(v(2))) & " マス目（結合）"
    Else
        s = "上から " & (CLng(v(1)) + 1) & " マス目"
    End If

    s = s & " / " & IIf(CLng(v(3)) = CLR_EVENT_RED, "赤", "黒")
    If CBool(v(4)) Then s = s & "太字"
    s = s & IIf(CBool(v(5)), "・縦書き", "・横書き")
    If CBool(v(6)) Then s = s & "・塗りつぶしなし"

    EventWhere = s
End Function

'=====================================================================
' メイン : イベントを入力する
'
' フォームがあればフォームで、無ければ入力シートで、10個まとめて入力する。
'=====================================================================
Public Sub InputEvents()
    Dim ws As Worksheet, colMap As Object
    Dim blocks As Collection
    Dim blockTop As Long, nm As String
    Dim i As Long, cur As Variant

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

    ' --- いま書かれている日付を初期値にする -------------------------
    Set colMap = BuildColMap(ws)
    For i = 1 To EVENT_COUNT
        cur = FindEventDate(ws, blockTop, i, colMap)
        If IsDate(cur) Then
            mFormDefault(i) = Format$(cur, "yyyy/mm/dd")
        Else
            mFormDefault(i) = ""
        End If
        mFormResult(i) = ""
    Next i

    mFormTitle = "イベントを入力 － " & nm
    mFormHeader = nm & vbCrLf & _
                  "日付を入れると書き込みます。空欄にするとそのイベントを消します。" & vbCrLf & _
                  "（画面のとおりに工程表へ反映されます）"

    ' --- フォームがあればフォーム、無ければ入力シート ---------------
    If ShowEventForm() Then
        If Not mFormOK Then Exit Sub
        ApplyEvents ws, blockTop, nm
    Else
        OpenEventSheet ws, blockTop, nm
    End If
    Exit Sub

Fail:
    Application.ScreenUpdating = True
    MsgBox "エラーが発生しました: " & Err.Description, vbCritical, "イベントを入力"
End Sub

'---------------------------------------------------------------------
' 入力された内容を工程表に反映する
'
' mFormResult に入力結果、mFormDefault に元の値が入っている前提。
'---------------------------------------------------------------------
Private Sub ApplyEvents(ws As Worksheet, blockTop As Long, nm As String)
    Dim dateMap As Object, colMap As Object
    Dim entered As Object, removed As Object
    Dim i As Long, t As String, d As Date
    Dim ng As String, msg As String
    Dim wrote As Long, cleared As Long

    Set dateMap = BuildDateMap(ws)
    Set colMap = BuildColMap(ws)
    Set entered = CreateObject("Scripting.Dictionary")
    Set removed = CreateObject("Scripting.Dictionary")

    For i = 1 To EVENT_COUNT
        t = Trim$(mFormResult(i))

        If Len(t) = 0 Then
            ' もともと何か書いてあったときだけ「消す」
            If Len(mFormDefault(i)) > 0 Then removed(i) = True
        ElseIf t = mFormDefault(i) Then
            ' 変わっていない。触らない
        ElseIf Not IsDate(t) Then
            ng = ng & "  " & EventName(i) & " : 「" & t & "」は日付として読めません" & vbCrLf
        Else
            d = CDate(t)
            If Not dateMap.Exists(CLng(d)) Then
                ng = ng & "  " & EventName(i) & " : " & Format$(d, "yyyy/mm/dd") & _
                     " は工程表の表示期間の外です" & vbCrLf
            Else
                entered(i) = d
            End If
        End If
    Next i

    If entered.Count = 0 And removed.Count = 0 Then
        If Len(ng) > 0 Then
            MsgBox "書き込めませんでした。" & vbCrLf & vbCrLf & ng, vbExclamation, "イベントを入力"
        Else
            MsgBox "変更はありませんでした。", vbInformation, "イベントを入力"
        End If
        Exit Sub
    End If

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

    msg = nm & vbCrLf & vbCrLf & _
          "書き込み : " & wrote & " 件" & vbCrLf & _
          "消した   : " & cleared & " 件"
    If Len(ng) > 0 Then msg = msg & vbCrLf & vbCrLf & "※ 次は書き込めませんでした。" & vbCrLf & ng

    MsgBox msg, vbInformation, "イベントを入力"
End Sub

'=====================================================================
' 入力シート（フォームが無いときの1画面入力）
'
' シートに10行の入力欄とボタンを作る。書き込む／やめる を押すと
' EventSheetOK / EventSheetCancel が呼ばれ、シートは消える。
'
' どの物件が対象かは、シートの H 列（非表示）に覚えさせる。
' マクロが一度終わってもボタンから続きを実行できるようにするため。
'=====================================================================
Private Sub OpenEventSheet(ws As Worksheet, blockTop As Long, nm As String)
    Dim wsE As Worksheet, i As Long, r As Long
    Dim v As Variant

    Application.ScreenUpdating = False
    Application.DisplayAlerts = False

    ' 前回の入力シートが残っていれば作り直す（隠れているものも消す）
    On Error Resume Next
    ThisWorkbook.Worksheets(SH_EVENT_INPUT).Visible = xlSheetVisible
    ThisWorkbook.Worksheets(SH_EVENT_INPUT).Delete
    On Error GoTo 0

    Set wsE = ThisWorkbook.Worksheets.Add(After:=ws)
    wsE.Name = SH_EVENT_INPUT

    ' --- 見出し -----------------------------------------------------
    With wsE.Range("B1")
        .Value = "イベントを入力 － " & nm
        .Font.Bold = True
        .Font.Size = 14
    End With
    wsE.Range("B2").Value = "日付を入れて「書き込む」を押してください。" & _
                            "空欄にするとそのイベントを消します。"

    wsE.Cells(EVS_ROW_FIRST - 1, EVS_COL_NAME).Value = "イベント"
    wsE.Cells(EVS_ROW_FIRST - 1, EVS_COL_DATE).Value = "日付"
    wsE.Cells(EVS_ROW_FIRST - 1, EVS_COL_NOTE).Value = "書き込む場所と書式"
    With wsE.Range(wsE.Cells(EVS_ROW_FIRST - 1, EVS_COL_NAME), _
                   wsE.Cells(EVS_ROW_FIRST - 1, EVS_COL_NOTE))
        .Font.Bold = True
        .Interior.Color = RGB(217, 217, 217)
    End With

    ' --- 10行 -------------------------------------------------------
    For i = 1 To EVENT_COUNT
        r = EVS_ROW_FIRST + i - 1
        v = EventDef(i)

        wsE.Cells(r, EVS_COL_NAME).Value = CStr(v(0))
        wsE.Cells(r, EVS_COL_NAME).Font.Bold = True

        With wsE.Cells(r, EVS_COL_DATE)
            .NumberFormatLocal = "yyyy/mm/dd"
            If Len(mFormDefault(i)) > 0 Then .Value = CDate(mFormDefault(i))
            .Interior.Color = RGB(255, 255, 204)
            .HorizontalAlignment = xlCenter
        End With

        wsE.Cells(r, EVS_COL_NOTE).Value = EventWhere(i)
        wsE.Cells(r, EVS_COL_NOTE).Font.Color = RGB(128, 128, 128)
    Next i

    ' --- 対象を覚えておく（非表示） ---------------------------------
    wsE.Cells(1, EVS_COL_KEEP).Value = ws.Name
    wsE.Cells(2, EVS_COL_KEEP).Value = blockTop
    wsE.Cells(3, EVS_COL_KEEP).Value = nm
    wsE.Columns(EVS_COL_KEEP).Hidden = True

    wsE.Columns("B:B").ColumnWidth = 16
    wsE.Columns("C:C").ColumnWidth = 14
    wsE.Columns("D:D").ColumnWidth = 38

    AddSheetButton wsE, "書き込む", "EventSheetOK", 0
    AddSheetButton wsE, "やめる", "EventSheetCancel", 1

    Application.DisplayAlerts = True
    Application.ScreenUpdating = True

    wsE.Activate
    wsE.Cells(EVS_ROW_FIRST, EVS_COL_DATE).Select
End Sub

'---------------------------------------------------------------------
' 入力シートにボタンを置く
'---------------------------------------------------------------------
Private Sub AddSheetButton(wsE As Worksheet, caption As String, _
                           macroName As String, index As Long)
    Dim shp As Shape
    Dim topPos As Single

    topPos = wsE.Cells(EVS_ROW_FIRST + EVENT_COUNT + 1, EVS_COL_NAME).Top + 4

    Set shp = wsE.Shapes.AddFormControl(xlButtonControl, _
              wsE.Cells(EVS_ROW_FIRST + EVENT_COUNT + 1, EVS_COL_NAME).Left + index * 96, _
              topPos, 88, 30)
    shp.OnAction = macroName
    shp.TextFrame.Characters.Text = caption
End Sub

'---------------------------------------------------------------------
' 入力シートの「書き込む」ボタン
'---------------------------------------------------------------------
Public Sub EventSheetOK()
    Dim wsE As Worksheet, ws As Worksheet
    Dim blockTop As Long, nm As String
    Dim i As Long, r As Long, v As Variant

    On Error GoTo Fail

    If Not SheetExists(SH_EVENT_INPUT) Then
        MsgBox "入力シートが見つかりません。", vbExclamation
        Exit Sub
    End If
    Set wsE = ThisWorkbook.Worksheets(SH_EVENT_INPUT)

    Set ws = ThisWorkbook.Worksheets(CStr(wsE.Cells(1, EVS_COL_KEEP).Value))
    blockTop = CLng(wsE.Cells(2, EVS_COL_KEEP).Value)
    nm = CStr(wsE.Cells(3, EVS_COL_KEEP).Value)

    ' 入力欄を読む。元の値は、いま工程表に書かれているものを読み直す。
    Dim colMap As Object, cur As Variant
    Set colMap = BuildColMap(ws)

    For i = 1 To EVENT_COUNT
        r = EVS_ROW_FIRST + i - 1
        v = wsE.Cells(r, EVS_COL_DATE).Value

        If IsDate(v) Then
            mFormResult(i) = Format$(CDate(v), "yyyy/mm/dd")
        Else
            mFormResult(i) = Trim$(CStr(v))
        End If

        cur = FindEventDate(ws, blockTop, i, colMap)
        If IsDate(cur) Then
            mFormDefault(i) = Format$(cur, "yyyy/mm/dd")
        Else
            mFormDefault(i) = ""
        End If
    Next i

    ' 先に工程表へ戻してから書き込み、最後に入力シートを片づける。
    ' ボタンのマクロの中でシートを消すため、消すのは一番最後にする。
    ws.Activate
    ApplyEvents ws, blockTop, nm
    CloseEventSheet
    Exit Sub

Fail:
    Application.ScreenUpdating = True
    Application.DisplayAlerts = True
    MsgBox "エラーが発生しました: " & Err.Description, vbCritical, "イベントを入力"
End Sub

'---------------------------------------------------------------------
' 入力シートの「やめる」ボタン
'---------------------------------------------------------------------
Public Sub EventSheetCancel()
    Dim nm As String

    On Error Resume Next
    nm = CStr(ThisWorkbook.Worksheets(SH_EVENT_INPUT).Cells(1, EVS_COL_KEEP).Value)
    ThisWorkbook.Worksheets(nm).Activate
    On Error GoTo 0

    CloseEventSheet
End Sub

'---------------------------------------------------------------------
' 入力シートを片づける
'
' 消すのに失敗したときは隠す。次に開くときに作り直すので残らない。
'---------------------------------------------------------------------
Private Sub CloseEventSheet()
    If Not SheetExists(SH_EVENT_INPUT) Then Exit Sub

    Application.DisplayAlerts = False
    On Error Resume Next
    ThisWorkbook.Worksheets(SH_EVENT_INPUT).Delete
    On Error GoTo 0
    Application.DisplayAlerts = True

    If SheetExists(SH_EVENT_INPUT) Then
        On Error Resume Next
        ThisWorkbook.Worksheets(SH_EVENT_INPUT).Visible = xlSheetHidden
        On Error GoTo 0
    End If
End Sub

'=====================================================================
' ユーザーフォーム（任意）
'
' フォームがブックにあればそちらを使う。無ければ入力シートになる。
' フォーム側は部品を並べるだけで、中身はここから受け取る。
'=====================================================================
Public Function EventFormCount() As Long
    EventFormCount = EVENT_COUNT
End Function

Public Function EventFormTitle() As String
    EventFormTitle = mFormTitle
End Function

Public Function EventFormHeader() As String
    EventFormHeader = mFormHeader
End Function

Public Function EventFormLabel(i As Long) As String
    EventFormLabel = EventName(i)
End Function

Public Function EventFormDefault(i As Long) As String
    EventFormDefault = mFormDefault(i)
End Function

Public Sub EventFormSetResult(i As Long, s As String)
    mFormResult(i) = s
End Sub

Public Sub EventFormSetOK(b As Boolean)
    mFormOK = b
End Sub

'---------------------------------------------------------------------
' 入力フォームがブックにあるか
'---------------------------------------------------------------------
Public Function EventFormExists() As Boolean
    Dim frm As Object

    On Error Resume Next
    Set frm = VBA.UserForms.Add(EVENT_FORM_NAME)
    On Error GoTo 0

    If frm Is Nothing Then Exit Function

    Unload frm
    EventFormExists = True
End Function

'---------------------------------------------------------------------
' 入力フォームを出す
'
' 戻り値 : フォームを出せたか（False なら入力シートに切り替える）
' 書き込むかどうかは mFormOK を見る。
'---------------------------------------------------------------------
Private Function ShowEventForm() As Boolean
    Dim frm As Object

    mFormOK = False

    On Error Resume Next
    Set frm = VBA.UserForms.Add(EVENT_FORM_NAME)
    On Error GoTo 0

    If frm Is Nothing Then Exit Function     ' フォームがブックに無い

    frm.Show 1
    Unload frm
    ShowEventForm = True
End Function

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
' イベントを書くセルを返す
'
' 複数マスにまたがるイベントは、必要なら結合してから返す。
' すでに結合されているセルは、その左上を返す（そこにしか文字が入らない）。
'---------------------------------------------------------------------
Private Function EventCell(ws As Worksheet, blockTop As Long, i As Long, _
                           col As Long, doMerge As Boolean) As Range
    Dim v As Variant, rng As Range
    Dim r1 As Long, r2 As Long

    v = EventDef(i)
    r1 = blockTop + CLng(v(1))
    r2 = r1 + CLng(v(2)) - 1

    If CLng(v(2)) > 1 And doMerge Then
        Set rng = ws.Range(ws.Cells(r1, col), ws.Cells(r2, col))
        If Not rng.MergeCells Then
            Application.DisplayAlerts = False
            rng.Merge
            Application.DisplayAlerts = True
        End If
    End If

    ' 結合されていれば、その左上に読み替える
    Set EventCell = ws.Cells(r1, col).MergeArea.Cells(1, 1)
End Function

'---------------------------------------------------------------------
' イベントを1件書き込む
'---------------------------------------------------------------------
Private Sub WriteEvent(ws As Worksheet, blockTop As Long, i As Long, col As Long)
    Dim v As Variant, cell As Range

    v = EventDef(i)
    Set cell = EventCell(ws, blockTop, i, col, True)

    cell.Value = CStr(v(0))
    cell.Font.Color = CLng(v(3))
    cell.Font.Bold = CBool(v(4))

    If CBool(v(5)) Then
        cell.Orientation = xlVertical      ' 縦書き
    Else
        cell.Orientation = 0               ' 横書き
    End If

    cell.HorizontalAlignment = xlCenter
    cell.VerticalAlignment = xlCenter

    ' 「2W」は塗りつぶしを消す
    If CBool(v(6)) Then cell.Interior.Pattern = xlNone
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
        Set cell = EventCell(ws, blockTop, i, CLng(c), False)
        If Trim$(CStr(cell.Value)) = nm Then
            cell.ClearContents
            cell.Orientation = 0
            cell.Font.Bold = False
            ' このマクロが結合したセルなら、結合も戻す
            If CLng(v(2)) > 1 Then
                If cell.MergeCells Then
                    If cell.MergeArea.Rows.Count = CLng(v(2)) And _
                       cell.MergeArea.Columns.Count = 1 Then cell.MergeArea.UnMerge
                End If
            End If
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
        If Trim$(CStr(EventCell(ws, blockTop, i, CLng(c), False).Value)) = nm Then
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
    Dim b As Variant, topRow As Long

    For Each b In blocks
        topRow = CLng(b(0))
        If r >= topRow And r < topRow + BLOCK_ROWS Then
            propName = CStr(b(1))
            BlockTopFromRow = topRow
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
        If CBool(def(6)) Then
            For Each key In order
                v = info(CStr(key))
                blockTop = CLng(v(0))
                For Each c In colMap.Keys
                    Set cell = EventCell(ws, blockTop, i, CLng(c), False)
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
