# =============================================================================
# collect-skills-sample.ps1 — coleta a amostra do catálogo do skills.sh (F2.0)
#
# Equivalente PowerShell do scripts/probe-skills-sh.sh, para rodar no Windows sem
# WSL. Lê as URLs do sitemap, baixa N páginas de detalhe com 1 req/s (politeness)
# e grava JSON sanitizado + SHA256SUMS em docs/app/amostras/.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File scripts/dev/collect-skills-sample.ps1
#   ... -Count 40 -Out docs/app/amostras
#
# Só faz GET em páginas públicas listadas no sitemap. Não toca em /api/ nem em
# /search (ambos proibidos pelo robots.txt do site).
# =============================================================================
[CmdletBinding()]
param(
    [int]$Count = 25,
    [string]$Out = 'docs/app/amostras',
    [int]$DelayMs = 1000
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$outDir = Join-Path $repoRoot $Out
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Get-Text {
    param([string]$Url, [string]$Path)
    curl.exe -sS -L --max-time 30 -o $Path -w '%{http_code}' $Url
}

# Converte HTML em linhas de texto visivel (sem script/style e sem tags).
function Get-TextLines {
    param([string]$Html)
    $semScript = [regex]::Replace($Html, '(?s)<script.*?</script>', ' ')
    $semStyle = [regex]::Replace($semScript, '(?s)<style.*?</style>', ' ')
    $texto = [regex]::Replace($semStyle, '(?s)<[^>]+>', "`n")
    return ($texto -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

# "4.4M" -> 4400000 ; "39.4K" -> 39400 ; "121" -> 121 ; "1,234" -> 1234
function ConvertFrom-Abreviado {
    param([string]$Raw)
    if (-not $Raw) { return $null }
    $s = $Raw.Trim().Replace(',', '')
    if ($s -match '^([\d\.]+)\s*([KkMmBb])?\+?$') {
        $n = [double]$Matches[1]
        switch ($Matches[2]) {
            'K' { $n = $n * 1000 }
            'k' { $n = $n * 1000 }
            'M' { $n = $n * 1000000 }
            'm' { $n = $n * 1000000 }
            'B' { $n = $n * 1000000000 }
            'b' { $n = $n * 1000000000 }
        }
        return [long]$n
    }
    return $null
}

function Get-ValorApos {
    param([string[]]$Lines, [string]$Label)
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -eq $Label -and ($i + 1) -lt $Lines.Count) {
            return $Lines[$i + 1]
        }
    }
    return $null
}

# --- 1. sitemap ---------------------------------------------------------------
$sitemapIndex = Join-Path $outDir 'sitemap.xml'
if (-not (Test-Path $sitemapIndex)) {
    Get-Text -Url 'https://www.skills.sh/sitemap.xml' -Path $sitemapIndex | Out-Null
}
$skillsSitemap = Join-Path $outDir 'sitemap-skills-1.xml'
if (-not (Test-Path $skillsSitemap)) {
    Get-Text -Url 'https://www.skills.sh/sitemap-skills-1.xml' -Path $skillsSitemap | Out-Null
}

$xml = Get-Content $skillsSitemap -Raw -Encoding UTF8
$urls = [regex]::Matches($xml, '<loc>(.*?)</loc>') | ForEach-Object { $_.Groups[1].Value }
Write-Host "URLs no sitemap: $($urls.Count)"

# Amostra espalhada pelo sitemap (nao so o comeco, que e dominado por uma org).
$step = [Math]::Max(1, [int]($urls.Count / $Count))
$alvos = @()
for ($i = 0; $i -lt $urls.Count -and $alvos.Count -lt $Count; $i += $step) { $alvos += $urls[$i] }
Write-Host "Alvos: $($alvos.Count) (passo $step)"

# --- 2. coleta ----------------------------------------------------------------
$itens = @()
$n = 0
foreach ($url in $alvos) {
    $n++
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("skill-$n.html")
    $code = Get-Text -Url $url -Path $tmp

    if ($code -ne '200') {
        Write-Warning "[$n/$($alvos.Count)] HTTP $code em $url"
        continue
    }

    $html = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8)
    $linhas = Get-TextLines -Html $html

    $titulo = if ($html -match '(?s)<title>(.*?)</title>') { $Matches[1] } else { '' }
    $nome = ($titulo -split '—')[0].Trim()
    $resumo = if ($html -match '(?s)<meta name="description" content="(.*?)"') { $Matches[1] } else { $null }
    if ($resumo) { $resumo = [System.Net.WebUtility]::HtmlDecode($resumo) }

    $installsRaw = Get-ValorApos -Lines $linhas -Label 'Installs'
    $starsRaw = Get-ValorApos -Lines $linhas -Label 'GitHub Stars'
    $repo = Get-ValorApos -Lines $linhas -Label 'Repository'
    $firstSeen = Get-ValorApos -Lines $linhas -Label 'First Seen'

    $itens += [pscustomobject]@{
        source_key      = ($url -replace '^https://www\.skills\.sh/', '')
        name            = $nome
        url             = $url
        repository      = if ($repo -match '^[\w\.\-]+/[\w\.\-]+$') { $repo } else { $null }
        summary         = $resumo
        installs        = ConvertFrom-Abreviado $installsRaw
        installs_raw    = $installsRaw
        stars           = ConvertFrom-Abreviado $starsRaw
        stars_raw       = $starsRaw
        # O site NAO publica contagem de vulnerabilidades: campo fica null, nunca 0
        # (AGENTS.md regra 3). Ver a decisao D3 no README desta pasta.
        vulnerabilities = $null
        first_seen      = $firstSeen
        fetched_at      = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    }
    Write-Host "[$n/$($alvos.Count)] $nome | installs=$installsRaw stars=$starsRaw"
    Remove-Item $tmp -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds $DelayMs
}

# --- 3. saida -----------------------------------------------------------------
$stamp = (Get-Date).ToString('yyyy-MM-dd')
$outFile = Join-Path $outDir "skills-sample-$stamp.json"
$json = $itens | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($outFile, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "`nGravado: $outFile ($($itens.Count) itens)"

$hash = (Get-FileHash $outFile -Algorithm SHA256).Hash.ToLower()
$sums = Join-Path $outDir 'SHA256SUMS'
Add-Content -Path $sums -Value "$hash  $(Split-Path $outFile -Leaf)" -Encoding ASCII
Write-Host "SHA256: $hash"
