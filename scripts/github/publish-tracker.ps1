<#
.SYNOPSIS
    Publica o tracker do projeto (milestones, labels, issues e PR) a partir de um
    JSON declarativo, de forma idempotente.

.DESCRIPTION
    Foi feito para ser revisado antes de executar. Por isso:

    - O padrao e `-DryRun`: imprime exatamente o que faria, sem chamar a API.
    - `-Apply` e obrigatorio para escrever qualquer coisa.
    - Nada e apagado, nada e forcado, nada e mesclado: so cria o que falta e
      atualiza o que existe por titulo. `gh pr merge`, `--force`, `DELETE` e
      `gh label delete` nao existem neste script.
    - O conteudo (titulos, corpos, cores) vem do JSON, nunca de interpolacao de
      shell: nao ha superficie para injecao de comando.
    - Autenticacao e a sessao do proprio `gh` (keyring). O script nao le, nao
      grava e nao imprime token.

    Referencias cruzadas: o corpo de uma issue pode conter `{{issue:TITULO}}`.
    Na primeira passada isso e impresso como `(pendente)`; depois que todas as
    issues existem, uma segunda passada substitui pelo numero real.

.PARAMETER Apply
    Executa de verdade. Sem este switch, apenas simula.

.PARAMETER Repo
    owner/name. Padrao: o remote `origin` do diretorio atual.

.PARAMETER File
    Caminho do JSON. Padrao: scripts/github/tracker.json ao lado deste script.

.EXAMPLE
    pwsh -File scripts/github/publish-tracker.ps1
    pwsh -File scripts/github/publish-tracker.ps1 -Apply
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$ValidateOnly,
    [string]$Repo,
    [string]$File
)

$ErrorActionPreference = 'Stop'
$script:Mode = if ($Apply) { 'APPLY' } else { 'DRY-RUN' }
$script:Created = 0
$script:Updated = 0
$script:Skipped = 0

function Write-Step { param($m) Write-Host "  $m" }
function Write-Head { param($m) Write-Host "`n== $m ==" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "  OK    $m" -ForegroundColor Green }
function Write-New  { param($m) Write-Host "  CRIAR $m" -ForegroundColor Yellow }
function Write-Same { param($m) Write-Host "  existe $m" -ForegroundColor DarkGray }

# --- descoberta do repositorio ------------------------------------------------
if (-not $Repo) {
    $remote = (& git remote get-url origin 2>$null)
    if (-not $remote) { throw "Sem -Repo e sem remote 'origin' no diretorio atual." }
    $Repo = ($remote -replace '^https://github\.com/', '' -replace '\.git$', '')
}
if ($Repo -notmatch '^[^/]+/[^/]+$') { throw "Repositorio invalido: $Repo" }

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# O corpo de uma issue pode vir de um arquivo markdown, delimitado por
# `<!--ISSUE:TITULO EXATO-->`. Isso evita escapar dezenas de linhas em JSON e
# deixa o corpo revisavel como texto normal.
function Get-IssueBody {
    param($Issue)

    if (-not $Issue.bodyFile) { return [string]$Issue.body }

    $path = Join-Path $root $Issue.bodyFile
    if (-not (Test-Path $path)) { throw "bodyFile nao encontrado: $($Issue.bodyFile)" }

    $text = Get-Content $path -Raw -Encoding utf8
    $marker = "<!--ISSUE:$($Issue.title)-->"
    $start = $text.IndexOf($marker)
    if ($start -lt 0) { throw "marcador ausente em $($Issue.bodyFile): $marker" }

    $rest = $text.Substring($start + $marker.Length)
    $next = $rest.IndexOf('<!--ISSUE:')
    if ($next -ge 0) { $rest = $rest.Substring(0, $next) }
    return $rest.Trim()
}

if (-not $File) { $File = Join-Path $PSScriptRoot 'tracker.json' }
if (-not (Test-Path $File)) { throw "JSON nao encontrado: $File" }

if ($Apply) {
    # `gh` da precedencia a GH_TOKEN/GITHUB_TOKEN sobre o keyring: um token no
    # ambiente trocaria a identidade (e o escopo) das escritas sem aparecer.
    foreach ($v in 'GH_TOKEN', 'GITHUB_TOKEN') {
        if ([Environment]::GetEnvironmentVariable($v)) {
            throw "$v esta definido no ambiente: remova antes de publicar para usar a sessao do keyring"
        }
    }
}

