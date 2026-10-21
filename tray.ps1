# Ícone do T3 Presence na bandeja do Windows. Aberto pelo presence.mjs, que passa o próprio pid.
# Manda comandos por linhas no stdout (quit, reconnect, config {json}) e lê o estado em
# presence.status.json, que o presence.mjs reescreve a cada ciclo. Fecha sozinho se o pai morrer.
param([int]$ParentPid)

[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$dir = $PSScriptRoot
$statusPath = Join-Path $dir "presence.status.json"
$configPath = Join-Path $dir "config.json"
$logPath = Join-Path $dir "presence.log"
$startupLink = Join-Path ([Environment]::GetFolderPath("Startup")) "t3-presence.vbs"

function Send([string]$line) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

function Send-Config($patch) {
  Send ("config " + (ConvertTo-Json $patch -Compress -Depth 5))
}

function Read-Json($file) {
  try { Get-Content $file -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json } catch { $null }
}

function Open-File($file) {
  try { Invoke-Item $file } catch { Start-Process notepad.exe $file }
}

# Ícone desenhado na hora: bolinha com "T3" na cor do estado.
function New-StateIcon($rgb) {
  $bmp = New-Object Drawing.Bitmap 32, 32
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml($rgb))), 0, 0, 32, 32)
  $font = New-Object Drawing.Font "Segoe UI", 15, ([Drawing.FontStyle]::Bold), ([Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object Drawing.StringFormat
  $fmt.Alignment = [Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [Drawing.StringAlignment]::Center
  $g.DrawString("T3", $font, [Drawing.Brushes]::White, (New-Object Drawing.RectangleF 0, 1, 32, 32), $fmt)
  $g.Dispose()
  [Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$icons = @{
  ok      = New-StateIcon "#3BA55C"  # card no Discord
  parado  = New-StateIcon "#747F8D"  # conectado, mas sem card (ocioso ou T3 fechado)
  erro    = New-StateIcon "#ED4245"  # Discord fora ou o programa não responde
}

$tipos = @{ 0 = "Jogando"; 2 = "Ouvindo"; 3 = "Assistindo"; 5 = "Competindo" }

# ---------- menu ----------

$notify = New-Object Windows.Forms.NotifyIcon
$notify.Icon = $icons.parado
$notify.Text = "T3 Presence"
$menu = New-Object Windows.Forms.ContextMenuStrip

$itemEstado = $menu.Items.Add("Carregando...")
$itemEstado.Enabled = $false
$itemLinha1 = $menu.Items.Add("")
$itemLinha1.Enabled = $false
$itemLinha2 = $menu.Items.Add("")
$itemLinha2.Enabled = $false
[void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))

$itemModo = New-Object Windows.Forms.ToolStripMenuItem "Modo"
[void]$menu.Items.Add($itemModo)
$itemConfig = $menu.Items.Add("Configurações...")
$itemConfig.Font = New-Object Drawing.Font $itemConfig.Font, ([Drawing.FontStyle]::Bold)
$itemReconectar = $menu.Items.Add("Reconectar ao Discord")
$itemArquivo = $menu.Items.Add("Abrir config.json")
$itemLog = $menu.Items.Add("Abrir log")
[void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$itemSair = $menu.Items.Add("Sair")
$notify.ContextMenuStrip = $menu

function Update-Status {
  $s = Read-Json $statusPath
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $limite = 3 * [Math]::Max(5, [double]$s.intervalo) * 1000 + 10000
  $linha1 = ""
  $linha2 = ""
  if (-not $s -or ($now - $s.at) -gt $limite) {
    $icon = "erro"; $estado = "O programa não está respondendo"
  } elseif (-not $s.discord) {
    $icon = "erro"; $estado = "Discord não conectado"
  } elseif (-not $s.t3) {
    $icon = "parado"; $estado = "T3 Code fechado, card limpo"
  } elseif (-not $s.card) {
    $icon = "parado"; $estado = "Ocioso, card escondido"
  } else {
    $icon = "ok"
    $tipo = $tipos[[int]$s.card.tipo]
    $estado = "No Discord" + $(if ($s.app) { " como $($s.app)" } else { "" }) + $(if ($tipo) { " ($tipo)" } else { "" })
    $linha1 = $s.card.linha1
    $linha2 = $s.card.linha2
  }
  if ($s.erro -and $icon -ne "ok") { $linha1 = $s.erro }

  $itemEstado.Text = $estado
  $itemLinha1.Text = $linha1
  $itemLinha1.Visible = [bool]$linha1
  $itemLinha2.Text = $linha2
  $itemLinha2.Visible = [bool]$linha2
  $notify.Icon = $icons[$icon]
  $tip = "T3 Presence: " + $(if ($linha1) { "$linha1 · $linha2".Trim(" ·") } else { $estado })
  # NotifyIcon.Text estoura acima de 63 caracteres.
  if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 62) + "…" }
  $notify.Text = $tip
}

$menu.add_Opening({
  Update-Status
  $cfg = Read-Json $configPath
  $itemModo.DropDownItems.Clear()
  if ($cfg -and $cfg.modos) {
    foreach ($nome in $cfg.modos.PSObject.Properties.Name) {
      $item = New-Object Windows.Forms.ToolStripMenuItem $nome
      $item.Tag = $nome
      $item.Checked = ($nome -eq $cfg.modoAtivo)
      $item.add_Click({ Send-Config @{ modoAtivo = $this.Tag } })
      [void]$itemModo.DropDownItems.Add($item)
    }
  }
})

$itemReconectar.add_Click({ Send "reconnect" })
$itemArquivo.add_Click({ Open-File $configPath })
$itemLog.add_Click({ Open-File $logPath })
$itemConfig.add_Click({ Show-Settings })
$notify.add_MouseDoubleClick({ Show-Settings })
$itemSair.add_Click({
  Send "quit"
  $notify.Visible = $false
  [Windows.Forms.Application]::Exit()
})

# ---------- janela de configurações ----------

$script:form = $null

function Show-Settings {
  if ($script:form -and -not $script:form.IsDisposed) {
    $script:form.Activate()
    return
  }
  $cfg = Read-Json $configPath
  if (-not $cfg) {
    [void][Windows.Forms.MessageBox]::Show("config.json não abriu (JSON inválido?). Corrija o arquivo.", "T3 Presence")
    Open-File $configPath
    return
  }

  $f = New-Object Windows.Forms.Form
  $f.Text = "T3 Presence: configurações"
  $f.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedDialog
  $f.MaximizeBox = $false
  $f.MinimizeBox = $false
  $f.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
  $f.Font = New-Object Drawing.Font "Segoe UI", 9
  $f.AutoScaleMode = [Windows.Forms.AutoScaleMode]::Font
  $f.ClientSize = New-Object Drawing.Size 400, 470
  $f.Icon = $icons.ok
  $script:form = $f

  $y = 14
  function Add-Label($text, $top) {
    $l = New-Object Windows.Forms.Label
    $l.Text = $text
    $l.AutoSize = $true
    $l.Location = New-Object Drawing.Point 16, ($top + 3)
    $f.Controls.Add($l)
  }
  function Add-Combo($items, $value, $top) {
    $c = New-Object Windows.Forms.ComboBox
    $c.DropDownStyle = [Windows.Forms.ComboBoxStyle]::DropDownList
    $c.Location = New-Object Drawing.Point 200, $top
    $c.Width = 184
    foreach ($i in $items) { [void]$c.Items.Add($i) }
    if ($c.Items.Contains($value)) { $c.SelectedItem = $value } elseif ($c.Items.Count) { $c.SelectedIndex = 0 }
    $f.Controls.Add($c)
    $c
  }
  function Add-Number($value, $min, $max, $top) {
    $n = New-Object Windows.Forms.NumericUpDown
    $n.Minimum = $min
    $n.Maximum = $max
    $n.Value = [Math]::Min($max, [Math]::Max($min, [decimal]$value))
    $n.Location = New-Object Drawing.Point 200, $top
    $n.Width = 80
    $f.Controls.Add($n)
    $n
  }

  Add-Label "Modo do card" $y
  $modo = Add-Combo @($cfg.modos.PSObject.Properties.Name) $cfg.modoAtivo $y
  $y += 28
  $preview = New-Object Windows.Forms.Label
  $preview.Location = New-Object Drawing.Point 16, $y
  $preview.Size = New-Object Drawing.Size 368, 34
  $preview.ForeColor = [Drawing.SystemColors]::GrayText
  $f.Controls.Add($preview)
  $showPreview = {
    $m = $cfg.modos.($modo.SelectedItem)
    $preview.Text = "Linha 1: $($m.linha1)`nLinha 2: $($m.linha2)"
  }.GetNewClosure()
  $modo.add_SelectedIndexChanged($showPreview)
  & $showPreview
  $y += 40

  $grupo = New-Object Windows.Forms.GroupBox
  $grupo.Text = "Mostrar no card (desligado some em qualquer modo)"
  $grupo.Location = New-Object Drawing.Point 16, $y
  $grupo.Size = New-Object Drawing.Size 368, 104
  $f.Controls.Add($grupo)
  # Padrões iguais aos do presence.mjs: projeto, atividade e timer ligados; o resto desligado.
  $campos = @(
    @("projeto", "Projeto", $true), @("atividade", "Atividade", $true), @("timer", "Timer", $true),
    @("thread", "Título da conversa", $false), @("modelo", "Modelo", $false), @("agentes", "Nº de tarefas", $false)
  )
  $checks = @{}
  for ($i = 0; $i -lt $campos.Count; $i++) {
    $k, $texto, $padrao = $campos[$i]
    $v = $cfg.mostrar.$k
    $c = New-Object Windows.Forms.CheckBox
    $c.Text = $texto
    $c.AutoSize = $true
    $c.Checked = $(if ($null -eq $v) { $padrao } else { [bool]$v })
    $c.Location = New-Object Drawing.Point (12 + 180 * [Math]::Floor($i / 3)), (22 + 26 * ($i % 3))
    $grupo.Controls.Add($c)
    $checks[$k] = $c
  }
  $y += 116

  Add-Label "Tipo de atividade" $y
  $tipo = Add-Combo @("auto", "jogando", "assistindo", "ouvindo", "competindo") $cfg.tipo $y
  $y += 30
  Add-Label "Quando ocioso" $y
  $ocioso = Add-Combo @("esconder", "mostrar") $cfg.quandoOcioso $y
  $y += 30
  Add-Label "Minutos até ficar ocioso" $y
  $minutos = Add-Number $(if ($null -ne $cfg.ociosoMinutos) { $cfg.ociosoMinutos } else { 15 }) 1 240 $y
  $y += 30
  Add-Label "Atualizar a cada (segundos)" $y
  $intervalo = Add-Number $(if ($null -ne $cfg.intervaloSegundos) { $cfg.intervaloSegundos } else { 5 }) 3 3600 $y
  $y += 34

  $seguir = New-Object Windows.Forms.CheckBox
  $seguir.Text = "Seguir a conversa da última mensagem"
  $seguir.AutoSize = $true
  $seguir.Checked = ($cfg.seguirUltimaMensagem -ne $false)
  $seguir.Location = New-Object Drawing.Point 16, $y
  $f.Controls.Add($seguir)
  $y += 26
  $iniciar = New-Object Windows.Forms.CheckBox
  $iniciar.Text = "Iniciar com o Windows"
  $iniciar.AutoSize = $true
  $iniciar.Checked = (Test-Path $startupLink)
  $iniciar.Location = New-Object Drawing.Point 16, $y
  $f.Controls.Add($iniciar)
  $y += 30

  $dica = New-Object Windows.Forms.Label
  $dica.Text = "Textos dos modos, nomes de projetos e imagens ficam no config.json."
  $dica.AutoSize = $true
  $dica.ForeColor = [Drawing.SystemColors]::GrayText
  $dica.Location = New-Object Drawing.Point 16, $y
  $f.Controls.Add($dica)

  $btnArquivo = New-Object Windows.Forms.Button
  $btnArquivo.Text = "Abrir config.json"
  $btnArquivo.AutoSize = $true
  $btnArquivo.Location = New-Object Drawing.Point 16, 430
  $btnArquivo.add_Click({ Open-File $configPath })
  $f.Controls.Add($btnArquivo)

  $btnSalvar = New-Object Windows.Forms.Button
  $btnSalvar.Text = "Salvar"
  $btnSalvar.Location = New-Object Drawing.Point 228, 430
  $btnSalvar.DialogResult = [Windows.Forms.DialogResult]::OK
  $f.Controls.Add($btnSalvar)
  $f.AcceptButton = $btnSalvar

  $btnCancelar = New-Object Windows.Forms.Button
  $btnCancelar.Text = "Cancelar"
  $btnCancelar.Location = New-Object Drawing.Point 309, 430
  $btnCancelar.DialogResult = [Windows.Forms.DialogResult]::Cancel
  $f.Controls.Add($btnCancelar)
  $f.CancelButton = $btnCancelar

  if ($f.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) {
    $mostrar = @{}
    foreach ($k in $checks.Keys) { $mostrar[$k] = $checks[$k].Checked }
    Send-Config @{
      modoAtivo            = [string]$modo.SelectedItem
      mostrar              = $mostrar
      tipo                 = [string]$tipo.SelectedItem
      quandoOcioso         = [string]$ocioso.SelectedItem
      ociosoMinutos        = [int]$minutos.Value
      intervaloSegundos    = [int]$intervalo.Value
      seguirUltimaMensagem = $seguir.Checked
    }
    try {
      if ($iniciar.Checked -and -not (Test-Path $startupLink)) {
        Copy-Item (Join-Path $dir "start-hidden.vbs") $startupLink
      } elseif (-not $iniciar.Checked -and (Test-Path $startupLink)) {
        Remove-Item $startupLink
      }
    } catch {
      [Console]::Error.WriteLine("Iniciar com o Windows falhou: $_")
    }
  }
  $f.Dispose()
  $script:form = $null
}

# ---------- laço ----------

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    $notify.Visible = $false
    [Windows.Forms.Application]::Exit()
    return
  }
  Update-Status
})

try {
  Update-Status
  $notify.Visible = $true
  $timer.Start()
  [Windows.Forms.Application]::Run()
} finally {
  $timer.Stop()
  $notify.Visible = $false
  $notify.Dispose()
}
