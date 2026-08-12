Attribute VB_Name = "M02_Masters"
Option Explicit

'=====================================================================
' M02_Masters : マスタシートの生成と初期化
'
' 「見た目は現行のまま、データは別シートで管理する」方針にもとづき、
' 参照用のマスタシートをここでまとめて作る。
' 既存シートがある場合、見出しだけ整えて中身は消さない。
'=====================================================================

' --- M_業者 シートの版 ----------------------------------------------
' 色や業者名を変えたら上げる。古い版のシートは退避して作り直す。
Private Const VENDOR_VERSION As String = "v14"

'---------------------------------------------------------------------
' すべてのマスタシートを作成／初期化する（初回セットアップ用）
'---------------------------------------------------------------------
Public Sub SetupMasters()
    Dim activeName As String

    ' マスタを作る前に、いま開いているシートを工程表の候補として覚えておく
    If TypeName(ActiveSheet) = "Worksheet" Then
        If Not IsMasterSheet(ActiveSheet.Name) Then activeName = ActiveSheet.Name
    End If

    Application.ScreenUpdating = False

    If Len(activeName) > 0 Then SaveSetting CFG_CHART_SHEET, activeName

    Dim removed As String
    removed = RemoveObsoleteSheets()

    SetupVendorSheet
    SetupExceptionSheet
    SetupTaskSheet

    ' 工程表シートが分かっていれば、この場で日祝も塗ってしまう
    Dim holidayMsg As String
    If Len(ChartSheetName()) > 0 Then
        On Error Resume Next
        holidayMsg = PaintHolidaysCore(ChartSheet())
        If Err.Number <> 0 Then
            holidayMsg = "日祝 : 塗れませんでした（" & Err.Description & "）"
            Err.Clear
        End If
        On Error GoTo 0
    Else
        holidayMsg = "日祝 : 工程表シートが未設定のため塗っていません"
    End If

    Application.ScreenUpdating = True
    MsgBox "マスタシートを作成しました。" & vbCrLf & vbCrLf & _
           SH_VENDOR & " : 業者と色の対応" & vbCrLf & _
           SH_EXCEPT & " : 例外日" & vbCrLf & _
           SH_TASK & " : 工程データ（色塗りの元データ）" & vbCrLf & vbCrLf & _
           "工程表シート : " & IIf(Len(ChartSheetName()) > 0, ChartSheetName(), "（未設定）") & vbCrLf & _
           "カレンダーの年 : " & IIf(CalendarBaseYear() > 0, _
                                     CStr(CalendarBaseYear()) & " 年から", _
                                     "（シートの値をそのまま使う）") & vbCrLf & _
           removed & vbCrLf & _
           holidayMsg, _
           vbInformation, "セットアップ完了"
End Sub

'---------------------------------------------------------------------
' 使わなくなったシートを片づける
'
' M_設定（工程表シート名）と M_工期（標準工期）は、利用者が触ることが
' 無いのでマクロの中に取り込んだ。シートが増えると迷うため削除する。
' M_設定 に入っていたシート名は、消す前にブックの設定へ移す。
'---------------------------------------------------------------------
Private Function RemoveObsoleteSheets() As String
    Dim ws As Worksheet, nm As String, msg As String

    ' M_設定 の指定を引き継ぐ
    If SheetExists(SH_SETTING) Then
        Set ws = ThisWorkbook.Worksheets(SH_SETTING)
        nm = Trim$(CStr(ws.Range("B1").Value))
        If Len(nm) > 0 And Len(GetSetting(CFG_CHART_SHEET)) = 0 Then
            If SheetExists(nm) Then SaveSetting CFG_CHART_SHEET, nm
        End If
    End If

    msg = DeleteSheetIfExists(SH_SETTING)
    msg = msg & DeleteSheetIfExists(SH_TERM)

    If Len(msg) > 0 Then
        RemoveObsoleteSheets = "不要になったシートを削除しました : " & Left$(msg, Len(msg) - 1)
    End If
End Function

Private Function DeleteSheetIfExists(sheetName As String) As String
    If Not SheetExists(sheetName) Then Exit Function
    Application.DisplayAlerts = False
    On Error Resume Next
    ThisWorkbook.Worksheets(sheetName).Delete
    On Error GoTo 0
    Application.DisplayAlerts = True
    If Not SheetExists(sheetName) Then DeleteSheetIfExists = sheetName & " "
End Function