$spec = Get-Content $File -Raw -Encoding utf8 | ConvertFrom-Json

# --- validacao em ambiente isolado --------------------------------------------
# Roda sem rede e sem escrita: confere a consistencia interna da especificacao
# antes de qualquer chamada a API. E o passo que o `security` revisa.
$script:Problems = New-Object 'System.Collections.Generic.List[string]'

$labelNames = @{}
foreach ($l in $spec.labels) {
    if ($labelNames.ContainsKey($l.name)) { $script:Problems.Add("label duplicada: $($l.name)") }
    $labelNames[$l.name] = $true
    if ($l.color -notmatch '^[0-9a-fA-F]{6}$') { $script:Problems.Add("label $($l.name): cor deve ser hex de 6 digitos, veio '$($l.color)'") }
    if (-not $l.description) { $script:Problems.Add("label $($l.name): sem descricao") }
}

$msNames = @{}
foreach ($m in $spec.milestones) {
    if ($msNames.ContainsKey($m.title)) { $script:Problems.Add("milestone duplicada: $($m.title)") }
    $msNames[$m.title] = $true
    if (-not $m.description) { $script:Problems.Add("milestone $($m.title): sem descricao") }
}

$titles = @{}
foreach ($i in $spec.issues) {
    if ($titles.ContainsKey($i.title)) { $script:Problems.Add("issue duplicada: $($i.title)") }
    $titles[$i.title] = $true
  if ($i.title.Length -gt 76) { $script:Problems.Add("titulo com $($i.title.Length) chars (>76): $($i.title)") }
    if ($i.milestone -and -not $msNames.ContainsKey($i.milestone)) {
        $script:Problems.Add("issue '$($i.title)' aponta para milestone inexistente: $($i.milestone)")
    }
    if (-not $i.milestone) { $script:Problems.Add("issue sem milestone: $($i.title)") }
    foreach ($lb in $i.labels) {
        if (-not $labelNames.ContainsKey($lb)) { $script:Problems.Add("issue '$($i.title)' usa label inexistente: $lb") }
    }
    if (-not $i.labels -or @($i.labels).Count -eq 0) { $script:Problems.Add("issue sem label: $($i.title)") }
    if ($i.state -and $i.state -notin @('open', 'closed')) { $script:Problems.Add("issue '$($i.title)': state invalido '$($i.state)'") }
    if ($i.state -eq 'closed' -and -not $i.closing_comment) { $script:Problems.Add("issue fechada sem comentario de evidencia: $($i.title)") }
    if (-not $i.body -and -not $i.bodyFile) { $script:Problems.Add("issue '$($i.title)': sem body nem bodyFile") }
    if ($i.body -and $i.body.Length -lt 80) { $script:Problems.Add("issue '$($i.title)': corpo curto demais") }
    if ($i.title -match '^@') { $script:Problems.Add("issue '$($i.title)': titulo comecando com @ (gh leria arquivo local)") }
    if ($i.bodyFile) {
        $resolved = [System.IO.Path]::GetFullPath((Join-Path $root $i.bodyFile))
        $allowed = [System.IO.Path]::GetFullPath((Join-Path $root 'scripts/github'))
        if (-not $resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) {
            $script:Problems.Add("issue '$($i.title)': bodyFile fora de scripts/github: $($i.bodyFile)")
        }
        if (-not (Test-Path $resolved)) { $script:Problems.Add("issue '$($i.title)': bodyFile nao existe: $($i.bodyFile)") }
    }
}
foreach ($m in $spec.milestones) {
    if ($m.title -match '^@' -or $m.description -match '^@') {
        $script:Problems.Add("milestone '$($m.title)': valor comecando com @ (gh leria arquivo local)")
    }
}
foreach ($i in $spec.issues) {
    $bodyText = ''
    try { $bodyText = Get-IssueBody -Issue $i } catch { $script:Problems.Add("issue '$($i.title)': $($_.Exception.Message)"); continue }
    if ($bodyText.Length -lt 200) { $script:Problems.Add("issue '$($i.title)': corpo com $($bodyText.Length) chars (<200) - revisar") }
    foreach ($m in [regex]::Matches($bodyText, '\{\{issue:([^}]+)\}\}')) {
        $t = $m.Groups[1].Value.Trim()
        if (-not $titles.ContainsKey($t)) { $script:Problems.Add("ref crua em '$($i.title)' aponta para issue inexistente: $t") }
    }
}
if ($spec.pullRequest) {
    $pr = $spec.pullRequest
    if (-not $pr.head -or -not $pr.base) { $script:Problems.Add('pullRequest: head e base sao obrigatorios') }
    if ($pr.head -eq $pr.base) { $script:Problems.Add('pullRequest: head igual a base') }
    if ($pr.bodyFile -and -not (Test-Path (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) $pr.bodyFile))) {
        $script:Problems.Add("pullRequest.bodyFile nao existe: $($pr.bodyFile)")
    }
}

