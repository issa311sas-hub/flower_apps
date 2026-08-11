Attribute VB_Name = "M02_Masters"
Option Explicit

'=====================================================================
' M02_Masters : マスタシートの生成と初期化
'
' 「見た目は現行のまま、データは別シートで管理する」方針にもとづき、
' 参照用のマスタシートをここでまとめて作る。
' 既存シートがある場合、見出しだけ整えて中身は消さない。
'=====================================================================

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

    SetupSettingSheet activeName
    SetupVendorSheet
    SetupExceptionSheet
    SetupTermSheet
    SetupTaskSheet

    Application.ScreenUpdating = True
    MsgBox "マスタシートを作成しました。" & vbCrLf & vbCrLf & _
           SH_SETTING & " : 工程表シートの指定" & vbCrLf & _
           SH_VENDOR & " : 業者と色の対応" & vbCrLf & _
           SH_EXCEPT & " : 物件ごとの祝日例外" & vbCrLf & _
           SH_TERM & " : 標準工期" & vbCrLf & _
           SH_TASK & " : 工程データ（色塗りの元データ）" & vbCrLf & vbCrLf & _
           "工程表シート : " & IIf(Len(ChartSheetName()) > 0, ChartSheetName(), "（未設定）"), _
           vbInformation, "セットアップ完了"
End Sub

'---------------------------------------------------------------------
' M_設定 : どのシートを工程表として扱うか
'
' ブックによって工程表シートの名前が違う（"1" / "工程表実データ" 等）ため、
' 決め打ちにせずここで指定する。
'---------------------------------------------------------------------
Private Sub SetupSettingSheet(defaultChartName As String)
    Dim ws As Worksheet, isNew As Boolean
    Set ws = GetOrCreateSheet(SH_SETTING)
    isNew = (Len(Trim$(CStr(ws.Cells(1, 1).Value))) = 0)

    With ws.Range("A1")
        .Value = "工程表シート名"
        .Font.Bold = True
        .Interior.Color = RGB(217, 217, 217)
    End With
    ws.Range("C1").Value = "← 色を塗る対象のシート。空欄なら開いているシートを使う"

    If isNew And Len(defaultChartName) > 0 Then
        ws.Range("B1").Value = defaultChartName
    End If

    ' ブック内のシート名から選べるようにする
    Dim src As Worksheet, list As String
    For Each src In ThisWorkbook.Worksheets
        If Not IsMasterSheet(src.Name) Then
            If Len(list) > 0 Then list = list & ","
            list = list & src.Name
        End If
    Next src

    On Error Resume Next
    With ws.Range("B1").Validation
        .Delete
        If Len(list) > 0 And Len(list) < 255 Then
            .Add Type:=xlValidateList, AlertStyle:=xlValidAlertStop, _
                 Operator:=xlBetween, Formula1:=list
            .IgnoreBlank = True
            .InCellDropdown = True
        End If
    End With
    On Error GoTo 0

    ws.Columns("A:A").ColumnWidth = 18
    ws.Columns("B:B").ColumnWidth = 24
End Sub

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

    WriteHeader ws, Array("色名", "R", "G", "B", "工種", "業者名", "備考")
    If Not isNew Then Exit Sub

    ' 過去の工程表から実測した色。業者名は分かる範囲で後から埋める。
    Dim rows As Variant, i As Long
    rows = Array( _
        Array("茶", 153, 51, 0, "躯体", "", "躯体チームA"), _
        Array("薄紫", 204, 153, 255, "躯体", "", "躯体チームB / 外構フェーズ2でも使用"), _
        Array("青", 0, 102, 204, "基礎", "", ""), _
        Array("赤桃", 255, 128, 128, "基礎", "", ""), _
        Array("緑", 0, 128, 0, "基礎", "", ""), _
        Array("桃", 255, 0, 255, "基礎", "", ""), _
        Array("黄", 255, 255, 0, "基礎", "", ""), _
        Array("水色", 153, 204, 255, "外構", "", "外構フェーズ1"), _
        Array("黒", 0, 0, 0, "モルタル", "", "契約着工日(1日)にも使用。行で区別する"), _
        Array("淡水", 204, 255, 255, "足場", "", "内部足場を含む"), _
        Array("金", 255, 204, 0, "行事", "", "社内行事・タイル工事"), _
        Array("白", 255, 255, 255, "単発", "", "家具搬入・器具・CL 等") _
    )

    For i = LBound(rows) To UBound(rows)
        WriteRow ws, i + 2, rows(i)
        ws.Cells(i + 2, 1).Interior.Color = RGB(rows(i)(1), rows(i)(2), rows(i)(3))
    Next i

    ws.Columns("A:G").AutoFit
End Sub