'---------------------------------------------------------------------
' M_業者 : 色と業者の対応表
'
' 業者そのものを区別する必要はなく、「同じ色＝同じ業者」が分かれば足りる。
' 重複稼働チェックもこの色をキーに行う。
'---------------------------------------------------------------------
Private Sub SetupVendorSheet()
    Dim ws As Worksheet, isNew As Boolean

    Set ws = GetOrCreateSheet(SH_VENDOR)
    isNew = (Len(Trim$(CStr(ws.Cells(1, 1).Value))) = 0)

    ' 色や業者名を直した版が出たら、古いシートは退避して作り直す
    If Not isNew Then
        If Not VendorSheetIsCurrent() Then
            BackupSheet ws
            Set ws = GetOrCreateSheet(SH_VENDOR)
            isNew = True
        End If
    End If

    WriteHeader ws, Array("色名", "R", "G", "B", "工種", "業者名", "備考", "版")
    If Not isNew Then Exit Sub

    ' 色は工事店さまの指定値。業者名は工程表の「基礎業者」「躯体業者」欄の
    ' 表記と一致させること。表記ゆれは「丸岩/KRK」のように / で並べられる。
    Dim rows As Variant, i As Long
    rows = Array( _
        Array("茶", 153, 51, 0, "躯体", "雅建工", "躯体チームA"), _
        Array("薄紫", 204, 153, 255, "躯体", "丸岩/KRK/丸岩KRK/丸岩・KRK", "躯体チームB / 外構フェーズ2でも使用"), _
        Array("青", 0, 102, 204, "基礎", "協栄", "お客様納期の青と同じ色。塗る位置で区別する"), _
        Array("緑", 51, 153, 102, "基礎", "加納", ""), _
        Array("桃", 255, 0, 255, "基礎", "カサハラ", ""), _
        Array("薄橙", 255, 204, 153, "基礎", "龍壱", ""), _
        Array("水色", 153, 204, 255, "外構", "", "外構フェーズ1"), _
        Array("黒", 0, 0, 0, "モルタル", "", "本着日(1マス)にも使用。行で区別する"), _
        Array("淡水", 204, 255, 255, "足場", "", "内部足場を含む"), _
        Array("金", 255, 204, 0, "行事", "", "社内行事・タイル工事"), _
        Array("白", 255, 255, 255, "単発", "", "家具搬入・器具・CL 等") _
    )

    For i = LBound(rows) To UBound(rows)
        WriteRow ws, i + 2, rows(i)
        ws.Cells(i + 2, 1).Interior.Color = RGB(rows(i)(1), rows(i)(2), rows(i)(3))
    Next i

    ws.Range("H2").Value = VENDOR_VERSION
    ws.Columns("A:H").AutoFit
End Sub

'---------------------------------------------------------------------
' M_業者 が現行版かどうか（H2 の版で判定する）
'---------------------------------------------------------------------
Public Function VendorSheetIsCurrent() As Boolean
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(SH_VENDOR)
    On Error GoTo 0
    If ws Is Nothing Then Exit Function

    VendorSheetIsCurrent = (Trim$(CStr(ws.Range("H2").Value)) = VENDOR_VERSION)
End Function

'---------------------------------------------------------------------
' M_例外日 : 物件ごとの例外日
'
' 入力するのは 契約番号 と 日付 の2列だけ。
' 「詳細」はマクロが日付から判定して書き込む。
'   その日が休み（日曜・お盆・年末年始）… 日曜→作業 のように反転
'   その日が祝日（＝稼働日）            … 祝日名→休み
'   それ以外（平日）                    … 平日→休み
'
' 契約番号に「全件」と書くと、全物件に適用される（会社都合の休工など）。
'---------------------------------------------------------------------
Private Sub SetupExceptionSheet()
    Dim ws As Worksheet, isNew As Boolean
    Set ws = GetOrCreateSheet(SH_EXCEPT)
    isNew = (Len(Trim$(CStr(ws.Cells(1, 1).Value))) = 0)

    ' 旧形式（区分・備考の4列）が残っていたら退避して作り直す
    If Not isNew Then
        If Not ExceptionSheetIsCurrent() Then
            BackupSheet ws
            Set ws = GetOrCreateSheet(SH_EXCEPT)
            isNew = True
        End If
    End If

    WriteHeader ws, Array("契約番号", "日付", "詳細")
    If Not isNew Then Exit Sub

    On Error Resume Next
    ws.Range("A1").AddComment "入力。契約番号。「" & EXCEPT_ALL & "」と書くと全物件に適用されます"
    ws.Range("B1").AddComment "入力。例外にしたい日付"
    ws.Range("C1").AddComment "出力。日付から自動で判定されます"
    On Error GoTo 0

    ws.Range("B2:B1000").NumberFormatLocal = "yyyy/mm/dd"
    ws.Range("C1:C1000").Interior.Color = RGB(242, 242, 242)
    ws.Columns("A:B").ColumnWidth = 16
    ws.Columns("C:C").ColumnWidth = 18