Write-Head 'validacao isolada (sem rede, sem escrita)'
Write-Host ("  labels={0} milestones={1} issues={2} fechadas={3} pr={4}" -f `
    @($spec.labels).Count, @($spec.milestones).Count, @($spec.issues).Count, `
    (@($spec.issues | Where-Object { $_.state -eq 'closed' }).Count), ($(if ($spec.pullRequest) { 'sim' } else { 'nao' })))

if ($script:Problems.Count -gt 0) {
    Write-Host "`n  PROBLEMAS ($($script:Problems.Count)):" -ForegroundColor Red
    foreach ($p in $script:Problems) { Write-Host "   - $p" -ForegroundColor Red }
    if ($ValidateOnly) { exit 1 }
    Write-Host "`n  abortado: corrija os problemas antes de publicar." -ForegroundColor Red
    exit 1
}
Write-Ok 'especificacao consistente'
if ($ValidateOnly) { exit 0 }


Write-Host "repositorio : $Repo"
Write-Host "arquivo     : $File"
Write-Host "modo        : $script:Mode"
if (-not $Apply) { Write-Host "              (nada sera escrito; use -Apply para publicar)" -ForegroundColor DarkGray }

# --- wrapper do gh -------------------------------------------------------------
# Com -Json sai um array "de verdade", inclusive vazio, via `-NoEnumerate`: o
# pipeline desenrola array vazio em $null, o que tornava "tracker vazio" ([])
# indistinguivel de "leitura falhou". O chamador atribui DIRETO
# (`$x = Invoke-Gh ... -Json`); envolver em @(...) aninha o array num elemento so.
function Invoke-Gh {
    param([string[]]$Arguments, [switch]$Json)

    if (-not $Apply) {
        Write-Step "gh $($Arguments -join ' ')"
        return $null
    }
    # gh escreve mensagens de SUCESSO no stderr ("âœ“ Closed issue ..."). Com
    # $ErrorActionPreference = 'Stop' cada linha de stderr virava excecao e o
    # script abortava no meio. Aqui o stderr volta a ser texto; quem decide
    # sucesso/fracasso e o exit code.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & gh @Arguments 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($out) { $out = @($out | ForEach-Object { [string]$_ }) }
    if ($code -ne 0) {
        throw "gh $($Arguments -join ' ') falhou (exit $code): $out"
    }
    if ($Json) {
        if (-not $out) { throw "gh $($Arguments -join ' ') saiu 0 sem saida: tratado como falha de leitura" }
        if ($out -is [array]) { $out = $out -join "`n" }
        Write-Output -NoEnumerate (ConvertFrom-Json $out)
        return
    }
    return $out
}

# --- leitura do estado remoto --------------------------------------------------
$existingLabels = @{}
$existingMilestones = @{}
$existingIssues = @{}

