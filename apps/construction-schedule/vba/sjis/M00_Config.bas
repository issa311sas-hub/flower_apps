Attribute VB_Name = "M00_Config"
Option Explicit

'=====================================================================
' M00_Config : 座標定数と共通ヘルパー
'
' 現行のローテーション表(シート"1")のレイアウトをここに集約する。
' レイアウトが変わったらこのモジュールだけ直せば済むようにしておく。
'=====================================================================

' --- シート名 -------------------------------------------------------
' 工程表シートの名前はブックによって変わる（"1" だったり "工程表実データ" だったり）。
' M_設定 シートの B1 で指定し、未設定なら既定名 → アクティブシートの順に探す。
Public Const SH_CHART_DEFAULT As String = "1"    ' 工程表本体の既定名
Public Const SH_SETTING As String = "M_設定"
Public Const SH_VENDOR  As String = "M_業者"
Public Const SH_EXCEPT  As String = "M_例外日"
Public Const SH_TERM    As String = "M_工期"
Public Const SH_TASK    As String = "M_工程データ"

' --- 工程表の座標 (すべて Excel の 1 始まり) ------------------------
Public Const ROW_DATE       As Long = 3          ' 日付が入っている行
Public Const COL_DATE_FIRST As Long = 17         ' 日付エリアの先頭列 (Q列)
Public Const ROW_BLOCK_1ST  As Long = 5          ' 最初の物件ブロックの開始行
Public Const BLOCK_ROWS     As Long = 6          ' 1物件が占める行数

Public Const COL_NAME       As Long = 11         ' 邸名          (ブロック先頭行)
Public Const COL_CONTRACT   As Long = 11         ' 契約番号      (先頭行 +1)
Public Const COL_TYPE       As Long = 13         ' タイプ        (先頭行 +1)
Public Const COL_TSUBO      As Long = 14         ' 坪数          (先頭行 +2)

' --- ブロック内の行オフセット (0 始まり) ----------------------------
' 日付エリアではオフセットごとに意味が違う。必ずこの定数経由で書く。
Public Const OFS_KUTAI      As Long = 0          ' 躯体工事の色帯
Public Const OFS_KUTAI_SUB  As Long = 1          ' 躯体行の補助 (単発イベント)
Public Const OFS_NOTE       As Long = 2          ' 補助 (吹付・タイル・養生メモ)
Public Const OFS_KOTE       As Long = 3          ' コテ工事の黒帯
Public Const OFS_KISO       As Long = 4          ' 基礎工事の色帯 (後半は外構が使う)
Public Const OFS_KISO_SUB   As Long = 5          ' 基礎行の補助 (契約着工日の黒1マス)

' --- 色 -------------------------------------------------------------
Public Const CLR_HOLIDAY    As Long = 39321      ' RGB(153, 204, 0)  日曜・祝日の黄緑
Public Const CLR_BLACK      As Long = 0          ' RGB(0, 0, 0)      契約着工日 / コテ

'---------------------------------------------------------------------
' 工程表シートを取得する
'---------------------------------------------------------------------
Public Function ChartSheet() As Worksheet
    Dim ws As Worksheet, nm As String
    nm = ChartSheetName()

    If Len(nm) = 0 Then
        Err.Raise vbObjectError + 1, "ChartSheet", _
                  "どのシートが工程表か分かりません。" & vbCrLf & vbCrLf & _
                  "工程表シートを開いた状態で「ボタン_このシートを工程表に設定」を" & vbCrLf & _
                  "実行するか、" & SH_SETTING & " シートの B1 にシート名を入力してください。" & vbCrLf & vbCrLf & _
                  "このブックのシート:" & vbCrLf & SheetNameList()
    End If

    Set ws = ThisWorkbook.Worksheets(nm)
    Set ChartSheet = ws
End Function

'---------------------------------------------------------------------
' 工程表シートの名前を決める
'
' 1) M_設定 の B1 に入っていて、そのシートが実在すればそれ
' 2) 既定名 "1" のシートがあればそれ
' 3) いま開いているシートがマスタ以外ならそれ
' どれにも当たらなければ空文字を返す。
'---------------------------------------------------------------------
Public Function ChartSheetName() As String
    Dim ws As Worksheet, nm As String

    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(SH_SETTING)
    On Error GoTo 0
    If Not ws Is Nothing Then nm = Trim$(CStr(ws.Range("B1").Value))

    If Len(nm) > 0 Then
        If SheetExists(nm) Then
            ChartSheetName = nm
            Exit Function
        End If
    End If

    If SheetExists(SH_CHART_DEFAULT) Then
        ChartSheetName = SH_CHART_DEFAULT
        Exit Function
    End If

    If TypeName(ActiveSheet) = "Worksheet" Then
        If Not IsMasterSheet(ActiveSheet.Name) Then
            ChartSheetName = ActiveSheet.Name
            Exit Function
        End If
    End If

    ChartSheetName = ""
