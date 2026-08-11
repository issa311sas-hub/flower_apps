Attribute VB_Name = "M01_Holiday"
Option Explicit

'=====================================================================
' M01_Holiday : 日本の祝日判定
'
' 外部データに依存せず計算で判定する（2020年以降の現行法ベース）。
' ・ハッピーマンデー(成人/海/敬老/スポーツ)
' ・春分・秋分（天文計算の近似式。1980～2099年で有効）
' ・振替休日（祝日が日曜のとき、次の非祝日を休みにする）
' ・国民の休日（祝日に挟まれた平日。9月の敬老の日～秋分の日）
'
' 会社独自の休日は無い、と確認済みのため実装していない。
' 個別の休工日を足したい場合は M_例外日 シートで物件単位に指定する。
'=====================================================================

'---------------------------------------------------------------------
' 祝日か（振替休日・国民の休日を含む）
'---------------------------------------------------------------------
Public Function IsHoliday(d As Date) As Boolean
    IsHoliday = (Len(HolidayName(d)) > 0)
End Function

'---------------------------------------------------------------------
' 非稼働日か（日曜 または 祝日）
'---------------------------------------------------------------------
Public Function IsNonWorkingDay(d As Date) As Boolean
    IsNonWorkingDay = (Weekday(d, vbSunday) = 1) Or IsHoliday(d)
End Function

'---------------------------------------------------------------------
' 祝日名を返す。祝日でなければ空文字。
'---------------------------------------------------------------------
Public Function HolidayName(d As Date) As String
    Dim nm As String
    Dim prev As Date

    ' 1) 本来の祝日
    nm = BaseHolidayName(d)
    If Len(nm) > 0 Then
        HolidayName = nm
        Exit Function
    End If

    ' 2) 振替休日 : さかのぼって日曜の祝日に行き着けば振替
    If Weekday(d, vbSunday) <> 1 Then
        prev = d - 1
        Do While Len(BaseHolidayName(prev)) > 0
            If Weekday(prev, vbSunday) = 1 Then
                HolidayName = "振替休日"
                Exit Function
            End If
            prev = prev - 1
        Loop
    End If

    ' 3) 国民の休日 : 前後が祝日に挟まれた平日
    If Weekday(d, vbSunday) <> 1 Then
        If Len(BaseHolidayName(d - 1)) > 0 And Len(BaseHolidayName(d + 1)) > 0 Then
            HolidayName = "国民の休日"
            Exit Function
        End If
    End If

    HolidayName = ""
End Function

'---------------------------------------------------------------------
' 本来の祝日（振替・国民の休日を除く）
'---------------------------------------------------------------------
Private Function BaseHolidayName(d As Date) As String
    Dim y As Long, m As Long, dd As Long
    y = Year(d): m = Month(d): dd = Day(d)

    Select Case m
        Case 1
            If dd = 1 Then BaseHolidayName = "元日": Exit Function
            If dd = NthMonday(y, 1, 2) Then BaseHolidayName = "成人の日": Exit Function
        Case 2
            If dd = 11 Then BaseHolidayName = "建国記念の日": Exit Function
            If dd = 23 And y >= 2020 Then BaseHolidayName = "天皇誕生日": Exit Function
        Case 3
            If dd = VernalEquinoxDay(y) Then BaseHolidayName = "春分の日": Exit Function
        Case 4
            If dd = 29 Then BaseHolidayName = "昭和の日": Exit Function
        Case 5
            If dd = 3 Then BaseHolidayName = "憲法記念日": Exit Function
            If dd = 4 Then BaseHolidayName = "みどりの日": Exit Function
            If dd = 5 Then BaseHolidayName = "こどもの日": Exit Function
        Case 7
            If dd = NthMonday(y, 7, 3) Then BaseHolidayName = "海の日": Exit Function
        Case 8
            If dd = 11 Then BaseHolidayName = "山の日": Exit Function
        Case 9
            If dd = NthMonday(y, 9, 3) Then BaseHolidayName = "敬老の日": Exit Function
            If dd = AutumnalEquinoxDay(y) Then BaseHolidayName = "秋分の日": Exit Function
        Case 10
            If dd = NthMonday(y, 10, 2) Then BaseHolidayName = "スポーツの日": Exit Function
        Case 11
            If dd = 3 Then BaseHolidayName = "文化の日": Exit Function
            If dd = 23 Then BaseHolidayName = "勤労感謝の日": Exit Function
    End Select

    BaseHolidayName = ""