'---------------------------------------------------------------------
' M_例外日 : 物件ごとの祝日例外
'
' 区分:
'   非祝日扱い … その物件だけ、その日を稼働日として扱う（塗らない）
'   臨時休工   … その物件だけ、平日でも休みとして塗る
'---------------------------------------------------------------------
Private Sub SetupExceptionSheet()
    Dim ws As Worksheet, isNew As Boolean
    Set ws = GetOrCreateSheet(SH_EXCEPT)
    isNew = (Len(Trim$(CStr(ws.Cells(1, 1).Value))) = 0)

    WriteHeader ws, Array("契約番号", "日付", "区分", "備考")
    If Not isNew Then Exit Sub

    ' 区分列にプルダウンを設定
    With ws.Range("C2:C1000").Validation
        .Delete
        .Add Type:=xlValidateList, AlertStyle:=xlValidAlertStop, _
             Operator:=xlBetween, Formula1:="非祝日扱い,臨時休工"
        .IgnoreBlank = True
        .InCellDropdown = True
    End With

    ws.Range("B2:B1000").NumberFormatLocal = "yyyy/mm/dd"
    ws.Columns("A:D").ColumnWidth = 16
End Sub

'---------------------------------------------------------------------
' M_工期 : 標準工期マスタ
'
' 工期は次の式で計算する。
'
'     稼働日数 = ROUND(基準日数 + 坪係数 × 坪数) + 種類補正
'
' 基準日数・坪係数は C 種 29 件の回帰、種類補正はその残差から求めた。
' 工事店さまの確認後にこの表を直せば、以降の自動計算に反映される。
'---------------------------------------------------------------------
Public Const TERM_ROW_FORMULA As Long = 2    ' 基準式ブロックの先頭行
Public Const TERM_ROW_CORRECT As Long = 8    ' 種類補正ブロックの先頭行

' 新形式であることの目印。A1 にこの文字が入っている。
Private Const TERM_MARKER As String = "基準式"

Private Sub SetupTermSheet()
    Dim ws As Worksheet, isNew As Boolean
    Dim i As Long, r As Long, rows As Variant

    Set ws = GetOrCreateSheet(SH_TERM)
    isNew = (Len(Trim$(CStr(ws.Cells(1, 1).Value))) = 0)

    ' 旧形式（坪帯ごとの一覧表）が残っていたら、退避して作り直す。
    ' 計算式は旧形式では表現できないため、そのままでは工期を計算できない。
    If Not isNew Then
        If Not TermSheetIsCurrent() Then
            BackupSheet ws
            Set ws = GetOrCreateSheet(SH_TERM)
            isNew = True
        End If
    End If

    If Not isNew Then Exit Sub

    ' --- 基準式（C 種基準） ---
    ws.Range("A1").Value = "■ 基準式：稼働日数 = ROUND(基準日数 + 坪係数 × 坪数) + 種類補正"
    ws.Range("A1").Font.Bold = True

    WriteHeaderAt ws, TERM_ROW_FORMULA, Array("工程", "基準日数", "坪係数", "備考")
    rows = Array( _
        Array("基礎", 6.37, 0.1075, "C種29件の回帰。平均絶対誤差 2.2日"), _
        Array("躯体", -0.21, 0.1103, "C種29件の回帰。平均絶対誤差 0.6日（Phase2で使用）"), _
        Array("基礎_暦日", 17.59, 0.0976, "参考値。養生等の中断を含む実績スパン。誤差が大きく自動計算には未使用") _
    )
    For i = LBound(rows) To UBound(rows)
        WriteRow ws, TERM_ROW_FORMULA + 1 + i, rows(i)
    Next i

    ' --- 種類補正 ---
    r = TERM_ROW_CORRECT
    ws.Cells(r - 1, 1).Value = "■ 建物種類による補正（日数に加算）"
    ws.Cells(r - 1, 1).Font.Bold = True

    WriteHeaderAt ws, r, Array("種類", "基礎補正", "躯体補正", "件数", "根拠")
    rows = Array( _
        Array("C", 0, 0, 29, "基準"), _
        Array("R", 3, 1, 6, "工事店確認済：基礎・躯体ともC より長い。実測 +2.6 / +0.5"), _
        Array("P", 0, 1, 1, "工事店確認済：基礎はCと同じ、躯体だけ長い"), _
        Array("D", 1, 0, 5, "実測のみ +1.4 / +0.1"), _
        Array("DY", -2, 0, 3, "実測のみ -1.6 / +0.2　※要確認"), _
        Array("M", 5, -2, 2, "実測のみ。大規模は別扱いの可能性　※要確認"), _
        Array("V", 0, 0, 0, "データなし。Cと同じ扱い　※要確認") _
    )
    For i = LBound(rows) To UBound(rows)
        WriteRow ws, r + 1 + i, rows(i)
    Next i

    ' --- 工程間インターバル（Phase2 用の参考値） ---
    r = r + UBound(rows) + 3
    ws.Cells(r, 1).Value = "■ 工程間インターバル（暦日・Phase2 で使用）"
    ws.Cells(r, 1).Font.Bold = True
    WriteHeaderAt ws, r + 1, Array("区間", "日数", "", "", "備考")
    ws.Cells(r + 2, 1).Value = "契約着工日→基礎着手"
    ws.Cells(r + 2, 2).Value = 2
    ws.Cells(r + 2, 5).Value = "実測 1～7日、中央値2日"
    ws.Cells(r + 3, 1).Value = "基礎完了→躯体着手"
    ws.Cells(r + 3, 2).Value = 4
    ws.Cells(r + 3, 5).Value = "実測 2～11日、中央値4日"
    ws.Cells(r + 4, 1).Value = "躯体完了→モルタル着手"
    ws.Cells(r + 4, 2).Value = 2
    ws.Cells(r + 4, 5).Value = "間に穴明け1日が入る"

    ws.Columns("A:E").AutoFit
