<#
.SYNOPSIS
    Instala AWS CLI v2 e Terraform (>= 1.10) no Windows, via winget.

.DESCRIPTION
    Alternativa ao script do WSL. Use este se preferir trabalhar com PowerShell
    nativo em vez de Ubuntu. O caminho recomendado pelo guia (docs/03) continua
    sendo o WSL; este script existe para quem quer o atalho no Windows.

    Nao use `choco install terraform`: o Chocolatey NAO esta instalado nesta
    maquina. Os gerenciadores disponiveis aqui sao winget e scoop.

.PARAMETER Force
    Reinstala mesmo que `aws` e `terraform` ja respondam no PATH.

.EXAMPLE
    pwsh -ExecutionPolicy Bypass -File .\scripts\install-toolchain-windows.ps1
#>
[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Write-Ok   { param($m) Write-Host "OK    $m" -ForegroundColor Green }
function Write-Info { param($m) Write-Host "..    $m" -ForegroundColor Cyan }
function Write-Warn { param($m) Write-Host "AVISO $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "FALHA $m" -ForegroundColor Red }

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Get-TerraformVersion {
    try { return (terraform version | Select-Object -First 1) -replace '^Terraform v', '' } catch { return $null }
}

function Test-MinVersion {
    param([string]$Current, [string]$Minimum)
    if (-not $Current) { return $false }
    $c = $Current.Split('-')[0].Split('.')
    $m = $Minimum.Split('.')
    for ($i = 0; $i -lt [Math]::Max($c.Count, $m.Count); $i++) {
        $cv = if ($i -lt $c.Count) { [int]$c[$i] } else { 0 }
        $mv = if ($i -lt $m.Count) { [int]$m[$i] } else { 0 }
        if ($cv -gt $mv) { return $true }
        if ($cv -lt $mv) { return $false }
    }
    return $true
}

Write-Host ""
Write-Host "=== Toolchain AWS + Terraform (Windows) ===" -ForegroundColor White
Write-Host ""

# --- 0. o que ja existe ----------------------------------------------------
Update-SessionPath
$awsNow  = Get-Command aws       -ErrorAction SilentlyContinue
$tfNow   = Get-Command terraform -ErrorAction SilentlyContinue
Write-Info ("aws       : " + $(if ($awsNow) { $awsNow.Source } else { 'ausente' }))
Write-Info ("terraform : " + $(if ($tfNow)  { $tfNow.Source }  else { 'ausente' }))

if (-not $Force -and $awsNow -and $tfNow) {
    $v = Get-TerraformVersion
    if (Test-MinVersion -Current $v -Minimum '1.10') {
        Write-Ok "ambos ja instalados e Terraform v$v >= 1.10. Nada a fazer (use -Force para reinstalar)."
        return
    }
    Write-Warn "Terraform v$v e anterior a 1.10; vou atualizar."
}

# --- 1. gerenciador de pacotes --------------------------------------------
$winget = Get-Command winget -ErrorAction SilentlyContinue
$scoop  = Get-Command scoop  -ErrorAction SilentlyContinue
if (-not $winget -and -not $scoop) {
    Write-Err "nem winget nem scoop disponiveis. Instale o AWS CLI v2 e o Terraform manualmente:"
    Write-Host "      https://awscli.amazonaws.com/AWSCLIV2.msi"
    Write-Host "      https://developer.hashicorp.com/terraform/install"
    exit 1
}

if ($winget) {
    Write-Info "instalando/atualizando via winget (pode abrir o prompt do UAC - aceite)..."
    $pkgs = @(
        @{ Id = 'Amazon.AWSCLI';       Name = 'AWS CLI v2' },
        @{ Id = 'Hashicorp.Terraform'; Name = 'Terraform'  }
    )
    foreach ($p in $pkgs) {
        Write-Info "winget: $($p.Name) [$($p.Id)]"
        & winget install --id $p.Id --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 |
            ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "winget retornou $LASTEXITCODE para $($p.Id) (ja instalado? atualize manualmente)."
        }
    }
} else {
    Write-Warn "winget ausente; usando scoop."
    & scoop install aws terraform 2>&1 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
}

Update-SessionPath
# os links do winget ficam aqui mas nem sempre entram no PATH desta sessao
$wingetLinks = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
if ((Test-Path $wingetLinks) -and ($env:Path -notlike "*$wingetLinks*")) { $env:Path = "$wingetLinks;$env:Path" }

# --- 2. verificacao -------------------------------------------------------
Write-Host ""
Write-Host "======================= VERIFICACAO =======================" -ForegroundColor White
$fail = $false

$aws = Get-Command aws -ErrorAction SilentlyContinue
if ($aws) {
    $awsVersion = (& aws --version 2>&1) -join ' '
    if ($awsVersion -match 'aws-cli/2\.') { Write-Ok "aws       -> $awsVersion" }
    else { Write-Err "aws       -> $awsVersion (esperado aws-cli/2.x)"; $fail = $true }
} else {
    Write-Err "aws nao encontrado no PATH. Feche e reabra o terminal e rode a verificacao de novo."
    $fail = $true
}

$tf = Get-Command terraform -ErrorAction SilentlyContinue
if ($tf) {
    $tfVersion = Get-TerraformVersion
    if (Test-MinVersion -Current $tfVersion -Minimum '1.10') {
        Write-Ok "terraform -> v$tfVersion (>= 1.10: use_lockfile disponivel)"
    } else {
        Write-Err "terraform -> v$tfVersion (< 1.10). O backend S3 do guia usa use_lockfile."
        $fail = $true
    }
} else {
    Write-Err "terraform nao encontrado no PATH. Feche e reabra o terminal e rode a verificacao de novo."
    $fail = $true
}

$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) { Write-Ok "git       -> $(& git --version)" } else { Write-Warn "git ausente" }

Write-Host "=========================================================="
if ($fail) {
    Write-Err "uma ou mais verificacoes falharam."
    Write-Host "       Terminais ja abertos NAO herdam o PATH novo: abra um novo e rode:" -ForegroundColor Yellow
    Write-Host "         aws --version ; terraform version" -ForegroundColor Yellow
    exit 1
}

Write-Ok "toolchain pronta."
Write-Host ""
Write-Host "Proximos passos (docs/03-guia-pre-requisitos.md):" -ForegroundColor White
Write-Host "  §5 -> credenciais da sessao (versao PowerShell em §5.3)"
Write-Host "  §2 -> Start Lab + aws sts get-caller-identity"
Write-Host "  §4 -> chave SSH"
Write-Host "  §6 -> git init + .gitignore"
Write-Host ""
Write-Host "Lembrete: o caminho recomendado do guia e o WSL/Ubuntu. Este script e o atalho nativo." -ForegroundColor DarkGray
