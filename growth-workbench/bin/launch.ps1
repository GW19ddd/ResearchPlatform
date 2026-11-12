# 科研工作台启动器：起后端 → 确保公网隧道（Tailscale Funnel）→ 打开浏览器
# 双击 bin\launch.vbs 调用；开机自启见 -NoBrowser。
# 幂等：已经在跑就不重复起进程；隧道每轮重下一次 serve 配置（无副作用）。
param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$port = 8000
$localUrl = "http://127.0.0.1:$port"
$log = Join-Path $PSScriptRoot 'launch.log'
$logDir = Split-Path -Parent $log
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log([string]$msg) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

# 本机 http 请求必须绕过系统代理，否则会走代理回环失败
function Get-Http([string]$url, [int]$timeoutMs = 2500) {
    try {
        $req = [System.Net.HttpWebRequest]::Create($url)
        $req.Proxy = $null
        $req.Timeout = $timeoutMs
        $req.ReadWriteTimeout = $timeoutMs
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $resp.Close()
        return $code
    } catch {
        return 0
    }
}

function Test-Up {
    return (Get-Http "$localUrl/api/health" 2500) -eq 200
}

# ---------- 1) 后端 ----------
$py = $env:WORKBENCH_PYTHON
if (-not $py) { $py = 'C:\Users\Amber\.workbuddy\binaries\python\envs\default\Scripts\python.exe' }

if (Test-Up) {
    Write-Log '后端已在运行，跳过启动'
} else {
    Write-Log '启动后端 uvicorn 127.0.0.1:8000'
    $serverLog = Join-Path $root 'server\server.log'
    $serverErr = Join-Path $root 'server\server.err.log'
    # Start-Process 的重定向是覆盖写：先把上一轮日志留档，避免失败现场被冲掉
    foreach ($f in @($serverLog, $serverErr)) {
        if ((Test-Path $f) -and ((Get-Item $f).Length -gt 0)) {
            Copy-Item $f ($f + '.prev') -Force
        }
    }
    Start-Process -FilePath $py `
        -ArgumentList '-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', "$port" `
        -WorkingDirectory (Join-Path $root 'server') `
        -WindowStyle Hidden `
        -RedirectStandardOutput $serverLog `
        -RedirectStandardError $serverErr
    $ok = $false
    # 冷启动一般 3-5 秒；沙箱/杀软扫描时可能更久，给 2 分钟余量
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Milliseconds 900
        if (Test-Up) { $ok = $true; break }
    }
    if ($ok) {
        Write-Log '后端就绪'
    } else {
        Write-Log '后端启动超时，详见 server\server.err.log'
        # 把 uvicorn 的报错尾部直接摘进 launch.log，双击启动失败时不用再翻两个日志文件
        foreach ($f in @($serverErr, $serverLog)) {
            if ((Test-Path $f) -and ((Get-Item $f).Length -gt 0)) {
                Get-Content $f -Tail 15 | ForEach-Object { Write-Log "  [$(Split-Path -Leaf $f)] $_" }
            }
        }
        if (-not (Test-Path $serverErr) -or ((Get-Item $serverErr).Length -eq 0 -and ((Get-Item $serverLog -ErrorAction SilentlyContinue).Length -eq 0))) {
            Write-Log '  uvicorn 未留下任何输出：多半是进程被杀软/策略拦掉，或 python 路径失效'
        }
    }
}

# ---------- 2) 公网隧道 ----------
$publicUrl = ''
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
if (Test-Path $ts) {
    # --bg 幂等：重复执行只会刷新同一条 serve 配置
    & $ts funnel --bg $port 2>&1 | Out-Null
    $status = (& $ts funnel status 2>&1) -join "`n"
    $m = [regex]::Match($status, 'https://[A-Za-z0-9\-\.]+\.ts\.net')
    if ($m.Success) {
        $publicUrl = $m.Value.TrimEnd('/')
        Write-Log "公网地址 $publicUrl"
    } else {
        Write-Log '未取到公网地址，检查 tailscale 登录状态'
    }
} else {
    Write-Log '未安装 tailscale，公网隧道不可用（仅本机/局域网）'
}

# 把地址落盘：换设备时照这个输入即可，不用回来翻窗口
if ($publicUrl) {
    $addrFile = Join-Path $root 'public-url.txt'
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
    @(
        "科研工作台 · 公网地址（任何设备、任何网络都能打开）"
        $publicUrl
        ''
        "本机：$localUrl"
        "更新时间：$stamp"
        ''
        '手机/平板/别的电脑直接输入上面的 https 地址即可，无需装任何客户端。'
        '服务只监听 127.0.0.1，公网入口由 Tailscale Funnel 转发，局域网内不暴露。'
    ) | Set-Content -LiteralPath $addrFile -Encoding UTF8
    Set-Clipboard -Value $publicUrl
}

# ---------- 3) 打开入口 ----------
if (-not $NoBrowser -and (Test-Up)) {
    Start-Process $localUrl
    Write-Log '已打开本机页面'
}