End Sub

'---------------------------------------------------------------------
' M_例外日 が新形式（契約番号・日付・詳細の3列）かどうか
'---------------------------------------------------------------------
Public Function ExceptionSheetIsCurrent() As Boolean
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(SH_EXCEPT)
    On Error GoTo 0
    If ws Is Nothing Then Exit Function

    ExceptionSheetIsCurrent = (Trim$(CStr(ws.Cells(1, 3).Value)) = "詳細")
End Function

'---------------------------------------------------------------------
' シートを退避する（M_工期_旧1 のように連番を付けて改名）
'---------------------------------------------------------------------
Private Sub BackupSheet(ws As Worksheet)
    Dim base As String, nm As String, i As Long
    base = ws.Name & "_旧"
    i = 1
    Do
        nm = base & i
        i = i + 1
    Loop While SheetExists(nm)

    On Error Resume Next
    ws.Name = nm
    On Error GoTo 0
End Sub

'=====================================================================
' 標準工期
'
'     稼働日数 = ROUND(基準日数 + 坪係数 × 坪数) + 種類補正
'
' 基準日数・坪係数は C 種 29 件の回帰、種類補正はその残差から求めた。
' 以前は M_工期 シートに書き出していたが、利用者が触るものではないので
' マクロの中に取り込んだ。値を直すのはここ。
'
'   基礎 : 6.37 + 0.1075 × 坪   平均絶対誤差 2.2日
'   躯体 : -0.21 + 0.1103 × 坪  平均絶対誤差 0.6日
'
' 種類補正（基礎 / 躯体）
'   C   0 /  0  基準（29件）
'   R   3 /  1  工事店確認済：基礎・躯体ともCより長い（6件）
'   P   0 /  1  工事店確認済：基礎はCと同じ、躯体だけ長い（1件）
'   D   1 /  0  実測のみ（5件）
'   DY -2 /  0  実測のみ ※要確認（3件）
'   M   5 / -2  実測のみ ※要確認（2件）
'   V   0 /  0  データなし。Cと同じ扱い ※要確認
'=====================================================================

'---------------------------------------------------------------------
' 指定タイプの稼働日数を計算する
'
' taskName : "基礎" または "躯体"
' 戻り値   : 稼働日数（1 未満にはならない）。タイプが読めなければ 0
'---------------------------------------------------------------------
Public Function TermDays(taskName As String, typeCode As String) As Long
    Dim kind As String, floors As Long, area As Long
    Dim baseDays As Double, coef As Double, corr As Long

    If Not ParseType(typeCode, kind, floors, area) Then Exit Function

    Select Case taskName
        Case "基礎"
            baseDays = 6.37: coef = 0.1075
        Case "躯体"
            baseDays = -0.21: coef = 0.1103
        Case Else
            Exit Function
    End Select

    corr = TypeCorrection(taskName, kind)

    TermDays = CLng(Application.WorksheetFunction.Round(baseDays + coef * area, 0)) + corr
    If TermDays < 1 Then TermDays = 1
End Function

'---------------------------------------------------------------------
' 建物種類による補正日数
'---------------------------------------------------------------------
Private Function TypeCorrection(taskName As String, kind As String) As Long
    Dim kiso As Long, kutai As Long

    Select Case UCase$(Trim$(kind))
        Case "C":  kiso = 0:  kutai = 0
        Case "R":  kiso = 3:  kutai = 1
        Case "P":  kiso = 0:  kutai = 1
        Case "D":  kiso = 1:  kutai = 0
        Case "DY": kiso = -2: kutai = 0
        Case "M":  kiso = 5:  kutai = -2
        Case "V":  kiso = 0:  kutai = 0
        Case Else: kiso = 0:  kutai = 0
    End Select

    If taskName = "躯体" Then
        TypeCorrection = kutai
    Else
        TypeCorrection = kiso
    End If
End Function

