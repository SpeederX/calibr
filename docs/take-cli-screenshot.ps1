param(
  [string]$OutputPath = (Join-Path $PSScriptRoot "cli-all.png")
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

function ColorFromHex([string]$hex) {
  return [System.Drawing.ColorTranslator]::FromHtml($hex)
}

function New-Brush([string]$hex) {
  return [System.Drawing.SolidBrush]::new((ColorFromHex $hex))
}

function New-Pen([string]$hex, [float]$width = 1) {
  return [System.Drawing.Pen]::new((ColorFromHex $hex), $width)
}

function New-RoundRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function Fill-RoundRect($g, $brush, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-RoundRectPath $x $y $w $h $r
  $g.FillPath($brush, $path)
  $path.Dispose()
}

function Stroke-RoundRect($g, $pen, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-RoundRectPath $x $y $w $h $r
  $g.DrawPath($pen, $path)
  $path.Dispose()
}

function Draw-Dot($g, [float]$x, [float]$y, [string]$color) {
  $brush = New-Brush $color
  $g.FillEllipse($brush, $x, $y, 12, 12)
  $brush.Dispose()
}

function Draw-Line($g, [array]$segments, [float]$x, [float]$y, $font, [float]$lineHeight) {
  $format = [System.Drawing.StringFormat]::GenericTypographic.Clone()
  $format.FormatFlags = $format.FormatFlags -bor [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces
  $cursor = $x

  foreach ($segment in $segments) {
    $text = [string]$segment.Text
    $fg = if ($segment.Color) { $segment.Color } else { "#ecf5ff" }
    $brush = New-Brush $fg
    $size = $g.MeasureString($text, $font, 2000, $format)

    if ($segment.Background) {
      $bg = New-Brush $segment.Background
      $rect = [System.Drawing.RectangleF]::new($cursor - 2, $y + 2, $size.Width + 6, $lineHeight - 5)
      $g.FillRectangle($bg, $rect)
      $bg.Dispose()
    }

    $g.DrawString($text, $font, $brush, $cursor, $y, $format)
    $cursor += $size.Width
    $brush.Dispose()
  }

  $format.Dispose()
}

function Segment([string]$text, [string]$color = "#ecf5ff", [string]$background = $null) {
  return [pscustomobject]@{ Text = $text; Color = $color; Background = $background }
}

$width = 1280
$height = 900
$bitmap = [System.Drawing.Bitmap]::new($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

$background = New-Brush "#080e1d"
$panel = New-Brush "#0d1628"
$border = New-Pen "#243852"
$chromeLine = New-Pen "#243852"
$titleBrush = New-Brush "#59d5ff"

$heading = [System.Drawing.Font]::new("Segoe UI", 28, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$mono = [System.Drawing.Font]::new("Consolas", 20, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$monoRight = [System.Drawing.Font]::new("Consolas", 21, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)

$graphics.FillRectangle($background, 0, 0, $width, $height)
$graphics.DrawString("Install once. Pick guided run. Let calibr recommend what fits.", $heading, $titleBrush, 70, 58)

$left = [System.Drawing.RectangleF]::new(70, 111, 468, 775)
$right = [System.Drawing.RectangleF]::new(560, 111, 650, 775)

foreach ($rect in @($left, $right)) {
  Fill-RoundRect $graphics $panel $rect.X $rect.Y $rect.Width $rect.Height 10
  Stroke-RoundRect $graphics $border $rect.X $rect.Y $rect.Width $rect.Height 10
  $graphics.DrawLine($chromeLine, $rect.X, $rect.Y + 43, $rect.X + $rect.Width, $rect.Y + 43)
  Draw-Dot $graphics ($rect.X + 18) ($rect.Y + 16) "#ff615d"
  Draw-Dot $graphics ($rect.X + 38) ($rect.Y + 16) "#ffbd45"
  Draw-Dot $graphics ($rect.X + 58) ($rect.Y + 16) "#2ecc71"
}

$cyan = "#5ee9ff"
$ok = "#2ff0a1"
$muted = "#9fbae8"
$warn = "#ffd21f"
$dim = "#7f9bc9"
$select = "#176f86"

$x = 104
$y = 190
$lh = 31
$lines = @(
  @((Segment "PS> " $cyan), (Segment "npm install -g calibr")),
  @(),
  @((Segment "added calibr" $ok)),
  @(),
  @((Segment "PS> " $cyan), (Segment "calibr")),
  @(),
  @((Segment "calibr - status" $cyan)),
  @(),
  @((Segment "  gpu       "), (Segment "RTX 2070")),
  @((Segment "  memory    "), (Segment "7424 / 8192 MiB")),
  @((Segment "  llama     "), (Segment "*" $warn), (Segment " needs setup")),
  @((Segment "  results   "), (Segment "0 completed")),
  @(),
  @((Segment "what next?" $cyan)),
  @(),
  @((Segment "> "), (Segment "guided run" "#ffffff" $select), (Segment "            benchmark/report")),
  @((Segment "  results               winners")),
  @((Segment "  configure llama path  setup")),
  @((Segment "  help                  doctor")),
  @(),
  @((Segment "enter selects - q exits" $muted))
)

foreach ($line in $lines) {
  if ($line.Count -gt 0) { Draw-Line $graphics $line $x $y $mono $lh }
  $y += $lh
}

$x = 594
$y = 190
$lh = 30
$rightLines = @(
  @((Segment "guided run - configure" $cyan)),
  @(),
  @((Segment "  llama.cpp:       "), (Segment "download latest")),
  @((Segment "  local folder:    "), (Segment "<CURRENT_PATH>")),
  @((Segment "  source:          "), (Segment "catalog downloads")),
  @((Segment "> "), (Segment "scope:           Starter low - 2-4 GB VRAM" "#ffffff" $select)),
  @((Segment "  model:           "), (Segment "all in scope")),
  @((Segment "  runs per config: "), (Segment "default (3 from config)")),
  @((Segment "  auto-cleanup:    "), (Segment "keep top 3 results")),
  @((Segment "  winner rule:     "), (Segment "balanced - avoid VRAM spill")),
  @((Segment "  live metrics:    "), (Segment "full - GPU/RAM/disk strip")),
  @(),
  @((Segment "  > start all")),
  @((Segment "  cancel")),
  @(),
  @((Segment "pre-flight:" $warn), (Segment " disk + llama.cpp + folder checks")),
  @((Segment "then: download -> bench -> keep winners -> report" $dim))
)

foreach ($line in $rightLines) {
  if ($line.Count -gt 0) { Draw-Line $graphics $line $x $y $monoRight $lh }
  $y += $lh
}

$output = [System.IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($output)) | Out-Null
$bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)

$titleBrush.Dispose()
$chromeLine.Dispose()
$border.Dispose()
$panel.Dispose()
$background.Dispose()
$heading.Dispose()
$mono.Dispose()
$monoRight.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Host "Wrote $output"