End Function

'---------------------------------------------------------------------
' シートが存在するか
'---------------------------------------------------------------------
Public Function SheetExists(sheetName As String) As Boolean
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(sheetName)
    On Error GoTo 0
    SheetExists = Not ws Is Nothing
End Function

'---------------------------------------------------------------------
' マクロが作ったマスタシートか（工程表の候補から外すため）
'---------------------------------------------------------------------
Public Function IsMasterSheet(sheetName As String) As Boolean
    Select Case sheetName
        Case SH_SETTING, SH_VENDOR, SH_EXCEPT, SH_TERM, SH_TASK
            IsMasterSheet = True
        Case Else
            IsMasterSheet = False
    End Select
End Function

'---------------------------------------------------------------------
' ブック内のシート名を一覧の文字列にする（エラーメッセージ用）
'---------------------------------------------------------------------
Public Function SheetNameList() As String
    Dim ws As Worksheet, s As String
    For Each ws In ThisWorkbook.Worksheets
        s = s & "  ・" & ws.Name
        If IsMasterSheet(ws.Name) Then s = s & "  （マスタ）"
        s = s & vbCrLf
    Next ws
    SheetNameList = s
End Function

'---------------------------------------------------------------------
' 日付 -> 列番号 の対応表を作る
'
' 月の変わり目に日付の入っていない区切り列が挟まるため、
' 列番号から日付を計算してはいけない。必ず ROW_DATE の実値を読む。
' キーは CLng(日付) の日付シリアル値。
'---------------------------------------------------------------------
Public Function BuildDateMap(ws As Worksheet) As Object
    Dim map As Object, c As Long, lastCol As Long, v As Variant
    Set map = CreateObject("Scripting.Dictionary")

    lastCol = ws.Cells(ROW_DATE, ws.Columns.Count).End(xlToLeft).Column
    For c = COL_DATE_FIRST To lastCol
        v = ws.Cells(ROW_DATE, c).Value
        If IsDate(v) Then
            If Not map.Exists(CLng(CDate(v))) Then map.Add CLng(CDate(v)), c
        End If
    Next c

    If map.Count = 0 Then
        Err.Raise vbObjectError + 2, "BuildDateMap", _
                  ROW_DATE & "行目に日付が見つかりません。ROW_DATE / COL_DATE_FIRST を確認してください。"
    End If
    Set BuildDateMap = map
End Function

'---------------------------------------------------------------------
' 列番号 -> 日付 の対応表 (逆引き)
'---------------------------------------------------------------------
Public Function BuildColMap(ws As Worksheet) As Object
    Dim map As Object, c As Long, lastCol As Long, v As Variant
    Set map = CreateObject("Scripting.Dictionary")

    lastCol = ws.Cells(ROW_DATE, ws.Columns.Count).End(xlToLeft).Column
    For c = COL_DATE_FIRST To lastCol
        v = ws.Cells(ROW_DATE, c).Value
        If IsDate(v) Then map(c) = CDate(v)
    Next c
    Set BuildColMap = map
End Function

'---------------------------------------------------------------------
' 物件ブロックの一覧を返す
'
' 各要素は Array(開始行, 邸名, 契約番号, タイプ) の Variant 配列。
' 「邸」で終わるセルをブロック先頭とみなす。
'---------------------------------------------------------------------
Public Function FindBlocks(ws As Worksheet) As Collection
    Dim col As New Collection
    Dim r As Long, lastRow As Long
    Dim nm As String, contract As String, typ As String

    lastRow = ws.Cells(ws.Rows.Count, COL_NAME).End(xlUp).Row

    r = ROW_BLOCK_1ST
    Do While r <= lastRow
        nm = Trim$(CStr(ws.Cells(r, COL_NAME).Value))
        If Len(nm) > 0 And Right$(nm, 1) = "邸" Then
            contract = Trim$(CStr(ws.Cells(r + 1, COL_CONTRACT).Value))
            typ = Trim$(CStr(ws.Cells(r + 1, COL_TYPE).Value))
            col.Add Array(r, nm, contract, typ)
            r = r + BLOCK_ROWS
        Else
            r = r + 1
        End If
    Loop

    Set FindBlocks = col
End Function

'---------------------------------------------------------------------
' シートを名前で取得。無ければ作る。
'---------------------------------------------------------------------
Public Function GetOrCreateSheet(sheetName As String) As Worksheet
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(sheetName)
    On Error GoTo 0
    If ws Is Nothing Then
        Set ws = ThisWorkbook.Worksheets.Add(After:=ThisWorkbook.Worksheets(ThisWorkbook.Worksheets.Count))
        ws.Name = sheetName
    End If
    Set GetOrCreateSheet = ws
End Function