'---------------------------------------------------------------------
' 工程間インターバル（暦日）
'
'   契約着工日→基礎着手   2 日（実測 1～7日、中央値2日）
'   基礎完了→躯体着手     4 日（実測 2～11日、中央値4日）
'   躯体完了→モルタル着手 2 日（間に穴明け1日が入る）
'---------------------------------------------------------------------
Public Function TermInterval(label As String, defaultDays As Long) As Long
    Select Case label
        Case "契約着工日→基礎着手":   TermInterval = 2
        Case "基礎完了→躯体着手":     TermInterval = 4
        Case "躯体完了→モルタル着手": TermInterval = 2
        Case Else:                     TermInterval = defaultDays
    End Select
End Function

'---------------------------------------------------------------------
' 動作確認用 : タイプを入れると計算結果を表示する
'---------------------------------------------------------------------
Public Sub DebugTermDays()
    Dim t As String, kind As String, floors As Long, area As Long
    t = InputBox("タイプコードを入力してください（例 C2E42）", "工期の計算確認", "C2E42")
    If Len(Trim$(t)) = 0 Then Exit Sub

    If Not ParseType(t, kind, floors, area) Then
        MsgBox "タイプ「" & t & "」を解析できませんでした。", vbExclamation
        Exit Sub
    End If

    MsgBox "タイプ : " & UCase$(Trim$(t)) & vbCrLf & _
           "  建物種類 : " & kind & vbCrLf & _
           "  階数     : " & IIf(floors > 0, CStr(floors) & " 階", "（表記なし）") & vbCrLf & _
           "  坪数     : " & area & " 坪" & vbCrLf & vbCrLf & _
           "基礎工事 : " & TermDays("基礎", t) & " 稼働日" & vbCrLf & _
           "躯体工事 : " & TermDays("躯体", t) & " 稼働日", _
           vbInformation, "工期の計算確認"
End Sub

'---------------------------------------------------------------------
' M_工程データ : 色塗りの元データ
'
' 1物件 = 1行。工程は横に 4 列ずつ並べる。
' 同じ物件の基礎と躯体が横一列に並ぶので、担当の重なりを目で追いやすい。
'
'   A 契約番号 | B 邸名 | C-F 基礎 | G-J 躯体 | （以降 工程を足すごとに右へ）
'
' 入力するのは開始日だけでよい。終了日と色名は自動で入る。
'---------------------------------------------------------------------
Private Sub SetupTaskSheet()
    Dim ws As Worksheet, isNew As Boolean
    Dim headers As Variant

    Set ws = GetOrCreateSheet(SH_TASK)
    isNew = (Len(Trim$(CStr(ws.Cells(1, 1).Value))) = 0)

    ' 旧形式（1行1工程の縦持ち）が残っていたら退避して作り直す
    If Not isNew Then
        If Not TaskSheetIsCurrent() Then
            BackupSheet ws
            Set ws = GetOrCreateSheet(SH_TASK)
            isNew = True
        End If
    End If

    headers = Array("契約番号", "邸名", _
                    "基礎開始日", "基礎調整", "基礎終了日", "色名", "備考", _
                    "躯体開始日", "躯体調整", "躯体終了日", "色名", "備考")
    WriteHeader ws, headers
    If Not isNew Then Exit Sub

    ' 使い方が分かるようヘッダにコメントを付ける（新規作成時のみ）
    On Error Resume Next
    ws.Range("C1").AddComment "入力。ここだけ入れれば足ります"
    ws.Range("D1").AddComment "入力。工期に足し引きする日数（+1 / -2 など）。空欄は0"
    ws.Range("E1").AddComment "出力。実行のたびに計算し直されます。手で直しても上書きされます"
    ws.Range("F1").AddComment "空欄なら業者が自動で割り当てられます。" & _
                              "埋めておけばその業者で固定されます"
    ws.Range("H1").AddComment "空欄なら基礎の終了日から自動で決まります。" & _
                              "手で入れるとその日付が優先されます"
    On Error GoTo 0

    ' 色名は M_業者 シートのA列から選ぶ
    On Error Resume Next
    ThisWorkbook.Names.Add Name:="色名一覧", _
        RefersTo:="=" & SH_VENDOR & "!$A$2:$A$100"
    On Error GoTo 0

    Dim k As Long, c0 As Long, taskCount As Long
    taskCount = (UBound(headers) - LBound(headers) + 1 - TASK_COL_FIRST + 1) \ TASK_COL_WIDTH
    For k = 1 To taskCount
        c0 = TASK_COL_FIRST + (k - 1) * TASK_COL_WIDTH
        ws.Range(ws.Cells(2, c0 + TASK_OFS_START), _
                 ws.Cells(2000, c0 + TASK_OFS_START)).NumberFormatLocal = "yyyy/mm/dd"
        ws.Range(ws.Cells(2, c0 + TASK_OFS_END), _
                 ws.Cells(2000, c0 + TASK_OFS_END)).NumberFormatLocal = "yyyy/mm/dd"
        ' 出力列は薄く色を付けて、入力列と見分けられるようにする
        ws.Range(ws.Cells(1, c0 + TASK_OFS_END), _
                 ws.Cells(2000, c0 + TASK_OFS_END)).Interior.Color = RGB(242, 242, 242)
        With ws.Range(ws.Cells(2, c0 + TASK_OFS_COLOR), _
                      ws.Cells(2000, c0 + TASK_OFS_COLOR)).Validation
            .Delete
            .Add Type:=xlValidateList, AlertStyle:=xlValidAlertStop, _
                 Operator:=xlBetween, Formula1:="=色名一覧"
            .IgnoreBlank = True
            .InCellDropdown = True
        End With
    Next k

    ws.Columns("A:B").ColumnWidth = 14
    ws.Range(ws.Columns(TASK_COL_FIRST), _
             ws.Columns(TASK_COL_FIRST + taskCount * TASK_COL_WIDTH - 1)).ColumnWidth = 11
