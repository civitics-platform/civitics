<#
check_env.ps1
Quick environment checker for CLAUDE.md setup recommendations.
Usage: run in PowerShell from Windows. Optionally pass -ProjectPath.
Example: .\scripts\check_env.ps1 -ProjectPath 'C:\Users\Craig\Documents\Civitics\App'
#>
param(
    [string]$ProjectPath = (Get-Location).Path
)

Write-Host "== Civitics Environment Quick Check ==" -ForegroundColor Cyan

Write-Host "Checking WSL installation..." -NoNewline
try {
    $wsl = wsl -l -v 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host " OK" -ForegroundColor Green
        Write-Host $wsl
    } else {
        Write-Host " NOT FOUND" -ForegroundColor Yellow
        Write-Host "Run: wsl --install -d Ubuntu" -ForegroundColor Gray
    }
} catch {
    Write-Host " NOT FOUND" -ForegroundColor Yellow
    Write-Host "Run: wsl --install -d Ubuntu" -ForegroundColor Gray
}

Write-Host "\nChecking project path location..." -NoNewline
if ($ProjectPath -like "\\wsl$*" -or $ProjectPath -like "/mnt/*") {
    Write-Host " In WSL filesystem" -ForegroundColor Green
    Write-Host "Good: project is inside WSL. You can run WSL checks directly." -ForegroundColor Gray
} else {
    Write-Host " On Windows filesystem" -ForegroundColor Yellow
    Write-Host "Recommendation: move project into WSL (e.g. ~/projects/civitics) for best results." -ForegroundColor Gray
}

Write-Host "\nChecking Docker (optional)..." -NoNewline
try {
    $docker = docker --version 2>&1
    if ($LASTEXITCODE -eq 0) { Write-Host " OK" -ForegroundColor Green; Write-Host $docker }
    else { Write-Host " NOT FOUND" -ForegroundColor Yellow; Write-Host "Install Docker Desktop and enable WSL integration." -ForegroundColor Gray }
} catch { Write-Host " NOT FOUND" -ForegroundColor Yellow; Write-Host "Install Docker Desktop and enable WSL integration." -ForegroundColor Gray }

Write-Host "\nNext: run the WSL-side checker inside your WSL distro to verify nvm/node and global tools." -ForegroundColor Cyan
Write-Host 'If WSL is available, open WSL and run: bash ~/projects/civitics/scripts/wsl_check.sh' -ForegroundColor Gray

Write-Host "\nDone. Review the output and follow suggestions above." -ForegroundColor Cyan