End Sub

'---------------------------------------------------------------------
' M_工期 が新形式（計算式ベース）かどうか
'
' 旧版のマクロで作られた坪帯ごとの一覧表だと工期を計算できないため、
' 実行前にこれで判定する。
'---------------------------------------------------------------------
Public Function TermSheetIsCurrent() As Boolean
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(SH_TERM)
    On Error GoTo 0
    If ws Is Nothing Then Exit Function

    If InStr(1, CStr(ws.Range("A1").Value), TERM_MARKER) = 0 Then Exit Function
    If Trim$(CStr(ws.Cells(TERM_ROW_FORMULA + 1, 1).Value)) <> "基礎" Then Exit Function

    TermSheetIsCurrent = True
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

'---------------------------------------------------------------------
' M_工期 から、指定タイプの稼働日数を計算する
'
' taskName : "基礎" または "躯体"
' 戻り値   : 稼働日数（1 未満にはならない）。タイプが読めなければ 0
'---------------------------------------------------------------------
Public Function TermDays(taskName As String, typeCode As String) As Long
    Dim ws As Worksheet
    Dim kind As String, floors As Long, area As Long
    Dim baseDays As Double, coef As Double, corr As Long
    Dim r As Long, found As Boolean

    If Not ParseType(typeCode, kind, floors, area) Then Exit Function

    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(SH_TERM)
    On Error GoTo 0
    If ws Is Nothing Then Exit Function

    ' 基準式を探す
    For r = TERM_ROW_FORMULA + 1 To TERM_ROW_FORMULA + 5
        If Trim$(CStr(ws.Cells(r, 1).Value)) = taskName Then
            baseDays = CDbl(ws.Cells(r, 2).Value)
            coef = CDbl(ws.Cells(r, 3).Value)
            found = True
            Exit For
        End If
    Next r
    If Not found Then Exit Function

    ' 種類補正を探す（見つからなければ 0 のまま）
    For r = TERM_ROW_CORRECT + 1 To TERM_ROW_CORRECT + 20
        If Trim$(CStr(ws.Cells(r, 1).Value)) = kind Then
            If taskName = "躯体" Then
                corr = CLng(ws.Cells(r, 3).Value)
            Else
                corr = CLng(ws.Cells(r, 2).Value)
            End If
            Exit For
        End If
    Next r

    TermDays = CLng(Application.WorksheetFunction.Round(baseDays + coef * area, 0)) + corr
    If TermDays < 1 Then TermDays = 1
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
' 工程表への色塗りは必ずこのシートを経由する。
' 日程がずれたらここの日付だけ直し、「色を塗り直す」を実行する。
'---------------------------------------------------------------------
Private Sub SetupTaskSheet()
    Dim ws As Worksheet, isNew As Boolean
    Set ws = GetOrCreateSheet(SH_TASK)
    isNew = (Len(Trim$(CStr(ws.Cells(1, 1).Value))) = 0)

    WriteHeader ws, Array("契約番号", "邸名", "工程", "開始日", "終了日", "色名", "備考")
    If Not isNew Then Exit Sub

    ' 使い方が分かるようヘッダにコメントを付ける（新規作成時のみ）
    On Error Resume Next
    ws.Range("E1").AddComment "「基礎の工程を作る」を実行すると自動で入ります"
    ws.Range("F1").AddComment "空欄なら業者が自動で割り当てられます。" & _
                              "埋めておけばその業者で固定されます"
    On Error GoTo 0

    With ws.Range("C2:C2000").Validation
        .Delete
        .Add Type:=xlValidateList, AlertStyle:=xlValidAlertStop, _
             Operator:=xlBetween, Formula1:="契約着工日,基礎,躯体,モルタル,外構"
        .IgnoreBlank = True
        .InCellDropdown = True
    End With

    ' 色名は M_業者 シートのA列から選ぶ
    On Error Resume Next
    ThisWorkbook.Names.Add Name:="色名一覧", _
        RefersTo:="=" & SH_VENDOR & "!$A$2:$A$100"
    On Error GoTo 0
    With ws.Range("F2:F2000").Validation
        .Delete
        .Add Type:=xlValidateList, AlertStyle:=xlValidAlertStop, _
             Operator:=xlBetween, Formula1:="=色名一覧"
        .IgnoreBlank = True
        .InCellDropdown = True
    End With

    ws.Range("D2:E2000").NumberFormatLocal = "yyyy/mm/dd"
    ws.Columns("A:G").ColumnWidth = 14
End Sub

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
