param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('check','status','import','activate','deactivate','resolve')]
    [string]$Action,
    [string]$Operation,
    [ValidateSet('retry','delivered')][string]$Resolution,
    [long]$MessageId
)
$ErrorActionPreference = 'Stop'
$baseUrl = 'https://sibadi-schedule-bot.vkspaz780.workers.dev'
$secure = Read-Host 'WEBHOOK_SECRET (скрытый ввод)' -AsSecureString
$secret = [Net.NetworkCredential]::new('', $secure).Password
try {
    $body = @{}
    if ($Action -eq 'import') {
        $snapshot = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../state.json') -Raw | ConvertFrom-Json
        $body = @{state=$snapshot}
    }
    if ($Action -eq 'resolve') {
        if (!$Operation -or !$Resolution) { throw 'Укажите -Operation и -Resolution.' }
        if ($Resolution -eq 'delivered' -and $MessageId -lt 1) { throw 'Укажите -MessageId.' }
        $body = @{operation=$Operation;action=$Resolution;messageId=$MessageId}
    }
    $result = Invoke-RestMethod -Method Post -Uri "$baseUrl/$Action" `
        -Headers @{Authorization="Bearer $secret"} -ContentType 'application/json' `
        -Body ([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 20))) -TimeoutSec 90
    $result | ConvertTo-Json -Depth 10
} catch {
    # Do not dump the request or authorization headers.
    Write-Error 'Запрос не выполнен. Проверьте доступность Worker, привязки, секрет и порядок перехода. Значение секрета не отправляйте в чат.'
} finally {
    $secret = $null
    $secure.Dispose()
}
