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
    Application.ScreenUpdating = False

    SetupVendorSheet
    SetupExceptionSheet
    SetupTermSheet
    SetupTaskSheet

    Application.ScreenUpdating = True
    MsgBox "マスタシートを作成しました。" & vbCrLf & vbCrLf & _
           SH_VENDOR & " : 業者と色の対応" & vbCrLf & _
           SH_EXCEPT & " : 物件ごとの祝日例外" & vbCrLf & _
           SH_TERM & " : 標準工期" & vbCrLf & _
           SH_TASK & " : 工程データ（色塗りの元データ）", _
           vbInformation, "セットアップ完了"
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
        Array("黒", 0, 0, 0, "コテ", "", "契約着工日(1日)にも使用。行で区別する"), _
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
' 過去データ46物件の実測中央値を初期値として入れてある。
' 工事店さまの確認後にこの表を直せば、以降の自動生成に反映される。
'---------------------------------------------------------------------
Private Sub SetupTermSheet()
    Dim ws As Worksheet, isNew As Boolean
    Set ws = GetOrCreateSheet(SH_TERM)
    isNew = (Len(Trim$(CStr(ws.Cells(1, 1).Value))) = 0)

    WriteHeader ws, Array("坪下限", "坪上限", "基礎_稼働日", "基礎_暦日", "躯体_稼働日", "コテ_稼働日", "根拠件数")
    If Not isNew Then Exit Sub

    Dim rows As Variant, i As Long
    rows = Array( _
        Array(0, 32, 10, 20, 4, 3, 6), _
        Array(33, 39, 10, 22, 4, 3, 23), _
        Array(40, 47, 10, 18, 4, 3, 4), _
        Array(48, 55, 9, 18, 6, 4, 2), _
        Array(56, 70, 15, 26, 6, 4, 8), _
        Array(71, 100, 16, 32, 10, 4, 1), _
        Array(101, 999, 28, 40, 11, 6, 2) _
    )
    For i = LBound(rows) To UBound(rows)
        WriteRow ws, i + 2, rows(i)
    Next i

    Dim r As Long
    r = UBound(rows) + 4
    ws.Cells(r, 1).Value = "補正"
    ws.Cells(r, 1).Font.Bold = True
    ws.Cells(r + 1, 1).Value = "3階建て"
    ws.Cells(r + 1, 5).Value = 2
    ws.Cells(r + 1, 7).Value = "躯体に加算（実測: R3F36=6日 vs C2E36=3～4日）"
    ws.Cells(r + 2, 1).Value = "契約着工日→基礎着手"
    ws.Cells(r + 2, 4).Value = 2
    ws.Cells(r + 2, 7).Value = "暦日。実測 1～7日、中央値2日"
    ws.Cells(r + 3, 1).Value = "基礎完了→躯体着手"
    ws.Cells(r + 3, 4).Value = 4
    ws.Cells(r + 3, 7).Value = "暦日。実測 2～11日、中央値4日"
    ws.Cells(r + 4, 1).Value = "躯体完了→コテ着手"
    ws.Cells(r + 4, 4).Value = 2
    ws.Cells(r + 4, 7).Value = "暦日。間に穴明け1日が入る"

    ws.Columns("A:G").AutoFit
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

    With ws.Range("C2:C2000").Validation
        .Delete
        .Add Type:=xlValidateList, AlertStyle:=xlValidAlertStop, _
             Operator:=xlBetween, Formula1:="契約着工日,基礎,躯体,コテ,外構"
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
    Dim i As Long
    For i = LBound(headers) To UBound(headers)
        With ws.Cells(1, i + 1)
            .Value = headers(i)
            .Font.Bold = True
            .Interior.Color = RGB(217, 217, 217)
        End With
    Next i
    ' 実行のたびに切り替わらないよう、未設定のときだけ付ける
    If Not ws.AutoFilterMode Then ws.Rows(1).AutoFilter
End Sub

Private Sub WriteRow(ws As Worksheet, r As Long, vals As Variant)
    Dim i As Long
    For i = LBound(vals) To UBound(vals)
        ws.Cells(r, i + 1).Value = vals(i)
    Next i
End Sub
