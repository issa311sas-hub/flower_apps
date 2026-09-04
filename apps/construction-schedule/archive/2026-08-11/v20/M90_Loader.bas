Attribute VB_Name = "M90_Loader"
Option Explicit

'=====================================================================
' M90_Loader : マクロを1ファイルから入れ替える
'
' モジュールを7つ取り込むのは手間なので、全部を1つにまとめた
' テキストファイル（工程表マクロ.txt）から一括で入れ替える。
'
' ■ 使い方
'   1. このモジュール（M90_Loader）だけ、最初に1回インポートする
'   2. 以降は「ボタン_マクロを更新」を実行し、
'      ダウンロードした 工程表マクロ.txt を選ぶだけ
'
' ■ 事前に1回だけ必要な設定
'   ファイル → オプション → トラスト センター
'     → トラスト センターの設定 → マクロの設定
'     → 「VBA プロジェクト オブジェクト モデルへのアクセスを信頼する」にチェック
'
'   この設定が無いと、マクロからモジュールを入れ替えられない。
'   （設定していない場合は、これまでどおり手で7つ取り込んでも同じです）
'
' ■ 文字化けしない
' ファイルは UTF-8 として読む。VBE の「ファイルのインポート」と違い、
' Shift-JIS への変換が要らないので文字化けしない。
'
' ■ 自分自身は入れ替えない
' 実行中のモジュールを消すと止まるため、M90_Loader だけは飛ばす。
' ローダー自体を新しくしたいときは、手でインポートし直す。
'=====================================================================

' 1ファイルのなかで、モジュールの区切りに入っている目印
Public Const BUNDLE_MODULE As String = ">>>MODULE:"
Public Const BUNDLE_FORM   As String = ">>>USERFORM:"

' VBComponents.Add に渡す種類（vbext_ComponentType）
Private Const CT_STD_MODULE As Long = 1
Private Const CT_MSFORM     As Long = 3

'=====================================================================
' メイン : 1ファイルからマクロを入れ替える
'=====================================================================
Public Sub ボタン_マクロを更新()
    Dim path As Variant
    Dim text As String
    Dim parts As Object
    Dim vbp As Object
    Dim key As Variant
    Dim added As String, skipped As String
    Dim cnt As Long

    ' --- ファイルを選ぶ ---------------------------------------------
    path = Application.GetOpenFilename( _
           "工程表マクロのファイル (*.txt),*.txt", , "工程表マクロ.txt を選んでください")
    If VarType(path) = vbBoolean Then Exit Sub     ' キャンセル

    ' --- 読む（UTF-8） ----------------------------------------------
    text = ReadUtf8(CStr(path))
    If Len(text) = 0 Then
        MsgBox "ファイルを読めませんでした。" & vbCrLf & CStr(path), vbExclamation, "マクロを更新"
        Exit Sub
    End If

    Set parts = SplitBundle(text)
    If parts.Count = 0 Then
        MsgBox "このファイルにモジュールが入っていません。" & vbCrLf & vbCrLf & _
               "「工程表マクロ.txt」を選んでください。", vbExclamation, "マクロを更新"
        Exit Sub
    End If

    ' --- VBA プロジェクトに触れるか確認 ------------------------------
    On Error Resume Next
    Set vbp = ThisWorkbook.VBProject
    On Error GoTo 0

    If vbp Is Nothing Then
        MsgBox "マクロからモジュールを入れ替える設定が入っていません。" & vbCrLf & vbCrLf & _
               "ファイル → オプション → トラスト センター" & vbCrLf & _
               "  → トラスト センターの設定 → マクロの設定" & vbCrLf & _
               "  → 「VBA プロジェクト オブジェクト モデルへのアクセスを信頼する」" & vbCrLf & _
               "にチェックを入れて、Excel を開き直してから実行してください。" & vbCrLf & vbCrLf & _
               "この設定を使いたくない場合は、これまでどおり" & vbCrLf & _
               "vba/sjis/ の .bas を手で取り込んでも同じ結果になります。", _
               vbExclamation, "マクロを更新"
        Exit Sub
    End If

    ' --- 確認 -------------------------------------------------------
    For Each key In parts.Keys
        added = added & "  " & CStr(key) & vbCrLf
    Next key

    If MsgBox(parts.Count & " 個のモジュールを入れ替えます。" & vbCrLf & vbCrLf & _
              added & vbCrLf & _
              "同じ名前のモジュールがあれば、いったん削除して入れ直します。" & vbCrLf & _
              "元に戻す（Ctrl+Z）は効きません。よろしいですか？", _
              vbYesNo + vbQuestion, "マクロを更新") <> vbYes Then Exit Sub

    ' --- 入れ替える -------------------------------------------------
    added = ""
    Application.ScreenUpdating = False

    For Each key In parts.Keys
        If CStr(key) = "M90_Loader" Then
            skipped = skipped & "  " & CStr(key) & "（実行中のため）" & vbCrLf
        ElseIf ReplaceComponent(vbp, CStr(key), CStr(parts(key))) Then
            added = added & "  " & CStr(key) & vbCrLf
            cnt = cnt + 1
        Else
            skipped = skipped & "  " & CStr(key) & "（入れ替えに失敗）" & vbCrLf
        End If
    Next key

    Application.ScreenUpdating = True

    Dim msg As String
    msg = cnt & " 個のモジュールを入れ替えました。" & vbCrLf & vbCrLf & added
    If Len(skipped) > 0 Then msg = msg & vbCrLf & "入れ替えなかったもの:" & vbCrLf & skipped
    msg = msg & vbCrLf & "■ このあと" & vbCrLf & _
          "  1. ブックを保存する" & vbCrLf & _
          "  2. 「ボタン_初期セットアップ」を実行する"

    MsgBox msg, vbInformation, "マクロを更新"