End Function

'---------------------------------------------------------------------
' その年月の第 n 月曜の「日」を返す
'---------------------------------------------------------------------
Private Function NthMonday(y As Long, m As Long, n As Long) As Long
    Dim firstDow As Long, firstMon As Long
    firstDow = Weekday(DateSerial(y, m, 1), vbMonday)   ' 月曜=1
    firstMon = 1 + ((8 - firstDow) Mod 7)
    NthMonday = firstMon + (n - 1) * 7
End Function

'---------------------------------------------------------------------
' 春分の日（1980～2099年で有効な近似式）
'---------------------------------------------------------------------
Private Function VernalEquinoxDay(y As Long) As Long
    VernalEquinoxDay = Int(20.8431 + 0.242194 * (y - 1980) - Int((y - 1980) / 4))
End Function

'---------------------------------------------------------------------
' 秋分の日（1980～2099年で有効な近似式）
'---------------------------------------------------------------------
Private Function AutumnalEquinoxDay(y As Long) As Long
    AutumnalEquinoxDay = Int(23.2488 + 0.242194 * (y - 1980) - Int((y - 1980) / 4))
End Function

'---------------------------------------------------------------------
' 稼働日を n 日進める（日曜・祝日をスキップ）
' n = 0 なら、d 自身が非稼働日のとき次の稼働日まで送る。
'---------------------------------------------------------------------
Public Function AddWorkingDays(d As Date, n As Long) As Date
    Dim cur As Date, i As Long
    cur = d
    Do While IsNonWorkingDay(cur)
        cur = cur + 1
    Loop
    For i = 1 To n
        cur = cur + 1
        Do While IsNonWorkingDay(cur)
            cur = cur + 1
        Loop
    Next i
    AddWorkingDays = cur
End Function

'---------------------------------------------------------------------
' 2つの日付の間の稼働日数（開始日を含み、終了日を含む）
'---------------------------------------------------------------------
Public Function CountWorkingDays(dFrom As Date, dTo As Date) As Long
    Dim cur As Date, cnt As Long
    cur = dFrom
    Do While cur <= dTo
        If Not IsNonWorkingDay(cur) Then cnt = cnt + 1
        cur = cur + 1
    Loop
    CountWorkingDays = cnt
End Function

'---------------------------------------------------------------------
' 動作確認用 : 指定年の祝日を一覧表示する
'---------------------------------------------------------------------
Public Sub DebugListHolidays()
    Dim y As Long, d As Date, s As String, ans As String
    ans = InputBox("祝日を一覧表示する年を入力してください。", "祝日確認", Year(Date))
    If Len(Trim$(ans)) = 0 Then Exit Sub
    If Not IsNumeric(ans) Then
        MsgBox "年を数値で入力してください。", vbExclamation
        Exit Sub
    End If
    y = CLng(ans)
    If y < 1980 Or y > 2099 Then
        MsgBox "春分・秋分の計算式は 1980～2099年で有効です。", vbExclamation
        Exit Sub
    End If

    For d = DateSerial(y, 1, 1) To DateSerial(y, 12, 31)
        If IsHoliday(d) Then
            s = s & Format$(d, "yyyy/mm/dd (aaa)") & "  " & HolidayName(d) & vbCrLf
        End If
    Next d
    MsgBox y & "年の祝日" & vbCrLf & vbCrLf & s, vbInformation, "祝日一覧"
End Sub
