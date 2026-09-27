# 一键启动科研工作台：单进程方案
# 前端构建产物由 FastAPI 直接托管，只有一个服务：http://localhost:8000
#
# 用法：右键"使用 PowerShell 运行"，或在终端执行  .\dev.ps1
# 强制重建前端：.\dev.ps1 -Rebuild
param([switch]$Rebuild)

# 可选环境变量：WORKBENCH_PYTHON / WORKBENCH_NPM
$root = Split-Path -Parent $PSCommandPath
$py = if ($env:WORKBENCH_PYTHON) { $env:WORKBENCH_PYTHON } else { "C:\Users\Amber\.workbuddy\binaries\python\envs\default\Scripts\python.exe" }
$npm = if ($env:WORKBENCH_NPM) { $env:WORKBENCH_NPM } else { "C:\Users\Amber\.workbuddy\binaries\node\versions\22.22.2-3\npm.cmd" }

# 1) 确保前端已构建（dist 不存在时自动构建）
if (-not (Test-Path "$root\web\dist\index.html") -or $Rebuild) {
    Write-Host "构建前端（首次约 1-2 分钟）..."
    Push-Location "$root\web"
    & $npm run build
    Pop-Location
}

# 2) 若已在运行，先停掉旧的（按端口找进程）
$old = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if ($old) {
    $old | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
        try { Stop-Process -Id $_ -Force -ErrorAction Stop } catch {}
    }
    Start-Sleep -Seconds 1
}

# 3) 用独立进程启动（脱离当前终端，关掉窗口也继续跑）
Start-Process -WindowStyle Minimized -FilePath $py -ArgumentList "-m", "uvicorn", "main:app", "--port", "8000" -WorkingDirectory "$root\server"

Start-Sleep -Seconds 4
Write-Host ""
Write-Host "✅ 工作台已启动（独立进程，关闭本窗口不影响）"
Write-Host "   地址：http://localhost:8000"
Write-Host "   画布：http://localhost:8000/canvas"
Write-Host "   设置：http://localhost:8000/settings"
Write-Host "   停止：Stop-Process -Name python（或任务管理器结束 python.exe）"
