Attribute VB_Name = "M00_Config"
Option Explicit

'=====================================================================
' M00_Config : 座標定数と共通ヘルパー
'
' 現行のローテーション表(シート"1")のレイアウトをここに集約する。
' レイアウトが変わったらこのモジュールだけ直せば済むようにしておく。
'=====================================================================

'--- 二重引用符（文字列の中に " を書くため） ------------------------
Public Const QT As String = """"

' --- シート名 -------------------------------------------------------
' 工程表シートの名前はブックによって変わる（"1" だったり "工程表実データ" だったり）。
' 「ボタン_このシートを工程表に設定」で指定し、未設定なら既定名 → アクティブシートの順に探す。
Public Const SH_CHART_DEFAULT As String = "1"    ' 工程表本体の既定名
Public Const SH_VENDOR  As String = "M_業者"
Public Const SH_EXCEPT  As String = "M_例外日"
Public Const SH_TASK    As String = "M_工程データ"

' 使わなくなったシート。中身はマクロに取り込んだので、初期セットアップで削除する。
Public Const SH_SETTING As String = "M_設定"
Public Const SH_TERM    As String = "M_工期"

' --- 設定の保存キー -------------------------------------------------
' 設定シートは作らない。ブックに埋め込む「名前」（非表示）に保存する。
Public Const CFG_CHART_SHEET As String = "cfgChartSheet"   ' 工程表シート名
Public Const CFG_BASE_YEAR   As String = "cfgBaseYear"     ' カレンダー先頭列の年

' --- 工程表の座標 (すべて Excel の 1 始まり) ------------------------
Public Const ROW_DATE       As Long = 3          ' 日付が入っている行
Public Const COL_DATE_FIRST As Long = 17         ' 日付エリアの先頭列 (Q列)
Public Const ROW_BLOCK_1ST  As Long = 5          ' 最初の物件ブロックの開始行
Public Const BLOCK_ROWS     As Long = 6          ' 1物件が占める行数

Public Const COL_NAME       As Long = 11         ' 邸名          (ブロック先頭行)
Public Const COL_CONTRACT   As Long = 11         ' 契約番号      (先頭行 +1)
Public Const COL_TYPE       As Long = 13         ' タイプ        (先頭行 +1)
Public Const COL_TSUBO      As Long = 14         ' 坪数          (先頭行 +2)

' 業者名（先頭行 +0）。実データで表記ゆれが無いことを確認済み。
'   基礎 : 加納 / 協栄 / 龍壱 / カサハラ の4社
'   躯体 : 丸岩・KRK / 雅建工 の2社
Public Const COL_KISO_VENDOR  As Long = 14       ' 基礎業者      (先頭行 +0)
Public Const COL_KUTAI_VENDOR As Long = 15       ' 躯体業者      (先頭行 +0)

' 本着日とお客様納期（先頭行 +2 がラベル、+3 が値）
Public Const ROW_OFS_DATES   As Long = 3
Public Const COL_HONCHAKU    As Long = 11        ' 本着日
Public Const COL_NOUKI       As Long = 12        ' お客様納期

' --- ブロック内の行オフセット (0 始まり) ----------------------------
' 日付エリアではオフセットごとに意味が違う。必ずこの定数経由で書く。
Public Const OFS_KUTAI      As Long = 0          ' 躯体工事の色帯
Public Const OFS_KUTAI_SUB  As Long = 1          ' 躯体行の補助 (単発イベント)
Public Const OFS_NOTE       As Long = 2          ' 補助 (吹付・タイル・養生メモ)
Public Const OFS_MORTAR     As Long = 3          ' モルタル工事の黒帯
Public Const OFS_KISO       As Long = 4          ' 基礎工事の色帯 (後半は外構が使う)
Public Const OFS_KISO_SUB   As Long = 5          ' 基礎行の補助 (契約着工日の黒1マス)

' --- クリティカル工程 (工事店確認済。この順で必ず進む) --------------
'   1 基礎工事 → 2 躯体工事 → 3 モルタル工事 → 4 防水工事
'   → 5 断熱工事 → 6 木工事 → 7 仕上げ工事
' 現在は 1 基礎 と 2 躯体 まで実装。以降は順次追加する。
'
' 色帯を塗る行は工程ごとに違う（実測で確認済み）。
'   基礎 … +4 と +5 の 2 行   (実測 2610 / 2621 セル)
'   躯体 … +0 の 1 行のみ     (実測 +0 が 808、+1 は 19 のみ)

' --- M_工程データ の列レイアウト（1物件1行の横並び） ----------------
' A 契約番号 / B 邸名 / 以降は工程ごとに 5 列ずつ
'   基礎: C 開始日  D 調整  E 終了日  F 色名  G 備考
'   躯体: H 開始日  I 調整  J 終了日  K 色名  L 備考
' 工程を足すときは右へ 5 列ずつ伸ばす。
'
' 各列の役割（開始日を直したら全部計算し直せるよう、入力と出力を分けてある）
'   開始日 … 入力。2番目以降の工程は空欄なら前工程の終了日から自動で決まる
'   調整   … 入力。工期に足し引きする日数（+1 / -2 など）。空欄は 0
'   終了日 … 出力。実行のたびに必ず計算し直して上書きする
'   色名   … 空欄なら自動割り当て。入っていればその業者で固定
'   備考   … 自由記入。マクロは読み書きしない
Public Const TASK_COL_CONTRACT As Long = 1
Public Const TASK_COL_NAME     As Long = 2
Public Const TASK_COL_FIRST    As Long = 3    ' 最初の工程ブロックの開始列
Public Const TASK_COL_WIDTH    As Long = 5    ' 1工程あたりの列数

' 工程ブロック内での列オフセット（0 始まり）
Public Const TASK_OFS_START  As Long = 0
Public Const TASK_OFS_ADJUST As Long = 1
Public Const TASK_OFS_END    As Long = 2
Public Const TASK_OFS_COLOR  As Long = 3
Public Const TASK_OFS_NOTE   As Long = 4

' --- 色 -------------------------------------------------------------
Public Const CLR_HOLIDAY     As Long = 52377     ' RGB(153, 204, 0)  日曜・祝日の黄緑
' v13 以前は RGB(153,153,0) で塗っていた。古い塗りも日祝として認識するために残す。
Public Const CLR_HOLIDAY_OLD As Long = 39321     ' RGB(153, 153, 0)
Public Const CLR_BLACK      As Long = 0          ' RGB(0, 0, 0)      契約着工日 / モルタル

' 本着日・お客様納期のマーカー。工程表に縦 MARK_ROWS マス塗る。
' 業者色とは別枠で扱い、工程色より優先して上書きする。
Public Const CLR_MARK_HONCHAKU As Long = 0        ' RGB(0, 0, 0)     黒
Public Const CLR_MARK_NOUKI    As Long = 13395456 ' RGB(0, 102, 204) 青
' 本着日は基礎工事の下の1マスだけ塗る。その列の基礎の色帯は1行上へずらす。
Public Const MARK_OFS_HONCHAKU As Long = 5       ' = OFS_KISO_SUB
' お客様納期は物件ブロックの上から縦に塗る
Public Const MARK_ROWS      As Long = 4          ' 縦に塗るマス数
Public Const MARK_OFS_FIRST As Long = 0          ' 物件ブロックの先頭からの位置

'---------------------------------------------------------------------
' 日祝の黄緑か（古い版で塗った色も含む）
'---------------------------------------------------------------------
Public Function IsHolidayColor(c As Long) As Boolean
    IsHolidayColor = (c = CLR_HOLIDAY) Or (c = CLR_HOLIDAY_OLD)
End Function

'=====================================================================
' 設定の保存先
'
' 設定シートは使わない。利用者が触るシートを増やさないため、
' ブックに埋め込む「名前」（非表示）に保存する。
' Excel の画面には出ないが、ブックを保存すれば残る。
'=====================================================================
'---------------------------------------------------------------------
' 設定を読む。無ければ空文字。
'---------------------------------------------------------------------
Public Function GetSetting(key As String) As String
    Dim s As String
    On Error Resume Next
    s = CStr(ThisWorkbook.Names(key).RefersTo)
    On Error GoTo 0
    If Len(s) = 0 Then Exit Function

    ' RefersTo は ="値" の形で返る。= と引用符を外す。
    If Left$(s, 1) = "=" Then s = Mid$(s, 2)
    If Len(s) >= 2 Then
        If Left$(s, 1) = QT And Right$(s, 1) = QT Then s = Mid$(s, 2, Len(s) - 2)
    End If
    GetSetting = Replace$(s, QT & QT, QT)
End Function

'---------------------------------------------------------------------
' 設定を書く
'---------------------------------------------------------------------
Public Sub SaveSetting(key As String, val As String)
    On Error Resume Next
    ThisWorkbook.Names(key).Delete
    On Error GoTo 0
    ThisWorkbook.Names.Add Name:=key, _
        RefersTo:="=" & QT & Replace$(val, QT, QT & QT) & QT, Visible:=False
End Sub

'---------------------------------------------------------------------
' カレンダーの基準年（日付エリアの先頭列の年）。0 なら補正しない。
'---------------------------------------------------------------------
Public Function CalendarBaseYear() As Long
    Dim s As String
    s = GetSetting(CFG_BASE_YEAR)
    If Len(s) = 0 Then Exit Function
    If Not IsNumeric(s) Then Exit Function
    CalendarBaseYear = CLng(s)
End Function

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
                  "実行してください。" & vbCrLf & vbCrLf & _
                  "このブックのシート:" & vbCrLf & SheetNameList()
    End If

    Set ws = ThisWorkbook.Worksheets(nm)
    Set ChartSheet = ws
End Function

'---------------------------------------------------------------------
' 工程表シートの名前を決める
'
' 1) ブックに保存した設定（ボタン_このシートを工程表に設定 で書く）
' 2) 旧版の M_設定 シートが残っていればその B1
' 3) 既定名 "1" のシートがあればそれ
' 4) いま開いているシートがマスタ以外ならそれ
' どれにも当たらなければ空文字を返す。
'---------------------------------------------------------------------
Public Function ChartSheetName() As String
    Dim ws As Worksheet, nm As String

    nm = Trim$(GetSetting(CFG_CHART_SHEET))
    If Len(nm) > 0 Then
        If SheetExists(nm) Then
            ChartSheetName = nm
            Exit Function
        End If
    End If

    ' 旧版からの移行用。M_設定 が残っていれば読む。
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
' 列番号 -> 日付 の対応表を作る
'
' 月の変わり目に日付の入っていない区切り列が挟まるため、
' 列番号から日付を計算してはいけない。必ず ROW_DATE の実値を読む。
'
' ■ 年の補正
' カレンダーのセルに入っている「年」が実際と違うことがある
' （前年の表を作り替えて使っている場合など）。
' 「ボタン_カレンダーの年を設定」で先頭列の年を指定しておくと、
' 月日だけをシートから読み、年はこちらで振り直す。
' 月が戻ったところ（12月→1月）で年を1つ繰り上げる。
' 未設定なら、シートに入っている値をそのまま使う。
'---------------------------------------------------------------------
Public Function BuildColMap(ws As Worksheet) As Object
    Dim map As Object, c As Long, lastCol As Long, v As Variant
    Dim d As Date, baseYear As Long, y As Long, prevMonth As Long

    Set map = CreateObject("Scripting.Dictionary")
    baseYear = CalendarBaseYear()
    y = baseYear
    prevMonth = 0

    lastCol = ws.Cells(ROW_DATE, ws.Columns.Count).End(xlToLeft).Column
    For c = COL_DATE_FIRST To lastCol
        v = ws.Cells(ROW_DATE, c).Value
        If IsDate(v) Then
            d = CDate(v)
            If baseYear > 0 Then
                If prevMonth > 0 Then
                    If Month(d) < prevMonth Then y = y + 1
                End If
                prevMonth = Month(d)
                d = DateSerial(y, Month(d), Day(d))
            End If
            map(c) = d
        End If
    Next c
    Set BuildColMap = map
End Function

'---------------------------------------------------------------------
' 日付 -> 列番号 の対応表 (逆引き)
' キーは CLng(日付) の日付シリアル値。
'---------------------------------------------------------------------
Public Function BuildDateMap(ws As Worksheet) As Object
    Dim map As Object, colMap As Object, c As Variant, key As Long

    Set map = CreateObject("Scripting.Dictionary")
    Set colMap = BuildColMap(ws)

    For Each c In colMap.Keys
        key = CLng(CDate(colMap(c)))
        If Not map.Exists(key) Then map.Add key, CLng(c)
    Next c

    If map.Count = 0 Then
        Err.Raise vbObjectError + 2, "BuildDateMap", _
                  ROW_DATE & "行目に日付が見つかりません。ROW_DATE / COL_DATE_FIRST を確認してください。"
    End If
    Set BuildDateMap = map
End Function

'---------------------------------------------------------------------
' 物件ブロックの一覧を返す
'
' 各要素は次の Variant 配列。「邸」で終わるセルをブロック先頭とみなす。
'   0 開始行 / 1 邸名 / 2 契約番号 / 3 タイプ
'   4 基礎業者 / 5 躯体業者 / 6 本着日 / 7 お客様納期
' 並び順はシートの上から下。業者の優先順位もこの順になる。
'---------------------------------------------------------------------
Public Function FindBlocks(ws As Worksheet) As Collection
    Dim col As New Collection
    Dim r As Long, lastRow As Long
    Dim nm As String, contract As String, typ As String
    Dim kisoV As String, kutaiV As String
    Dim honchaku As Variant, nouki As Variant

    lastRow = ws.Cells(ws.Rows.Count, COL_NAME).End(xlUp).Row

    r = ROW_BLOCK_1ST
    Do While r <= lastRow
        nm = Trim$(CStr(ws.Cells(r, COL_NAME).Value))
        If Len(nm) > 0 And Right$(nm, 1) = "邸" Then
            contract = Trim$(CStr(ws.Cells(r + 1, COL_CONTRACT).Value))
            typ = Trim$(CStr(ws.Cells(r + 1, COL_TYPE).Value))
            kisoV = Trim$(CStr(ws.Cells(r, COL_KISO_VENDOR).Value))
            kutaiV = Trim$(CStr(ws.Cells(r, COL_KUTAI_VENDOR).Value))

            honchaku = Empty
            nouki = Empty
            If IsDate(ws.Cells(r + ROW_OFS_DATES, COL_HONCHAKU).Value) Then
                honchaku = CDate(ws.Cells(r + ROW_OFS_DATES, COL_HONCHAKU).Value)
            End If
            If IsDate(ws.Cells(r + ROW_OFS_DATES, COL_NOUKI).Value) Then
                nouki = CDate(ws.Cells(r + ROW_OFS_DATES, COL_NOUKI).Value)
            End If

            col.Add Array(r, nm, contract, typ, kisoV, kutaiV, honchaku, nouki)
            r = r + BLOCK_ROWS
        Else
            r = r + 1
        End If
    Loop

    Set FindBlocks = col
End Function

'=====================================================================
' タイプコードの解析
'
' 例) C2E42 → 種類 "C" / 階数 2 / 坪数 42
'     DYF67 → 種類 "DY" / 階数 0 / 坪数 67
'     V3F208 → 種類 "V" / 階数 3 / 坪数 208
'
' 末尾の E または F の後ろがすべて数字であるところで区切る。
' その数字が総坪数（坪数欄 ①②の合計とほぼ一致することを実データで確認済み）。
'=====================================================================
Public Function ParseType(typeCode As String, ByRef kind As String, _
                          ByRef floors As Long, ByRef area As Long) As Boolean
    Dim t As String, i As Long, sep As Long
    Dim prefix As String, tail As String, lastCh As String

    kind = "": floors = 0: area = 0
    t = UCase$(Trim$(typeCode))
    If Len(t) < 3 Then Exit Function

    ' 後ろから、E/F の直後がすべて数字になる位置を探す
    For i = Len(t) - 1 To 2 Step -1
        If Mid$(t, i, 1) = "E" Or Mid$(t, i, 1) = "F" Then
            tail = Mid$(t, i + 1)
            If Len(tail) > 0 Then
                If IsAllDigits(tail) Then
                    sep = i
                    Exit For
                End If
            End If
        End If
    Next i
    If sep = 0 Then Exit Function

    area = CLng(tail)
    prefix = Left$(t, sep - 1)
    If Len(prefix) = 0 Then Exit Function

    ' 接頭辞の末尾が数字なら階数
    lastCh = Right$(prefix, 1)
    If lastCh >= "0" And lastCh <= "9" Then
        floors = CLng(lastCh)
        kind = Left$(prefix, Len(prefix) - 1)
    Else
        kind = prefix
    End If

    ParseType = (Len(kind) > 0 And area > 0)
End Function

Private Function IsAllDigits(s As String) As Boolean
    Dim i As Long, c As String
    For i = 1 To Len(s)
        c = Mid$(s, i, 1)
        If c < "0" Or c > "9" Then Exit Function
    Next i
    IsAllDigits = (Len(s) > 0)
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