if ($Apply) {
    Write-Head 'lendo estado remoto'
    # Fail-closed: se a leitura falhar, a excecao sobe e NADA e escrito. Antes,
    # uma falha de leitura virava mapa vazio e o script recriava tudo ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â e a API
    # aceita titulo duplicado, entao o resultado seria issue duplicada e fechada
    # com comentario de evidencia (registro falso e permanente).
    $labels = Invoke-Gh -Arguments @('label', 'list', '--repo', $Repo, '--limit', '200', '--json', 'name') -Json
    foreach ($l in $labels) { $existingLabels[$l.name] = $true }

    $ms = Invoke-Gh -Arguments @('api', "repos/$Repo/milestones?state=all&per_page=100") -Json
    foreach ($m in $ms) { $existingMilestones[$m.title] = $m.number }

    $iss = Invoke-Gh -Arguments @('issue', 'list', '--repo', $Repo, '--state', 'all', '--limit', '300', '--json', 'number,title,state') -Json
    foreach ($i in $iss) { $existingIssues[$i.title] = $i }

    Write-Ok ("labels={0} milestones={1} issues={2}" -f $existingLabels.Count, $existingMilestones.Count, $existingIssues.Count)
}

# --- labels --------------------------------------------------------------------
Write-Head "labels ($(@($spec.labels).Count))"
foreach ($label in $spec.labels) {
    if ($existingLabels.ContainsKey($label.name)) { Write-Same $label.name; $script:Skipped++; continue }
    Write-New ("{0}  #{1}" -f $label.name, $label.color)
    Invoke-Gh -Arguments @('label', 'create', $label.name, '--repo', $Repo, '--color', $label.color, '--description', $label.description) | Out-Null
    $script:Created++
}

# --- milestones ----------------------------------------------------------------
Write-Head "milestones ($(@($spec.milestones).Count))"
foreach ($ms in $spec.milestones) {
    if ($existingMilestones.ContainsKey($ms.title)) { Write-Same $ms.title; $script:Skipped++; continue }
    Write-New $ms.title
    if ($Apply) {
        $newMilestone = Invoke-Gh -Arguments @('api', "repos/$Repo/milestones", '--method', 'POST', '-f', "title=$($ms.title)", '-f', "description=$($ms.description)", '-f', 'state=open') -Json
        $existingMilestones[$ms.title] = $newMilestone.number
    }
    $script:Created++
}

# Escreve texto num arquivo temporario sem BOM (Set-Content -Encoding UTF8 no
# PowerShell 5.1 grava BOM, e o BOM ia junto no corpo publicado).
function Write-TempBody {
    param([string]$Text)
    $p = Join-Path ([System.IO.Path]::GetTempPath()) ('gh-body-' + [guid]::NewGuid().ToString('N') + '.md')
    [System.IO.File]::WriteAllText($p, $Text, (New-Object System.Text.UTF8Encoding($false)))
    return $p
}

# --- issues --------------------------------------------------------------------
function Resolve-Refs {
    param([string]$Body, [hashtable]$Map)
    $missing = @()
    $resolved = [regex]::Replace($Body, '\{\{issue:([^}]+)\}\}', {
        param($m)
        $t = $m.Groups[1].Value.Trim()
        if ($Map.ContainsKey($t)) { return "#$($Map[$t])" }
        $script:MissingRefs.Add($t) | Out-Null
        return '(pendente)'
    })
    return $resolved
}

$script:MissingRefs = New-Object 'System.Collections.Generic.List[string]'
$issueNumbers = @{}