End Sub

'---------------------------------------------------------------------
' モジュールを1つ入れ替える
'
' 同じ名前があれば削除してから、新しく作って中身を流し込む。
'---------------------------------------------------------------------
Private Function ReplaceComponent(vbp As Object, compName As String, _
                                  code As String) As Boolean
    Dim comp As Object
    Dim isForm As Boolean
    Dim realName As String

    isForm = (Left$(compName, 2) = "F_")
    realName = compName

    ' 既にあれば消す
    On Error Resume Next
    Set comp = vbp.VBComponents(realName)
    On Error GoTo 0
    If Not comp Is Nothing Then
        On Error Resume Next
        vbp.VBComponents.Remove comp
        On Error GoTo 0
        Set comp = Nothing
    End If

    ' 作って中身を入れる
    On Error GoTo Fail
    If isForm Then
        Set comp = vbp.VBComponents.Add(CT_MSFORM)
    Else
        Set comp = vbp.VBComponents.Add(CT_STD_MODULE)
    End If
    comp.Name = realName
    comp.CodeModule.AddFromString code

    ReplaceComponent = True
    Exit Function

Fail:
    ReplaceComponent = False
End Function

'---------------------------------------------------------------------
' 1ファイルをモジュールごとに切り分ける
'
' 行頭がアポストロフィ + 目印 + モジュール名 の行で区切られている。
' 戻り値 : モジュール名 -> コード
'---------------------------------------------------------------------
Private Function SplitBundle(text As String) As Object
    Dim map As Object
    Dim lines As Variant, i As Long
    Dim t As String, cur As String, buf As String

    Set map = CreateObject("Scripting.Dictionary")

    text = Replace$(text, vbCrLf, vbLf)
    text = Replace$(text, vbCr, vbLf)
    lines = Split(text, vbLf)

    For i = LBound(lines) To UBound(lines)
        t = Trim$(CStr(lines(i)))

        ' 目印は「行頭が ' のすぐあとに目印」のときだけ。
        ' 説明文のなかに目印が出てきても切らないようにする。
        If Left$(t, 1 + Len(BUNDLE_MODULE)) = "'" & BUNDLE_MODULE Then
            If Len(cur) > 0 Then map(cur) = buf
            cur = Trim$(Mid$(t, 2 + Len(BUNDLE_MODULE)))
            buf = ""
        ElseIf Left$(t, 1 + Len(BUNDLE_FORM)) = "'" & BUNDLE_FORM Then
            If Len(cur) > 0 Then map(cur) = buf
            cur = Trim$(Mid$(t, 2 + Len(BUNDLE_FORM)))
            buf = ""
        ElseIf Len(cur) > 0 Then
            buf = buf & CStr(lines(i)) & vbCrLf
        End If
    Next i

    If Len(cur) > 0 Then map(cur) = buf

    Set SplitBundle = map
End Function

'---------------------------------------------------------------------
' UTF-8 のテキストファイルを読む
'
' ADODB.Stream を使う。BOM の有無は気にしなくてよい。
'---------------------------------------------------------------------
Private Function ReadUtf8(path As String) As String
    Dim st As Object

    On Error GoTo Fail
    Set st = CreateObject("ADODB.Stream")
    st.Charset = "UTF-8"
    st.Type = 2                 ' adTypeText
    st.Open
    st.LoadFromFile path
    ReadUtf8 = st.ReadText
    st.Close
    Exit Function

Fail:
    ReadUtf8 = ""
End Function

'=====================================================================
' いま入っているモジュールを確認する
'=====================================================================
Public Sub ボタン_モジュール一覧()
    Dim vbp As Object, comp As Object, msg As String, cnt As Long

    On Error Resume Next
    Set vbp = ThisWorkbook.VBProject
    On Error GoTo 0

    If vbp Is Nothing Then
        MsgBox "VBA プロジェクトへのアクセスが許可されていません。" & vbCrLf & _
               "「ボタン_マクロを更新」の説明を参照してください。", vbExclamation
        Exit Sub
    End If

    For Each comp In vbp.VBComponents
        msg = msg & "  " & comp.Name & "  （" & ComponentKind(comp.Type) & "）" & vbCrLf
        cnt = cnt + 1
    Next comp

    MsgBox "このブックに入っているもの : " & cnt & " 個" & vbCrLf & vbCrLf & msg, _
           vbInformation, "モジュール一覧"
End Sub

Private Function ComponentKind(t As Long) As String
    Select Case t
        Case 1: ComponentKind = "標準モジュール"
        Case 2: ComponentKind = "クラス"
        Case 3: ComponentKind = "ユーザーフォーム"
        Case 100: ComponentKind = "シート／ブック"
        Case Else: ComponentKind = "その他"
    End Select
End Function