End Sub

'---------------------------------------------------------------------
' M_工程データ が新形式（1物件1行・工程あたり5列）かどうか
'
' 「調整」列があるかどうかで、4列時代のものと区別する。
'---------------------------------------------------------------------
Public Function TaskSheetIsCurrent() As Boolean
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(SH_TASK)
    On Error GoTo 0
    If ws Is Nothing Then Exit Function

    If Trim$(CStr(ws.Cells(1, TASK_COL_FIRST + TASK_OFS_START).Value)) <> "基礎開始日" Then Exit Function
    If Trim$(CStr(ws.Cells(1, TASK_COL_FIRST + TASK_OFS_ADJUST).Value)) <> "基礎調整" Then Exit Function

    TaskSheetIsCurrent = True
End Function

'---------------------------------------------------------------------
' 工程表から物件一覧を M_工程データ に取り込む（ひな形作成）
'---------------------------------------------------------------------
Public Sub ImportPropertiesToTaskSheet()
    Dim wsC As Worksheet, wsT As Worksheet
    Dim blocks As Collection, b As Variant
    Dim r As Long, added As Long

    Set wsC = ChartSheet()
    Set wsT = GetOrCreateSheet(SH_TASK)
    Set blocks = FindBlocks(wsC)

    r = wsT.Cells(wsT.Rows.Count, 1).End(xlUp).Row + 1
    If r < 2 Then r = 2

    For Each b In blocks
        If Len(b(2)) > 0 Then
            If Not ContractExists(wsT, CStr(b(2))) Then
                wsT.Cells(r, 1).Value = b(2)     ' 契約番号
                wsT.Cells(r, 2).Value = b(1)     ' 邸名
                r = r + 1
                added = added + 1
            End If
        End If
    Next b

    MsgBox added & " 件の物件を " & SH_TASK & " に追加しました。" & vbCrLf & _
           "工程・開始日・終了日・色名を入力してください。", vbInformation
End Sub

Private Function ContractExists(ws As Worksheet, contract As String) As Boolean
    Dim f As Range
    Set f = ws.Columns(1).Find(What:=contract, LookIn:=xlValues, LookAt:=xlWhole)
    ContractExists = Not f Is Nothing
End Function

'--- 小物 ------------------------------------------------------------

Private Sub WriteHeader(ws As Worksheet, headers As Variant)
    WriteHeaderAt ws, 1, headers
    ' 実行のたびに切り替わらないよう、未設定のときだけ付ける
    If Not ws.AutoFilterMode Then ws.Rows(1).AutoFilter
End Sub

Private Sub WriteHeaderAt(ws As Worksheet, r As Long, headers As Variant)
    Dim i As Long
    For i = LBound(headers) To UBound(headers)
        With ws.Cells(r, i + 1)
            .Value = headers(i)
            .Font.Bold = True
            .Interior.Color = RGB(217, 217, 217)
        End With
    Next i
End Sub

Private Sub WriteRow(ws As Worksheet, r As Long, vals As Variant)
    Dim i As Long
    For i = LBound(vals) To UBound(vals)
        ws.Cells(r, i + 1).Value = vals(i)
    Next i
End Sub