Write-Head "issues ($(@($spec.issues).Count))"
foreach ($issue in $spec.issues) {
    $state = if ($issue.state) { $issue.state } else { 'open' }

    if ($existingIssues.ContainsKey($issue.title)) {
        $cur = $existingIssues[$issue.title]
        $issueNumbers[$issue.title] = $cur.number
        Write-Same ("#{0} {1} [{2}]" -f $cur.number, $issue.title, $cur.state)
        $script:Skipped++
        continue
    }

    $msNum = $null
    if ($issue.milestone) { $msNum = $existingMilestones[$issue.milestone] }

    $msLabel = if ($issue.milestone) { $issue.milestone } else { '-' }
    Write-New ("[{0}] {1}  ms={2} labels={3}" -f $state, $issue.title, $msLabel, (($issue.labels) -join ','))
    if ($Apply) {
        # `--body-file` e nao `--body`: o PowerShell 5.1 quebra argumento nativo que
        # contem espaco + aspas embutidas ("como X quero Y para Z"), e o corpo tem
        # as duas coisas. Arquivo elimina o problema de quoting por completo.
        $bodyPath = Write-TempBody (Resolve-Refs -Body (Get-IssueBody -Issue $issue) -Map $issueNumbers)
        $args = @('issue', 'create', '--repo', $Repo, '--title', $issue.title, '--body-file', $bodyPath)
        if ($msNum) { $args += @('--milestone', $issue.milestone) }
        foreach ($lb in $issue.labels) { $args += @('--label', $lb) }
        try {
            $url = (Invoke-Gh -Arguments $args) | Select-Object -Last 1
        } finally {
            Remove-Item $bodyPath -ErrorAction SilentlyContinue
        }
        $num = [int]([regex]::Match([string]$url, '/(\d+)$').Groups[1].Value)
        $issueNumbers[$issue.title] = $num

        if ($state -eq 'closed') {
            if ($issue.closing_comment) {
                $commentPath = Write-TempBody $issue.closing_comment
                try {
                    Invoke-Gh -Arguments @('issue', 'comment', [string]$num, '--repo', $Repo, '--body-file', $commentPath) | Out-Null
                } finally {
                    Remove-Item $commentPath -ErrorAction SilentlyContinue
                }
            }
            Invoke-Gh -Arguments @('issue', 'close', [string]$num, '--repo', $Repo, '--reason', 'completed') | Out-Null
            Write-Step "  fechada #$num (motivo: completed)"
        }
    }
    $script:Created++
}

# --- segunda passada: referencias cruzadas -------------------------------------
if ($Apply -and $script:MissingRefs.Count -gt 0) {
    Write-Head 'segunda passada: referencias cruzadas'
    foreach ($issue in $spec.issues) {
        $num = $issueNumbers[$issue.title]
        if (-not $num) { continue }
        $resolved = Resolve-Refs -Body (Get-IssueBody -Issue $issue) -Map $issueNumbers
        if ($resolved -ne (Get-IssueBody -Issue $issue) -and $resolved -notmatch '\(pendente\)') {
            Write-Step "atualizando corpo de #$num"
            $editPath = Write-TempBody $resolved
            try { Invoke-Gh -Arguments @('issue', 'edit', [string]$num, '--repo', $Repo, '--body-file', $editPath) | Out-Null } finally { Remove-Item $editPath -ErrorAction SilentlyContinue }
            $script:Updated++
        }
    }
}

# --- pull request --------------------------------------------------------------
if ($spec.pullRequest) {
    $pr = $spec.pullRequest
    Write-Head 'pull request'
    $existing = Invoke-Gh -Arguments @('pr', 'list', '--repo', $Repo, '--head', $pr.head, '--state', 'all', '--json', 'number,title') -Json
    if ($existing -and @($existing).Count -gt 0) {
        Write-Same ("PR existente: #{0}" -f @($existing)[0].number)
        $script:Skipped++
    }
    else {
        Write-New ("{0} -> {1}: {2}" -f $pr.head, $pr.base, $pr.title)
        $args = @('pr', 'create', '--repo', $Repo, '--base', $pr.base, '--head', $pr.head, '--title', $pr.title)
        if ($pr.bodyFile -and (Test-Path (Join-Path $root $pr.bodyFile))) {
            $args += @('--body-file', (Join-Path $root $pr.bodyFile))
        } elseif ($pr.body) {
            $args += @('--body', $pr.body)
        }
        if ($pr.draft) { $args += '--draft' }
        $url = Invoke-Gh -Arguments $args | Select-Object -Last 1
        Write-Step "  criado: $url"
        $script:Created++
    }
}

# --- resumo --------------------------------------------------------------------
Write-Host "`n == resumo ($script:Mode) ==" -ForegroundColor Cyan
Write-Host ("  criaria/criou : {0}" -f $script:Created)
Write-Host ("  atualizaria   : {0}" -f $script:Updated)
Write-Host ("  ja existia    : {0}" -f $script:Skipped)
if ($script:MissingRefs.Count -gt 0 -and -not $Apply) {
    Write-Host ("  refs pendentes: {0}" -f (($script:MissingRefs | Sort-Object -Unique) -join ', ')) -ForegroundColor DarkGray
}
if (-not $Apply) { Write-Host "`n  nada foi escrito. Rode com -Apply depois da revisao." -ForegroundColor Yellow }
